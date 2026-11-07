import { genId } from '@/lib/id'
import { loadChatrooms, saveChatrooms } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { streamAgentChat } from '@/lib/server/chat-execution/stream-agent-chat'
import { getProvider } from '@/lib/providers'
import { NON_LANGGRAPH_PROVIDER_IDS } from '@/lib/provider-sets'
import {
  resolveApiKey,
  parseMentions,
  resolveAgentApiEndpoint,
  compactChatroomMessages,
  buildChatroomSystemPrompt,
  ensureSyntheticSession,
  appendSyntheticSessionMessage,
  buildAgentSystemPromptForChatroom,
  buildHistoryForAgent,
  isMuted,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'
import { markProviderFailure, markProviderSuccess } from '@/lib/server/provider-health'
import { applyAgentReactionsFromText, stripAgentReactionTokens } from '@/lib/server/chatrooms/chatroom-agent-signals'
import { resolvePrimaryAgentRoute } from '@/lib/server/agents/agent-runtime-config'
import { shouldSuppressHiddenControlText, stripHiddenControlTokens } from '@/lib/server/agents/assistant-control'
import { persistChatroomInteractionMemory } from '@/lib/server/chatrooms/chatroom-memory-bridge'
import type { Chatroom, ChatroomMessage, Agent } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const MAX_CHATROOM_CHAIN_DEPTH = 5

export interface ChatroomAgentTurnContext {
  chatroomId: string
  agents: Record<string, Agent>
  chatroomName: string
  /** Name shown as the message sender for memory persistence (usually 'You'). */
  senderName: string
  /** The user's original text (used for memory + chained-agent context). */
  originalText: string
  replyContext: string
  imagePath?: string
  attachedFiles?: string[]
  /** Agents already run in this chain — prevents re-runs and @mention loops. */
  processed: Set<string>
  writeEvent: (event: Record<string, unknown>) => void
}

export interface ChatroomAgentTurnItem {
  agentId: string
  depth: number
  /** Message sent to this agent. Defaults to replyContext + originalText. */
  contextMessage?: string
}

/**
 * Run one agent's turn in a chatroom: stream its reply, persist the message,
 * and return the agent IDs it @mentioned (for chaining). Shared by the normal
 * chat route and the self-discussion endpoint so both behave identically.
 */
export async function runChatroomAgentTurn(
  ctx: ChatroomAgentTurnContext,
  item: ChatroomAgentTurnItem,
): Promise<string[]> {
  const { chatroomId: id, agents, writeEvent, processed } = ctx
  if (processed.has(item.agentId) || item.depth >= MAX_CHATROOM_CHAIN_DEPTH) return []
  processed.add(item.agentId)

  const agent = agents[item.agentId]
  if (!agent) return []

  // Skip muted agents
  const freshForMuteCheck = loadChatrooms()[id] as Chatroom | undefined
  if (freshForMuteCheck && isMuted(freshForMuteCheck, item.agentId)) {
    writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'err', text: `${agent.name} is muted`, agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
    return []
  }

  // Pre-flight: check if the agent's provider is usable before attempting to stream
  const route = resolvePrimaryAgentRoute(agent)
  const providerInfo = getProvider(route?.provider || agent.provider)
  const apiKey = resolveApiKey(route?.credentialId || agent.credentialId)
  const resolvedEndpoint = route?.apiEndpoint || resolveAgentApiEndpoint(agent)
  if (providerInfo?.requiresApiKey && !apiKey) {
    writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'err', text: `${agent.name} has no API credentials configured`, agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
    return []
  }
  if (providerInfo?.requiresEndpoint && !resolvedEndpoint) {
    writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'err', text: `${agent.name} has no endpoint configured`, agentId: agent.id, agentName: agent.name })
    writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
    return []
  }

  writeEvent({ t: 'cr_agent_start', agentId: agent.id, agentName: agent.name })

  try {
    const freshChatrooms = loadChatrooms()
    const freshChatroom = freshChatrooms[id] as Chatroom
    if (compactChatroomMessages(freshChatroom)) {
      freshChatrooms[id] = freshChatroom
      saveChatrooms(freshChatrooms)
      notify(`chatroom:${id}`)
    }

    const syntheticSession = ensureSyntheticSession(agent, id)
    syntheticSession.provider = route?.provider || syntheticSession.provider
    syntheticSession.model = route?.model || syntheticSession.model
    syntheticSession.credentialId = route?.credentialId ?? syntheticSession.credentialId ?? null
    syntheticSession.fallbackCredentialIds = route?.fallbackCredentialIds || syntheticSession.fallbackCredentialIds || []
    syntheticSession.gatewayProfileId = route?.gatewayProfileId ?? syntheticSession.gatewayProfileId ?? null
    syntheticSession.apiEndpoint = resolvedEndpoint
    const agentSystemPrompt = buildAgentSystemPromptForChatroom(agent, syntheticSession.cwd)
    const chatroomContext = buildChatroomSystemPrompt(freshChatroom, agents, agent.id)
    const fullSystemPrompt = [agentSystemPrompt, chatroomContext].filter(Boolean).join('\n\n')
    const history = buildHistoryForAgent(freshChatroom, agent.id, ctx.imagePath, ctx.attachedFiles)

    // Use enriched context message for chained/discussion agents, or reply context + original text
    const messageForAgent = item.contextMessage || (ctx.replyContext + ctx.originalText)
    appendSyntheticSessionMessage(syntheticSession.id, 'user', messageForAgent)

    let fullText = ''
    let agentError = ''
    const forwardProviderEvents = (raw: string) => {
      const lines = raw.split('\n').filter(Boolean)
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const parsed = JSON.parse(line.slice(6).trim())
          if (parsed.t === 'd' && parsed.text) {
            fullText += parsed.text
            writeEvent({ t: 'd', text: parsed.text, agentId: agent.id, agentName: agent.name })
          } else if ((parsed.t === 'r' || parsed.t === 'reset') && typeof parsed.text === 'string') {
            // Providers can replace the draft or return a complete reply without deltas.
            fullText = parsed.text
            writeEvent({ t: parsed.t, text: parsed.text, agentId: agent.id, agentName: agent.name })
          } else if (parsed.t === 'tool_call' || parsed.t === 'tool_result') {
            writeEvent({ ...parsed, agentId: agent.id, agentName: agent.name })
          } else if (parsed.t === 'err' && parsed.text) {
            agentError = parsed.text
            writeEvent({ t: 'err', text: parsed.text, agentId: agent.id, agentName: agent.name })
          }
        } catch {
          // skip malformed lines
        }
      }
    }

    let rawResponseText = ''
    if (NON_LANGGRAPH_PROVIDER_IDS.has(syntheticSession.provider)) {
      const provider = getProvider(syntheticSession.provider)
      if (!provider) throw new Error(`Unknown provider: ${syntheticSession.provider}`)
      rawResponseText = await provider.handler.streamChat({
        session: syntheticSession,
        message: messageForAgent,
        imagePath: ctx.imagePath,
        apiKey,
        systemPrompt: fullSystemPrompt,
        write: forwardProviderEvents,
        active: new Map<string, unknown>(),
        loadHistory: () => history,
      })
      if (!rawResponseText) rawResponseText = fullText
    } else {
      const result = await streamAgentChat({
        session: syntheticSession,
        message: messageForAgent,
        imagePath: ctx.imagePath,
        attachedFiles: ctx.attachedFiles,
        apiKey,
        systemPrompt: fullSystemPrompt,
        write: forwardProviderEvents,
        history,
      })
      rawResponseText = result.finalResponse || result.fullText || fullText
    }
    const responseText = stripAgentReactionTokens(stripHiddenControlTokens(rawResponseText))

    // Don't persist empty or error-only messages — they pollute chat history
    if (!responseText.trim() && agentError) {
      appendSyntheticSessionMessage(syntheticSession.id, 'assistant', agentError)
      markProviderFailure(agent.provider, agentError)
      writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
      return []
    }

    if (responseText.trim() && !shouldSuppressHiddenControlText(rawResponseText)) {
      appendSyntheticSessionMessage(syntheticSession.id, 'assistant', responseText)
      const parsedMentions = parseMentions(responseText, agents, freshChatroom.agentIds, { senderId: agent.id, skipImplicit: true })
      const chainedHealth = filterHealthyChatroomAgents(parsedMentions, agents)
      const newMentions = chainedHealth.healthyAgentIds
      if (chainedHealth.skipped.length > 0) {
        const detail = chainedHealth.skipped
          .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
          .join(', ')
        writeEvent({ t: 'err', text: `Mentioned agents skipped: ${detail}`, agentId: agent.id, agentName: agent.name })
      }
      const agentMessage: ChatroomMessage = {
        id: genId(),
        senderId: agent.id,
        senderName: agent.name,
        role: 'assistant',
        text: responseText,
        mentions: newMentions,
        reactions: [],
        time: Date.now(),
      }
      const latestChatrooms = loadChatrooms()
      const latestChatroom = latestChatrooms[id] as Chatroom
      latestChatroom.messages.push(agentMessage)
      latestChatroom.updatedAt = Date.now()
      latestChatrooms[id] = latestChatroom
      saveChatrooms(latestChatrooms)
      notify(`chatroom:${id}`)

      // Extract and apply reactions (e.g. [REACTION]{"emoji":"👍","to":"..."})
      applyAgentReactionsFromText(responseText, id, agent.id)

      // Persist interaction to agent memory (fire-and-forget)
      persistChatroomInteractionMemory({
        agentId: agent.id,
        agent,
        chatroomId: id,
        chatroomName: ctx.chatroomName,
        senderName: ctx.senderName,
        inboundText: ctx.originalText,
        responseText,
      }).catch(() => {})

      markProviderSuccess(agent.provider)
      writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name, message: agentMessage })

      // Return chained agent IDs — enriched context is built by the caller when queuing
      return newMentions.filter((mid) => !processed.has(mid) && freshChatroom.agentIds.includes(mid))
    }

    markProviderSuccess(agent.provider)
    writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
    return []
  } catch (err: unknown) {
    const msg = errorMessage(err)
    markProviderFailure(agent.provider, msg)
    writeEvent({ t: 'err', text: `Agent ${agent.name} error: ${msg}`, agentId: agent.id })
    writeEvent({ t: 'cr_agent_done', agentId: agent.id, agentName: agent.name })
    return []
  }
}
