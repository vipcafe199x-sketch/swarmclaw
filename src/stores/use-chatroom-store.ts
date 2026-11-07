'use client'

import { create } from 'zustand'
import { toast } from 'sonner'
import { reconcileChatroom } from './reconcile-chatroom'
import { api, getStoredAccessKey } from '@/lib/app/api-client'
import type { Chatroom, ChatroomMessage, SSEEvent } from '@/types'
import type { PendingFile } from '@/stores/use-chat-store'

interface ToolEvent {
  name: string
  input: string
  output?: string
}

export interface StreamingAgent {
  text: string
  name: string
  error?: string
  toolEvents: ToolEvent[]
}

interface QueuedChatroomMessage {
  id: string
  chatroomId: string
  text: string
  pendingFiles: PendingFile[]
  replyingTo: ChatroomMessage | null
}

function nextQueuedId() {
  return `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export type ChatroomFilterMode = 'chatrooms' | 'protocols'

export interface DiscussSettings {
  topic?: string
  mainAgentId?: string
  order?: string[]
  maxRounds?: number
  closerAgentId?: string
}

interface ChatroomState {
  chatrooms: Record<string, Chatroom>
  protocolRooms: Record<string, Chatroom>
  chatroomFilter: ChatroomFilterMode
  currentChatroomId: string | null
  streaming: boolean
  streamingAgents: Map<string, StreamingAgent>
  chatroomSheetOpen: boolean
  editingChatroomId: string | null
  /** A self-discussion run is in progress (Tự thảo luận). */
  discussing: boolean
  discussAbort: AbortController | null
  discussionSettings: DiscussSettings | null
  discussionRoomId: string | null

  // File uploads
  pendingFiles: PendingFile[]
  addPendingFile: (f: PendingFile) => void
  removePendingFile: (index: number) => void
  clearPendingFiles: () => void

  // Reply-to
  replyingTo: ChatroomMessage | null
  setReplyingTo: (msg: ChatroomMessage | null) => void

  queuedMessages: QueuedChatroomMessage[]
  removeQueuedMessage: (id: string) => void
  clearQueuedMessages: (chatroomId: string) => void
  shiftQueuedMessage: () => QueuedChatroomMessage | undefined

  loadChatrooms: () => Promise<void>
  loadChatroomById: (id: string) => Promise<Chatroom | null>
  createChatroom: (data: { name: string; description?: string; agentIds?: string[]; chatMode?: 'sequential' | 'parallel'; autoAddress?: boolean; routingGuidance?: string | null }) => Promise<Chatroom>
  updateChatroom: (id: string, data: Partial<Chatroom>) => Promise<void>
  deleteChatroom: (id: string) => Promise<void>
  setCurrentChatroom: (id: string | null) => void
  sendMessage: (text: string) => Promise<void>
  startDiscussion: (settings: DiscussSettings) => Promise<void>
  enableDiscussion: (settings: DiscussSettings) => void
  disableDiscussion: () => void
  stopDiscussion: () => void
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  togglePin: (messageId: string) => Promise<void>
  addMember: (agentId: string) => Promise<void>
  removeMember: (agentId: string) => Promise<void>
  setChatroomSheetOpen: (open: boolean) => void
  setEditingChatroomId: (id: string | null) => void
  setChatroomFilter: (filter: ChatroomFilterMode) => void
  loadProtocolRooms: () => Promise<void>

  // Moderation
  deleteMessage: (messageId: string, targetAgentId: string) => Promise<void>
  muteAgent: (targetAgentId: string, minutes?: number) => Promise<void>
  unmuteAgent: (targetAgentId: string) => Promise<void>
  setMemberRole: (targetAgentId: string, role: 'admin' | 'moderator' | 'member') => Promise<void>
}

export const useChatroomStore = create<ChatroomState>((set, get) => ({
  chatrooms: {},
  protocolRooms: {},
  chatroomFilter: 'chatrooms' as ChatroomFilterMode,
  currentChatroomId: null,
  streaming: false,
  streamingAgents: new Map(),
  chatroomSheetOpen: false,
  editingChatroomId: null,
  discussing: false,
  discussAbort: null,
  discussionSettings: null,
  discussionRoomId: null,

  // File uploads
  pendingFiles: [],
  addPendingFile: (f) => set((s) => ({ pendingFiles: [...s.pendingFiles, f] })),
  removePendingFile: (index) => set((s) => ({ pendingFiles: s.pendingFiles.filter((_, i) => i !== index) })),
  clearPendingFiles: () => set({ pendingFiles: [] }),

  // Reply-to
  replyingTo: null,
  setReplyingTo: (msg) => set({ replyingTo: msg }),
  queuedMessages: [],
  removeQueuedMessage: (id) => set((s) => ({ queuedMessages: s.queuedMessages.filter((item) => item.id !== id) })),
  clearQueuedMessages: (chatroomId) => set((s) => ({
    queuedMessages: s.queuedMessages.filter((item) => item.chatroomId !== chatroomId),
  })),
  shiftQueuedMessage: () => {
    const queue = get().queuedMessages
    if (!queue.length) return undefined
    const next = queue[0]
    set({ queuedMessages: queue.slice(1) })
    return next
  },

  loadChatrooms: async () => {
    const chatrooms = await api<Record<string, Chatroom>>('GET', '/chatrooms')
    set((state) => {
      const next = { ...(chatrooms || {}) }
      for (const [id, chatroom] of Object.entries(state.chatrooms)) {
        if (chatroom?.hidden === true) next[id] = chatroom
      }
      return { chatrooms: next }
    })
  },

  loadChatroomById: async (id) => {
    if (!id) return null
    try {
      const chatroom = await api<Chatroom>('GET', `/chatrooms/${id}`)
      set((state) => ({ chatrooms: { ...state.chatrooms, [id]: reconcileChatroom(chatroom, state.chatrooms[id], state.streaming || state.discussing) } }))
      return chatroom
    } catch {
      return null
    }
  },

  createChatroom: async (data) => {
    const chatroom = await api<Chatroom>('POST', '/chatrooms', data)
    set((s) => ({ chatrooms: { ...s.chatrooms, [chatroom.id]: chatroom } }))
    return chatroom
  },

  updateChatroom: async (id, data) => {
    const chatroom = await api<Chatroom>('PUT', `/chatrooms/${id}`, data)
    set((s) => ({ chatrooms: { ...s.chatrooms, [id]: chatroom } }))
  },

  deleteChatroom: async (id) => {
    await api('DELETE', `/chatrooms/${id}`)
    set((s) => {
      const chatrooms = { ...s.chatrooms }
      delete chatrooms[id]
      return {
        chatrooms,
        currentChatroomId: s.currentChatroomId === id ? null : s.currentChatroomId,
      }
    })
  },

  setCurrentChatroom: (id) => set({ currentChatroomId: id }),

  sendMessage: async (text) => {
    const { currentChatroomId, streaming, pendingFiles, replyingTo } = get()
    if (!currentChatroomId || (!text.trim() && !pendingFiles.length)) return
    const targetChatroomId = currentChatroomId

    if (streaming) {
      set((s) => ({
        queuedMessages: [
          ...s.queuedMessages,
          {
            id: nextQueuedId(),
            chatroomId: targetChatroomId,
            text,
            pendingFiles: [...pendingFiles],
            replyingTo,
          },
        ],
        pendingFiles: [],
        replyingTo: null,
      }))
      return
    }

    // Arming discussion never replays history: only a newly submitted user prompt starts it.
    const { discussionSettings, discussionRoomId } = get()
    if (discussionSettings && discussionRoomId === targetChatroomId) {
      if (pendingFiles.length) {
        // Preserve attachments through the discussion endpoint.
        await get().startDiscussion({
          ...discussionSettings, topic: text,
          imagePath: pendingFiles[0]?.file.type.startsWith('image/') ? pendingFiles[0].path : undefined,
          attachedFiles: pendingFiles.map((f) => f.path),
        } as DiscussSettings)
      } else {
        await get().startDiscussion({ ...discussionSettings, topic: text })
      }
      return
    }

    const imagePath = pendingFiles.length > 0 && pendingFiles[0].file.type.startsWith('image/')
      ? pendingFiles[0].path
      : undefined
    const attachedFiles = pendingFiles.length > 0
      ? pendingFiles.map((f) => f.path)
      : undefined
    const optimisticText = text.trim() || 'See attached file(s).'
    let started = false

    const key = getStoredAccessKey()
    try {
      const res = await fetch(`/api/chatrooms/${targetChatroomId}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Access-Key': key } : {}),
        },
        body: JSON.stringify({
          text,
          ...(imagePath ? { imagePath } : {}),
          ...(attachedFiles ? { attachedFiles } : {}),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        }),
      })

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => null) as { error?: string } | null
        toast.error(detail?.error || `Could not send chatroom message (HTTP ${res.status}).`)
        return
      }

      started = true
      set((s) => {
        const existingChatroom = s.chatrooms[targetChatroomId]
        const optimisticMessage: ChatroomMessage = {
          id: `local-${Date.now()}`,
          senderId: 'user',
          senderName: 'You',
          role: 'user',
          text: optimisticText,
          mentions: [],
          reactions: [],
          time: Date.now(),
          ...(imagePath ? { imagePath } : {}),
          ...(attachedFiles ? { attachedFiles } : {}),
          ...(replyingTo ? { replyToId: replyingTo.id } : {}),
        }
        return {
          streaming: true,
          streamingAgents: new Map(),
          pendingFiles: [],
          replyingTo: null,
          chatrooms: existingChatroom
            ? {
                ...s.chatrooms,
                [targetChatroomId]: {
                  ...existingChatroom,
                  messages: [...existingChatroom.messages, optimisticMessage],
                  updatedAt: optimisticMessage.time,
                },
              }
            : s.chatrooms,
        }
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent
            const agentId = event.agentId
            const agentName = event.agentName

            if (event.t === 'cr_agent_start' && agentId && agentName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                agents.set(agentId, { text: '', name: agentName, toolEvents: [] })
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_call' && agentId && event.toolName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, {
                    ...existing,
                    toolEvents: [...existing.toolEvents, { name: event.toolName!, input: event.toolInput || '' }],
                  })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_result' && agentId) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing && existing.toolEvents.length > 0) {
                  const updatedEvents = [...existing.toolEvents]
                  const last = updatedEvents[updatedEvents.length - 1]
                  updatedEvents[updatedEvents.length - 1] = { ...last, output: event.toolOutput || event.text || '' }
                  agents.set(agentId, { ...existing, toolEvents: updatedEvents })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'd' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, text: existing.text + event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'err' && !agentId && event.text) {
              // Routing/provider failures arrive without an agentId. Do not swallow them:
              // otherwise a persisted user message looks like a silently ignored @mention.
              toast.error(event.text)
            } else if (event.t === 'err' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, error: event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'cr_agent_done' && agentId) {
              // The server sends the persisted message with each completed turn.
              // Render it immediately rather than waiting for the entire discussion/batch.
              const completed = (event as SSEEvent & { message?: ChatroomMessage }).message
              if (completed) {
                set((s) => {
                  const room = s.chatrooms[targetChatroomId]
                  if (!room || room.messages.some((msg) => msg.id === completed.id)) return s
                  return { chatrooms: {
                    ...s.chatrooms,
                    [targetChatroomId]: {
                      ...room,
                      messages: [...room.messages, completed],
                      updatedAt: completed.time,
                    },
                  } }
                })
              }
              const currentAgent = get().streamingAgents.get(agentId)
              if (currentAgent?.error) {
                setTimeout(() => {
                  set((s) => {
                    const agents = new Map(s.streamingAgents)
                    agents.delete(agentId)
                    return { streamingAgents: agents }
                  })
                }, 4000)
              } else {
                set((s) => {
                  const agents = new Map(s.streamingAgents)
                  agents.delete(agentId)
                  return { streamingAgents: agents }
                })
              }
            } else if (event.t === 'done') {
              break
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Chatroom request failed.')
    } finally {
      if (started) {
        set({ streaming: false, streamingAgents: new Map() })
        try {
          const chatroom = await api<Chatroom>('GET', `/chatrooms/${targetChatroomId}`)
          set((s) => ({ chatrooms: { ...s.chatrooms, [targetChatroomId]: chatroom } }))
        } catch { /* ignore */ }

        const nextQueued = get().shiftQueuedMessage()
        if (nextQueued) {
          if (get().currentChatroomId !== nextQueued.chatroomId) {
            set((s) => ({ queuedMessages: [nextQueued, ...s.queuedMessages] }))
            return
          }
          set({ pendingFiles: nextQueued.pendingFiles, replyingTo: nextQueued.replyingTo })
          setTimeout(() => {
            void get().sendMessage(nextQueued.text)
          }, 100)
        }
      }
    }
  },

  enableDiscussion: (settings) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    set({ discussionSettings: { ...settings }, discussionRoomId: currentChatroomId })
  },
  disableDiscussion: () => {
    get().stopDiscussion()
    set({ discussionSettings: null, discussionRoomId: null })
  },

  /** Start a self-discussion run (Tự thảo luận): agents take turns in the
   *  chosen order, each responding to the previous speaker. Streams the same
   *  SSE events as sendMessage so the typing/streaming UI is reused. */
  startDiscussion: async (settings) => {
    const { currentChatroomId, streaming, discussing } = get()
    if (!currentChatroomId || streaming || discussing || !settings.topic?.trim()) return
    const targetChatroomId = currentChatroomId
    const abort = new AbortController()
    set({ discussing: true, discussAbort: abort })
    const key = getStoredAccessKey()
    let started = false
    try {
      const res = await fetch(`/api/chatrooms/${targetChatroomId}/discuss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(key ? { 'X-Access-Key': key } : {}),
        },
        body: JSON.stringify(settings),
        signal: abort.signal,
      })
      if (!res.ok || !res.body) {
        return
      }
      started = true
      set((s) => {
        const room = s.chatrooms[targetChatroomId]
        const optimisticMessage: ChatroomMessage = {
          id: `local-${Date.now()}`,
          senderId: 'user',
          senderName: 'You',
          role: 'user',
          text: settings.topic!.trim(),
          mentions: [],
          reactions: [],
          time: Date.now(),
        }
        return {
          streaming: true, streamingAgents: new Map(),
          pendingFiles: [], replyingTo: null,
          chatrooms: room ? {
            ...s.chatrooms,
            [targetChatroomId]: {
              ...room, messages: [...room.messages, optimisticMessage],
              updatedAt: optimisticMessage.time,
            },
          } : s.chatrooms,
        }
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6)) as SSEEvent
            const agentId = event.agentId
            const agentName = event.agentName
            if (event.t === 'cr_agent_start' && agentId && agentName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                agents.set(agentId, { text: '', name: agentName, toolEvents: [] })
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_call' && agentId && event.toolName) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, {
                    ...existing,
                    toolEvents: [...existing.toolEvents, { name: event.toolName!, input: event.toolInput || '' }],
                  })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'tool_result' && agentId) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing && existing.toolEvents.length > 0) {
                  const updatedEvents = [...existing.toolEvents]
                  const last = updatedEvents[updatedEvents.length - 1]
                  updatedEvents[updatedEvents.length - 1] = { ...last, output: event.toolOutput || event.text || '' }
                  agents.set(agentId, { ...existing, toolEvents: updatedEvents })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'd' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, text: existing.text + event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'err' && agentId && event.text) {
              set((s) => {
                const agents = new Map(s.streamingAgents)
                const existing = agents.get(agentId)
                if (existing) {
                  agents.set(agentId, { ...existing, error: event.text })
                }
                return { streamingAgents: agents }
              })
            } else if (event.t === 'cr_agent_done' && agentId) {
              // The server sends the persisted message with each completed turn.
              // Render it immediately rather than waiting for the entire discussion/batch.
              const completed = (event as SSEEvent & { message?: ChatroomMessage }).message
              if (completed) {
                set((s) => {
                  const room = s.chatrooms[targetChatroomId]
                  if (!room || room.messages.some((msg) => msg.id === completed.id)) return s
                  return { chatrooms: {
                    ...s.chatrooms,
                    [targetChatroomId]: {
                      ...room,
                      messages: [...room.messages, completed],
                      updatedAt: completed.time,
                    },
                  } }
                })
              }
              const currentAgent = get().streamingAgents.get(agentId)
              if (currentAgent?.error) {
                setTimeout(() => {
                  set((s) => {
                    const agents = new Map(s.streamingAgents)
                    agents.delete(agentId)
                    return { streamingAgents: agents }
                  })
                }, 4000)
              } else {
                set((s) => {
                  const agents = new Map(s.streamingAgents)
                  agents.delete(agentId)
                  return { streamingAgents: agents }
                })
              }
            } else if (event.t === 'done') {
              break
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err) {
      // AbortError from stopDiscussion is expected; anything else is ignored here.
      if (err instanceof Error && err.name !== 'AbortError') {
        // leave to finally for cleanup
      }
    } finally {
      set({ discussing: false, discussAbort: null })
      if (started) {
        set({ streaming: false, streamingAgents: new Map() })
        try {
          const chatroom = await api<Chatroom>('GET', `/chatrooms/${targetChatroomId}`)
          set((s) => ({ chatrooms: { ...s.chatrooms, [targetChatroomId]: chatroom } }))
        } catch { /* ignore */ }
        const nextQueued = get().shiftQueuedMessage()
        if (nextQueued) {
          if (get().currentChatroomId !== nextQueued.chatroomId) {
            set((s) => ({ queuedMessages: [nextQueued, ...s.queuedMessages] }))
            return
          }
          set({ pendingFiles: nextQueued.pendingFiles, replyingTo: nextQueued.replyingTo })
          setTimeout(() => {
            void get().sendMessage(nextQueued.text)
          }, 100)
        }
      }
    }
  },

  stopDiscussion: () => {
    const { discussAbort } = get()
    if (discussAbort) {
      try { discussAbort.abort() } catch { /* already aborted */ }
    }
  },

  toggleReaction: async (messageId, emoji) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const previous = get().chatrooms[currentChatroomId]
    if (previous) {
      set((s) => ({
        chatrooms: {
          ...s.chatrooms,
          [currentChatroomId]: {
            ...previous,
            messages: previous.messages.map((message) => {
              if (message.id !== messageId) return message
              const existing = message.reactions.find((reaction) => reaction.emoji === emoji && reaction.reactorId === 'user')
              return {
                ...message,
                reactions: existing
                  ? message.reactions.filter((reaction) => !(reaction.emoji === emoji && reaction.reactorId === 'user'))
                  : [...message.reactions, { emoji, reactorId: 'user', time: Date.now() }],
              }
            }),
          },
        },
      }))
    }
    try {
      const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/reactions`, { messageId, emoji })
      set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
    } catch {
      if (previous) {
        set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: previous } }))
      }
    }
  },

  togglePin: async (messageId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const previous = get().chatrooms[currentChatroomId]
    if (previous) {
      const pinnedMessageIds = previous.pinnedMessageIds || []
      set((s) => ({
        chatrooms: {
          ...s.chatrooms,
          [currentChatroomId]: {
            ...previous,
            pinnedMessageIds: pinnedMessageIds.includes(messageId)
              ? pinnedMessageIds.filter((id) => id !== messageId)
              : [...pinnedMessageIds, messageId],
          },
        },
      }))
    }
    try {
      const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/pins`, { messageId })
      set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
    } catch {
      if (previous) {
        set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: previous } }))
      }
    }
  },

  addMember: async (agentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/members`, { agentId })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  removeMember: async (agentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('DELETE', `/chatrooms/${currentChatroomId}/members`, { agentId })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  setChatroomSheetOpen: (open) => set({ chatroomSheetOpen: open }),
  setEditingChatroomId: (id) => set({ editingChatroomId: id }),
  setChatroomFilter: (filter) => set({ chatroomFilter: filter }),
  loadProtocolRooms: async () => {
    const rooms = await api<Record<string, Chatroom>>('GET', '/chatrooms?filter=protocols')
    set({ protocolRooms: rooms || {} })
  },

  // Moderation
  deleteMessage: async (messageId, targetAgentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'delete-message',
      targetAgentId,
      messageId,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  muteAgent: async (targetAgentId, minutes = 30) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'mute',
      targetAgentId,
      muteDurationMinutes: minutes,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  unmuteAgent: async (targetAgentId) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'unmute',
      targetAgentId,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },

  setMemberRole: async (targetAgentId, role) => {
    const { currentChatroomId } = get()
    if (!currentChatroomId) return
    const chatroom = await api<Chatroom>('POST', `/chatrooms/${currentChatroomId}/moderate`, {
      action: 'set-role',
      targetAgentId,
      role,
    })
    set((s) => ({ chatrooms: { ...s.chatrooms, [currentChatroomId]: chatroom } }))
  },
}))
