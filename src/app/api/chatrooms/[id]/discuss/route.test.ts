import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('discussion mode does not replay the last user question without a new prompt', () => {
  const output = runWithTempDataDir<{ status: number; messageCount: number }>(`
    const storage = await import('./src/lib/server/storage')
    const route = await import('./src/app/api/chatrooms/[id]/discuss/route')
    const now = Date.now()
    storage.saveAgents({
      alpha: { id: 'alpha', name: 'Alpha', provider: 'openai', model: 'gpt-4o', createdAt: now, updatedAt: now },
      beta: { id: 'beta', name: 'Beta', provider: 'openai', model: 'gpt-4o', createdAt: now, updatedAt: now },
    })
    storage.saveChatrooms({
      test: { id: 'test', name: 'Test', agentIds: ['alpha', 'beta'],
        messages: [{ id: 'old', senderId: 'user', senderName: 'You', role: 'user',
          text: 'old question', mentions: [], reactions: [], time: now - 1000 }],
        createdAt: now, updatedAt: now, chatMode: 'sequential', autoAddress: false },
    })
    const response = await route.POST(new Request('http://localhost/api/chatrooms/test/discuss', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: ['alpha', 'beta'] }),
    }), { params: Promise.resolve({ id: 'test' }) })
    console.log(JSON.stringify({
      status: response.status,
      messageCount: storage.loadChatrooms().test.messages.length,
    }))
  `, { prefix: 'swarmclaw-discussion-no-replay-' })
  assert.equal(output.status, 400)
  assert.equal(output.messageCount, 1)
})

test('discussion emits each completed agent reply and preserves a fresh user prompt', () => {
  const output = runWithTempDataDir<{ userTexts: string[]; replyCount: number; completedCount: number; doneLast: boolean }>(`
    const storage = await import('./src/lib/server/storage')
    const providers = await import('@/lib/providers')
    const route = await import('./src/app/api/chatrooms/[id]/discuss/route')
    const streams = await import('@/lib/server/chat-execution/stream-agent-chat')
    providers.PROVIDERS['discussion-test-provider'] = {
      id: 'discussion-test-provider', name: 'Test Provider',
      models: ['test-model'], requiresApiKey: false, requiresEndpoint: false,
      handler: { streamChat: async () => '' },
    }
    const now = Date.now()
    storage.saveAgents({
      alpha: { id: 'alpha', name: 'Alpha', provider: 'discussion-test-provider', model: 'test-model', extensions: [], createdAt: now, updatedAt: now },
      beta: { id: 'beta', name: 'Beta', provider: 'discussion-test-provider', model: 'test-model', extensions: [], createdAt: now, updatedAt: now },
    })
    storage.saveChatrooms({
      test: { id: 'test', name: 'Test', agentIds: ['alpha', 'beta'],
        messages: [{ id: 'old', senderId: 'user', senderName: 'You', role: 'user', text: 'old question', mentions: [], reactions: [], time: now - 1000 }],
        createdAt: now, updatedAt: now, chatMode: 'sequential', autoAddress: false },
    })
    streams.setStreamAgentChatForTest(async (opts) => {
      const reply = opts.session?.agentId === 'alpha' ? 'Alpha answer' : 'Beta answer'
      return { fullText: reply, finalResponse: reply }
    })
    try {
      const res = await route.POST(new Request('http://localhost/api/chatrooms/test/discuss', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'new question', order: ['alpha', 'beta'], maxRounds: 1 }),
      }), { params: Promise.resolve({ id: 'test' }) })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      const events = []
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        pending += decoder.decode(chunk.value)
        const entries = pending.split('\\n\\n')
        pending = entries.pop() || ''
        for (const entry of entries) {
          const line = entry.split('\\n').find((item) => item.startsWith('data: '))
          if (line) events.push(JSON.parse(line.slice(6)))
        }
      }
      const messages = storage.loadChatrooms().test.messages
      console.log(JSON.stringify({
        userTexts: messages.filter((m) => m.role === 'user').map((m) => m.text),
        replyCount: messages.filter((m) => m.role === 'assistant').length,
        completedCount: events.filter((e) => e.t === 'cr_agent_done' && e.message && e.message.id).length,
        doneLast: events.at(-1)?.t === 'done',
      }))
    } finally {
      streams.setStreamAgentChatForTest(null)
    }
  `, { prefix: 'swarmclaw-discussion-streaming-' })
  assert.deepEqual(output.userTexts, ['old question', 'new question'])
  assert.equal(output.replyCount, 3)
  assert.equal(output.completedCount, 3)
  assert.equal(output.doneLast, true)
})
