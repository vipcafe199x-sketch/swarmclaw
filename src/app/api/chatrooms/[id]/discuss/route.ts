import { NextResponse } from 'next/server'
import { loadChatrooms, loadAgents } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { safeParseBody } from '@/lib/server/safe-parse-body'
import { runChatroomAgentTurn } from '@/lib/server/chatrooms/chatroom-agent-runner'
import { filterHealthyChatroomAgents } from '@/lib/server/chatrooms/chatroom-health'
import type { Chatroom, Agent } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MAX_DISCUSS_ROUNDS = 3

function truncate(text: string, max: number): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(0, max - 3))}...`
}

export function buildDiscussPrompt(params: {
  topic: string
  round: number
  maxRounds: number
  prevName: string | null
  prevText: string | null
  isCloser: boolean
  isFirst: boolean
}): string {
  const { topic, round, maxRounds, prevName, prevText, isCloser, isFirst } = params
  if (isCloser) {
    return [
      `[Tự thảo luận trong phòng] Chủ đề: "${topic}"`,
      `Cuộc thảo luận đã xong ${maxRounds} vòng. Bạn là người chốt lại.`,
      'Hãy tóm tắt các ý chính đã thảo luận, đưa ra kết luận và khuyến nghị cụ thể cho Đại ca.',
      'Ngắn gọn, rõ ràng, đúng vai của bạn.',
    ].join('\n')
  }
  if (isFirst) {
    return [
      `[Tự thảo luận trong phòng] Chủ đề: "${topic}"`,
      `Bạn là người mở đầu thảo luận (vòng 1/${maxRounds}).`,
      'Hãy đưa ra quan điểm và cách tiếp cận của bạn về chủ đề này, ngắn gọn, đúng vai của bạn.',
      'Các thành viên khác sẽ nối tiếp ý của bạn.',
    ].join('\n')
  }
  return [
    `[Tự thảo luận trong phòng] Chủ đề: "${topic}" (vòng ${round}/${maxRounds})`,
    `${prevName} vừa nói: "${truncate(prevText || '', 500)}"`,
    `Hãy phản hồi trực tiếp ý của ${prevName}: đồng tình, bổ sung, hoặc phản biện, rồi đưa ra ý của mình.`,
    'Nói ngắn gọn, đúng vai của bạn, đừng lặp lại ý đã có. Đây là lượt thảo luận, không phải trả lời câu hỏi của user.',
  ].join('\n')
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<Record<string, unknown>>(req)
  if (error) return error

  const chatrooms = loadChatrooms()
  const chatroom = chatrooms[id] as Chatroom | undefined
  if (!chatroom) return notFound()

  const agents = loadAgents() as Record<string, Agent>
  const memberIds = (chatroom.agentIds || []).filter((aid) => agents[aid])
  if (memberIds.length < 2) {
    return NextResponse.json({ error: 'Cần ít nhất 2 agent trong phòng để thảo luận.' }, { status: 400 })
  }

  // Topic: explicit, else the latest user message in the room.
  let topic = typeof body.topic === 'string' ? body.topic.trim() : ''
  if (!topic) {
    const lastUser = [...chatroom.messages].reverse().find((m) => m.role === 'user')
    topic = lastUser ? lastUser.text.trim() : ''
  }
  if (!topic) {
    return NextResponse.json({ error: 'Chưa có câu hỏi/chủ đề để thảo luận. Hãy nhắn một câu hỏi trước.' }, { status: 400 })
  }

  // Main agent (speaks first) + turn order.
  const mainAgentId = typeof body.mainAgentId === 'string' && memberIds.includes(body.mainAgentId)
    ? body.mainAgentId
    : memberIds[0]
  let order: string[] = []
  if (Array.isArray(body.order)) {
    const seen = new Set<string>()
    for (const v of body.order) {
      if (typeof v === 'string' && memberIds.includes(v) && !seen.has(v)) {
        seen.add(v)
        order.push(v)
      }
    }
  }
  if (order.length === 0) {
    order = [mainAgentId, ...memberIds.filter((aid) => aid !== mainAgentId)]
  }
  // Append any members missing from an explicit order.
  for (const aid of memberIds) {
    if (!order.includes(aid)) order.push(aid)
  }

  const maxRounds = Math.min(MAX_DISCUSS_ROUNDS, Math.max(1, typeof body.maxRounds === 'number' ? Math.floor(body.maxRounds) : 2))
  const closerAgentId = typeof body.closerAgentId === 'string' && memberIds.includes(body.closerAgentId)
    ? body.closerAgentId
    : mainAgentId

  // Only healthy (non-muted, provider-ok) agents take part.
  const health = filterHealthyChatroomAgents(order, agents)
  const turnOrder = health.healthyAgentIds
  if (turnOrder.length < 2) {
    return NextResponse.json({ error: 'Không đủ agent khỏe mạnh để thảo luận. Kiểm tra provider/credentials rồi thử lại.' }, { status: 400 })
  }
  const closer = turnOrder.includes(closerAgentId) ? closerAgentId : turnOrder[0]

  // SSE stream
  const encoder = new TextEncoder()
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      let closed = false
      const writeEvent = (event: Record<string, unknown>) => {
        if (closed || cancelled) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }

      const runDiscussion = async () => {
        const startTime = Date.now()
        writeEvent({ t: 'discuss_start', topic, order: turnOrder, maxRounds, closerAgentId: closer })
        if (health.skipped.length > 0) {
          const detail = health.skipped.map((row) => `${agents[row.agentId]?.name || row.agentId}: ${row.reason}`).join(', ')
          writeEvent({ t: 'err', text: `Skipped agents: ${detail}` })
        }

        const baseCtx = {
          chatroomId: id,
          agents,
          chatroomName: chatroom.name,
          senderName: 'You',
          originalText: topic,
          replyContext: '',
          writeEvent,
        }

        // Previous discussion message (only messages created after this run started).
        const prevDiscussionMessage = () => {
          const fresh = loadChatrooms()[id] as Chatroom | undefined
          if (!fresh) return undefined
          return [...fresh.messages].reverse().find((m) => m.role === 'assistant' && m.time >= startTime)
        }

        for (let round = 1; round <= maxRounds; round++) {
          for (const agentId of turnOrder) {
            if (cancelled || closed) break
            const prev = prevDiscussionMessage()
            const prompt = buildDiscussPrompt({
              topic,
              round,
              maxRounds,
              prevName: prev ? prev.senderName : null,
              prevText: prev ? prev.text : null,
              isCloser: false,
              isFirst: !prev,
            })
            await runChatroomAgentTurn(
              { ...baseCtx, processed: new Set<string>() },
              { agentId, depth: 0, contextMessage: prompt },
            )
          }
          if (cancelled || closed) break
        }

        // Closer turn: summary + recommendation for Đại ca.
        if (!cancelled && !closed) {
          const closerPrompt = buildDiscussPrompt({
            topic,
            round: maxRounds,
            maxRounds,
            prevName: null,
            prevText: null,
            isCloser: true,
            isFirst: false,
          })
          await runChatroomAgentTurn(
            { ...baseCtx, processed: new Set<string>() },
            { agentId: closer, depth: 0, contextMessage: closerPrompt },
          )
        }

        writeEvent({ t: 'done' })
        if (!closed) {
          try { controller.close() } catch { /* already closed */ }
          closed = true
        }
      }

      runDiscussion().catch((err) => {
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
      cancelled = true
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
