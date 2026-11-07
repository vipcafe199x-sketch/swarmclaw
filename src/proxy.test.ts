import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { NextRequest } from 'next/server'

import { proxy } from './proxy'

const originalAccessKey = process.env.ACCESS_KEY

afterEach(() => {
  if (originalAccessKey === undefined) delete process.env.ACCESS_KEY
  else process.env.ACCESS_KEY = originalAccessKey
})

describe('proxy', () => {
  it('keeps CORS headers on extension-install auth failures for allowed origins', () => {
    process.env.ACCESS_KEY = 'top-secret'

    const request = new NextRequest('http://localhost/api/extensions/install', {
      method: 'POST',
      headers: {
        origin: 'https://swarmclaw.ai',
      },
    })

    const response = proxy(request)
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://swarmclaw.ai')
    assert.equal(response.headers.get('vary'), 'Origin')
  })

  for (const path of ['/api/upload', '/api/chats/session/chat', '/api/chatrooms/room/chat', '/api/chatrooms/room/discuss']) {
    it(`authenticates ${path} using only the existing cookie`, () => {
      process.env.ACCESS_KEY = 'top-secret'
      const response = proxy(new NextRequest(`http://localhost${path}`, {
        method: 'POST',
        headers: { cookie: 'sc_auth=top-secret' },
      }))
      assert.equal(response.status, 200)
    })

    it(`rejects ${path} without credentials`, () => {
      process.env.ACCESS_KEY = 'top-secret'
      assert.equal(proxy(new NextRequest(`http://localhost${path}`, { method: 'POST' })).status, 401)
    })
  }

  it('prefers the auth cookie over a stale access-key header', () => {
    process.env.ACCESS_KEY = 'top-secret'

    const request = new NextRequest('http://localhost/api/agents', {
      headers: {
        cookie: 'sc_auth=top-secret',
        'x-access-key': 'stale-key',
      },
    })

    const response = proxy(request)
    assert.equal(response.status, 200)
  })

  it('does not lock out invalid requests in development', () => {
    process.env.ACCESS_KEY = 'top-secret'
    const originalNodeEnv = process.env.NODE_ENV;
    (process.env as any).NODE_ENV = 'development'

    try {
      for (let i = 0; i < 6; i++) {
        const response = proxy(new NextRequest('http://localhost/api/agents', {
          headers: {
            'x-access-key': 'bad-key',
          },
        }))
        assert.equal(response.status, 401)
      }
      const finalResponse = proxy(new NextRequest('http://localhost/api/agents', {
        headers: {
          'x-access-key': 'bad-key',
        },
      }))
      assert.equal(finalResponse.status, 401)
    } finally {
      if (originalNodeEnv === undefined) delete (process.env as any).NODE_ENV
      else (process.env as any).NODE_ENV = originalNodeEnv
    }
  })
})
