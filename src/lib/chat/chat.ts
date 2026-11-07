import type { SSEEvent } from '@/types'

interface StreamChatOptions {
  internal?: boolean
  queueMode?: 'followup' | 'steer' | 'collect'
  replyToId?: string
}

export async function streamChat(
  sessionId: string,
  message: string,
  imagePath?: string,
  imageUrl?: string,
  onEvent?: (event: SSEEvent) => void,
  optionsOrFiles?: StreamChatOptions | string[],
  options?: StreamChatOptions,
): Promise<void> {
  // Support both (options) and (attachedFiles, options) as 6th arg
  let attachedFiles: string[] | undefined
  let opts: StreamChatOptions | undefined
  if (Array.isArray(optionsOrFiles)) {
    attachedFiles = optionsOrFiles
    opts = options
  } else {
    opts = optionsOrFiles
  }

  const res = await fetch(`/api/chats/${sessionId}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      imagePath,
      imageUrl,
      attachedFiles,
      internal: !!opts?.internal,
      queueMode: opts?.queueMode,
      ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
    }),
  })

  if (!res.ok || !res.body) {
    onEvent?.({ t: 'err', text: `Request failed (${res.status})` })
    onEvent?.({ t: 'done' })
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const STREAM_IDLE_TIMEOUT_MS = 300_000

  while (true) {
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const idleAbort = new Promise<{ done: true; value: undefined }>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true
        resolve({ done: true, value: undefined })
      }, STREAM_IDLE_TIMEOUT_MS)
    })
    const { done, value } = await Promise.race([reader.read(), idleAbort])
    clearTimeout(timeoutId)
    if (done) {
      if (timedOut) {
        onEvent?.({ t: 'err', text: 'Stream timed out (no data for 5 minutes)' })
        reader.cancel().catch(() => {})
      }
      break
    }
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      try {
        const event = JSON.parse(line.slice(6)) as SSEEvent
        // Forward all event types including tool_call and tool_result
        onEvent?.(event)
      } catch {
        // skip malformed
      }
    }
  }
}
