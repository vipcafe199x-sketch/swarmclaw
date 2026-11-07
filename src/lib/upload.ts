import type { UploadResult } from '../types'

export async function uploadImage(file: File): Promise<UploadResult> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'X-Filename': file.name,
    },
    body: file,
  })
  if (!res.ok) throw new Error(`Upload failed (${res.status})`)
  return res.json()
}
