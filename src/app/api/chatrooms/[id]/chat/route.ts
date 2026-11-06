import { NextResponse } from 'next/server'
import { genId } from '@/lib/id'
import { loadChatrooms, saveChatrooms, loadAgents } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import {
  parseMentions,
  resolveReplyTargetAgentId,
  compactChatroomMessages,
} from '@/lib/server/chatrooms/chatroom-helpers'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'
import {
  ensureChatroomRoutingGuidance,
  selectChatroomRecipients,
} from '@/lib/server/chatrooms/chatroom-routing'
import { runChatroomAgentTurn } from '@/lib/server/chatrooms/chatroom-agent-runner'
import type { Chatroom, ChatroomMessage, Agent } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const text = typeof body.text === 'string'
    ? body.text
    : (typeof body.message === 'string' ? body.message : '')
  const senderId = typeof body.senderId === 'string' ? body.senderId : 'user'
  const imagePath = typeof body.imagePath === 'string' ? body.imagePath : undefined
  const attachedFiles = Array.isArray(body.attachedFiles)
    ? (body.attachedFiles as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined
  const replyToId = typeof body.replyToId === 'string' ? body.replyToId : undefined

  if (!text.trim() && !imagePath && !attachedFiles?.length) {
    return NextResponse.json({ error: 'text or attachment is required' }, { status: 400 })
  }

  const agents = loadAgents() as Record<string, Agent>

  // Persist incoming message
  const senderName = senderId === 'user' ? 'You' : (agents[senderId]?.name || senderId)
  const replyTargetAgentId = resolveReplyTargetAgentId(replyToId, chatroom.messages, chatroom.agentIds)
  ensureChatroomRoutingGuidance(chatroom, agents)
  let mentions = parseMentions(text, agents, chatroom.agentIds, { replyTargetAgentId, senderId: senderId !== 'user' ? senderId : null })
  if (mentions.length === 0 && !chatroom.autoAddress) {
    mentions = await selectChatroomRecipients({
      text,
      chatroom,
      agentsById: agents,
    })
  }
  // Auto-address: if enabled and still no mentions, address all agents
  if (chatroom.autoAddress && mentions.length === 0) {
    mentions = [...chatroom.agentIds]
  }
  // If a specific agent is targeted, ensure they're in the mentions
  const incomingTargetAgentId = typeof body.targetAgentId === 'string' ? body.targetAgentId : undefined
  if (incomingTargetAgentId && chatroom.agentIds.includes(incomingTargetAgentId) && !mentions.includes(incomingTargetAgentId)) {
    mentions.push(incomingTargetAgentId)
  }
  const mentionHealth = filterHealthyChatroomAgents(mentions, agents)
  mentions = mentionHealth.healthyAgentIds
  const userMessage: ChatroomMessage = {
    id: genId(),
    senderId,
    senderName,
    role: senderId === 'user' ? 'user' : 'assistant',
    text,
    mentions,
    reactions: [],
    time: Date.now(),
    ...(imagePath ? { imagePath } : {}),
    ...(attachedFiles ? { attachedFiles } : {}),
    ...(replyToId ? { replyToId } : {}),
    ...(incomingTargetAgentId ? { targetAgentId: incomingTargetAgentId } : {}),
  }
  chatroom.messages.push(userMessage)
  compactChatroomMessages(chatroom)
  chatroom.updatedAt = Date.now()
  chatrooms[id] = chatroom
  saveChatrooms(chatrooms)
  notify('chatrooms')
  notify(`chatroom:${id}`)

  // If sender is an agent (via triggerResponses tool), just persist the message — don't re-process agents
  if (senderId !== 'user' && agents[senderId]) {
    const encoder = new TextEncoder()
    const noopStream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ t: 'done' })}\n\n`))
        controller.close()
      },
    })
    return new NextResponse(noopStream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
    })
  }

  // Build reply context if replying to a message
  let replyContext = ''
  if (replyToId) {
    const replyMsg = chatroom.messages.find((m) => m.id === replyToId)
    if (replyMsg) {
      const truncated = replyMsg.text.length > 200 ? replyMsg.text.slice(0, 200) + '...' : replyMsg.text
      replyContext = `> [${replyMsg.senderName}]: ${truncated}\n\n`
    }
  }

  // SSE stream
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const writeEvent = (event: Record<string, unknown>) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      const processAgents = async () => {
        if (mentionHealth.skipped.length > 0) {
          const detail = mentionHealth.skipped
            .map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`)
            .join(', ')
          writeEvent({ t: 'err', text: `Skipped agents: ${detail}` })
        }
        if (mentions.length === 0) {
          writeEvent({ t: 'err', text: 'No healthy agents available in this chatroom. Check provider credentials/endpoints and retry.' })
          writeEvent({ t: 'done' })
          if (!closed) {
            try { controller.close() } catch { /* already closed */ }
            closed = true
          }
          return
        }

        // Build agent queue: start with mentioned agents, then chain
        const initialQueue: Array<{ agentId: string; depth: number; contextMessage?: string }> = mentions.map((aid) => ({ agentId: aid, depth: 0 }))
        const processed = new Set<string>()
        const agentQueue: Array<{ agentId: string; depth: number; contextMessage?: string }> = []

        /** Single agent turn, shared with the self-discussion endpoint. */
        const processOneAgent = (item: { agentId: string; depth: number; contextMessage?: string }) =>
          runChatroomAgentTurn(
            {
              chatroomId: id,
              agents,
              chatroomName: chatroom.name,
              senderName,
              originalText: text,
              replyContext,
              imagePath,
              attachedFiles,
              processed,
              writeEvent,
            },
            item,
          )

        if (chatroom.chatMode === 'parallel') {
          // Process initial batch in parallel
          const results = await Promise.all(initialQueue.map(processOneAgent))
          // Chained agents from parallel responses queue sequentially
          for (const chainedIds of results) {
            for (const cid of chainedIds) {
              agentQueue.push({ agentId: cid, depth: 1 })
            }
          }
        } else {
          // Sequential: push initial queue items
          agentQueue.push(...initialQueue)
        }

        // Process remaining chained agents sequentially with enriched context
        while (agentQueue.length > 0) {
          const item = agentQueue.shift()!

          // Build enriched context for chained agents by looking at the most recent message
          if (item.depth > 0 && !item.contextMessage) {
            const latestChatrooms = loadChatrooms()
            const latestChatroom = latestChatrooms[id] as Chatroom
            const lastAgentMsg = [...latestChatroom.messages].reverse().find(
              (m) => m.role === 'assistant' && m.senderId !== item.agentId
            )
            if (lastAgentMsg) {
              const truncated = lastAgentMsg.text.length > 500 ? lastAgentMsg.text.slice(0, 500) + '...' : lastAgentMsg.text
              const originalTruncated = text.length > 300 ? text.slice(0, 300) + '...' : text
              item.contextMessage = [
                `[Conversation context] The user said: "${originalTruncated}"`,
                `${lastAgentMsg.senderName} then said: "${truncated}"`,
                `They mentioned you — respond to the conversation naturally.`,
              ].join('\n')
            }
          }

          const chainedIds = await processOneAgent(item)
          for (const cid of chainedIds) {
            agentQueue.push({ agentId: cid, depth: item.depth + 1 })
          }
        }

        writeEvent({ t: 'done' })
        if (!closed) {
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
      }

      processAgents().catch((err) => {
        const msg = errorMessage(err)
        writeEvent({ t: 'err', text: msg })
        writeEvent({ t: 'done' })
        if (!closed) {
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
      })
    },
    cancel() {
      // Client disconnected
    },
  })

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
