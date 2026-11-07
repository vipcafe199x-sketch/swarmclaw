import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { toast } from 'sonner'
import type { Chatroom } from '@/types'
import { useChatroomStore } from './use-chatroom-store'

const initialState = useChatroomStore.getState()
const originalFetch = global.fetch
const room = { id: 'test', name: 'Test', agentIds: ['agent'], messages: [], createdAt: 1, updatedAt: 1 } as unknown as Chatroom

function setup(events: unknown[]) {
  const errors = mock.method(toast, 'error', () => 'error-toast')
  useChatroomStore.setState({ ...initialState, currentChatroomId: room.id, chatrooms: { test: room } })
  global.fetch = (async (_url, options) => {
    if (options?.method === 'POST') {
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }
    return Response.json(room)
  }) as typeof fetch
  return errors
}

afterEach(() => {
  global.fetch = originalFetch
  useChatroomStore.setState(initialState)
  mock.restoreAll()
})

for (const discussion of [false, true]) {
  const mode = discussion ? 'discussion' : 'normal chat'
  const send = () => discussion
    ? useChatroomStore.getState().startDiscussion({ topic: 'hello', order: ['agent'] })
    : useChatroomStore.getState().sendMessage('hello')

  test(`${mode}: provider failure stays visible as a toast after stream cleanup`, async () => {
    const errors = setup([
      { t: 'cr_agent_start', agentId: 'agent', agentName: 'Triệu Vân' },
      { t: 'err', agentId: 'agent', agentName: 'Triệu Vân', text: '429 Rate limit reached' },
      { t: 'cr_agent_done', agentId: 'agent' },
      { t: 'done' },
    ])
    await send()
    assert.equal(errors.mock.calls.length, 1)
    assert.equal(errors.mock.calls[0].arguments[0], '429 Rate limit reached')
    assert.equal(useChatroomStore.getState().streaming, false)
    assert.equal(useChatroomStore.getState().streamingAgents.size, 0)
  })

  test(`${mode}: room-level errors without an agent are reported`, async () => {
    const errors = setup([{ t: 'err', text: 'No healthy agents available' }, { t: 'done' }])
    await send()
    assert.equal(errors.mock.calls[0].arguments[0], 'No healthy agents available')
  })

  test(`${mode}: completed text replaces draft before the turn finishes`, async () => {
    setup([
      { t: 'cr_agent_start', agentId: 'agent', agentName: 'Triệu Vân' },
      { t: 'd', agentId: 'agent', text: 'draft' },
      { t: 'r', agentId: 'agent', text: 'complete reply' },
      { t: 'reset', agentId: 'agent', text: 'clean reply' },
      { t: 'done' },
    ])
    const drafts: string[] = []
    const unsubscribe = useChatroomStore.subscribe((state) => {
      const text = state.streamingAgents.get('agent')?.text
      if (text) drafts.push(text)
    })
    try { await send() } finally { unsubscribe() }
    assert.ok(drafts.includes('complete reply'))
    assert.ok(drafts.includes('clean reply'))
    assert.ok(!drafts.includes('draftcomplete reply'))
  })

  test(`${mode}: rejected requests show their server error`, async () => {
    const errors = setup([])
    global.fetch = (async () => Response.json({ error: 'Access denied' }, { status: 403 })) as typeof fetch
    await send()
    assert.equal(errors.mock.calls[0].arguments[0], 'Access denied')
    assert.equal(useChatroomStore.getState().streaming, false)
  })

  test(`${mode}: connection failures are reported`, async () => {
    const errors = setup([])
    global.fetch = (async () => { throw new Error('Network disconnected') }) as typeof fetch
    await send()
    assert.equal(errors.mock.calls[0].arguments[0], 'Network disconnected')
  })
}
