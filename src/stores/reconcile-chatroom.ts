import type { Chatroom } from '@/types'

/**
 * Concurrent websocket refreshes can resolve after an SSE agent_done event.
 * Preserve locally observed completed turns during streaming, but use the
 * server snapshot outside streaming so moderation/deletions still work.
 */
export function reconcileChatroom(incoming: Chatroom, previous: Chatroom | undefined, active: boolean): Chatroom {
  if (!active || !previous) return incoming
  const ids = new Set(incoming.messages.map((message) => message.id))
  const missing = previous.messages.filter((message) => !ids.has(message.id))
  if (!missing.length) return incoming
  return {
    ...incoming,
    messages: [...incoming.messages, ...missing].sort((a, b) => a.time - b.time),
    updatedAt: Math.max(incoming.updatedAt || 0, previous.updatedAt || 0),
  }
}

