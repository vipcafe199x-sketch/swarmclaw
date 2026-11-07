import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('keeps existing cookie sessions valid and expires only the browser cookie on logout', () => {
  const result = runWithTempDataDir<{
    authenticated: boolean; setCookieOnProbe: string | null; logoutCookie: string | null; keyUnchanged: boolean
  }>(`
    const authMod = await import('./src/lib/server/storage-auth')
    const auth = authMod.default || authMod
    const routeMod = await import('./src/app/api/auth/route')
    const route = routeMod.default || routeMod
    const key = auth.getAccessKey()
    const response = await route.GET(new Request('http://localhost/api/auth', {
      headers: { cookie: 'sc_auth=' + encodeURIComponent(key) },
    }))
    const data = await response.json()
    const logout = await route.DELETE()
    console.log(JSON.stringify({
      authenticated: data.authenticated,
      setCookieOnProbe: response.headers.get('set-cookie'),
      logoutCookie: logout.headers.get('set-cookie'),
      keyUnchanged: auth.getAccessKey() === key,
    }))
  `, { prefix: 'swarmclaw-cookie-auth-' })
  assert.equal(result.authenticated, true)
  assert.equal(result.setCookieOnProbe, null)
  assert.equal(result.keyUnchanged, true)
  assert.match(result.logoutCookie || '', /sc_auth=;/)
  assert.match(result.logoutCookie || '', /Max-Age=0/i)
  assert.match(result.logoutCookie || '', /HttpOnly/i)
  assert.match(result.logoutCookie || '', /Path=\//i)
})
