import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reconcileChatroom } from './reconcile-chatroom'
import type { Chatroom, ChatroomMessage } from '@/types'

const message = (id: string, time: number): ChatroomMessage => ({
  id, senderId: 'agent', senderName: 'Agent', role: 'assistant',
  text: id, mentions: [], reactions: [], time,
})
const room = (messages: ChatroomMessage[]): Chatroom => ({
  id: 'room', name: 'Test', agentIds: ['agent'], messages,
  createdAt: 1, updatedAt: messages.at(-1)?.time ?? 1,
})

test('concurrent stale websocket GET does not erase SSE-completed replies', () => {
  const recent = room([message('user', 1), message('reply', 3)])
  const stale = room([message('user', 1)])
  assert.deepEqual(reconcileChatroom(stale, recent, true).messages.map(m => m.id), ['user', 'reply'])
})

test('no duplicates when SSE and GET both contain the completed reply', () => {
  const recent = room([message('user', 1), message('reply', 3)])
  assert.deepEqual(reconcileChatroom(recent, recent, true).messages.map(m => m.id), ['user', 'reply'])
})

test('server is canonical outside streaming, including deleted messages', () => {
  const recent = room([message('user', 1), message('deleted', 3)])
  const server = room([message('user', 1)])
  assert.deepEqual(reconcileChatroom(server, recent, false).messages.map(m => m.id), ['user'])
})
