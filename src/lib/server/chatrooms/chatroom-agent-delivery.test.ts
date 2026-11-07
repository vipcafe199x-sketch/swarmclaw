import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('chatroom forwards complete replies and replacements, persists them once, and surfaces failed turns', () => {
  const output = runWithTempDataDir<{
    types: string[]; texts: string[]; storedTexts: string[]; completedTexts: string[]; errors: string[]
  }>(`
    const storageMod = await import('@/lib/server/storage')
    const storage = storageMod.default || storageMod
    const providersMod = await import('@/lib/providers')
    const providers = providersMod.default || providersMod
    const setsMod = await import('@/lib/provider-sets')
    const sets = setsMod.default || setsMod
    const runnerMod = await import('@/lib/server/chatrooms/chatroom-agent-runner')
    const runner = runnerMod.default || runnerMod
    const now = Date.now()
    const agent = { id: 'agent', name: 'Triệu Vân', provider: 'delivery-test', model: 'test', extensions: [], createdAt: now, updatedAt: now }
    storage.saveAgents({ agent })
    storage.saveChatrooms({ test: { id: 'test', name: 'Test', agentIds: ['agent'], messages: [], createdAt: now, updatedAt: now } })
    sets.NON_LANGGRAPH_PROVIDER_IDS.add('delivery-test')
    let fail = false
    providers.PROVIDERS['delivery-test'] = {
      id: 'delivery-test', name: 'Test', models: [], requiresApiKey: false,
      handler: { streamChat: async ({ write }) => {
        const events = fail ? [{ t: 'err', text: '429 Rate limit reached' }] : [
          { t: 'd', text: 'draft' }, { t: 'r', text: 'complete reply' }, { t: 'reset', text: 'clean reply' },
        ]
        for (const event of events) write('data: ' + JSON.stringify(event) + '\\n\\n')
        return ''
      } },
    }
    const events = []
    const ctx = { chatroomId: 'test', agents: { agent }, chatroomName: 'Test', senderName: 'You', originalText: 'hello', replyContext: '', processed: new Set(), writeEvent: (event) => events.push(event) }
    await runner.runChatroomAgentTurn(ctx, { agentId: 'agent', depth: 0 })
    fail = true
    await runner.runChatroomAgentTurn({ ...ctx, processed: new Set() }, { agentId: 'agent', depth: 0 })
    console.log(JSON.stringify({
      types: events.map(e => e.t),
      texts: events.filter(e => ['d', 'r', 'reset'].includes(e.t)).map(e => e.text),
      storedTexts: storage.loadChatrooms().test.messages.map(m => m.text),
      completedTexts: events.filter(e => e.message).map(e => e.message.text),
      errors: events.filter(e => e.t === 'err').map(e => e.text),
    }))
  `)
  assert.deepEqual(output.types, ['cr_agent_start', 'd', 'r', 'reset', 'cr_agent_done', 'cr_agent_start', 'err', 'cr_agent_done'])
  assert.deepEqual(output.texts, ['draft', 'complete reply', 'clean reply'])
  assert.deepEqual(output.storedTexts, ['clean reply'])
  assert.deepEqual(output.completedTexts, ['clean reply'])
  assert.deepEqual(output.errors, ['429 Rate limit reached'])
})
