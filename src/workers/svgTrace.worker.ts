/// <reference lib="webworker" />
import ImageTracer from 'imagetracerjs'
import type { ImageTracerOptions } from 'imagetracerjs'

type LoadMsg = {
  type: 'load'
  requestId: number
  width: number
  height: number
  data: Uint8ClampedArray<ArrayBuffer>
}
type TraceMsg = {
  type: 'trace'
  requestId: number
  options: ImageTracerOptions
}
type InMsg = LoadMsg | TraceMsg

type OutMsg =
  | { type: 'loaded'; requestId: number }
  | { type: 'result'; requestId: number; svg: string }
  | { type: 'error'; requestId: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

let cached: ImageData | null = null

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  try {
    if (msg.type === 'load') {
      cached = new ImageData(msg.data, msg.width, msg.height)
      const out: OutMsg = { type: 'loaded', requestId: msg.requestId }
      ctx.postMessage(out)
      return
    }
    if (!cached) throw new Error('No image loaded')
    const svg = ImageTracer.imagedataToSVG(cached, msg.options)
    const out: OutMsg = { type: 'result', requestId: msg.requestId, svg }
    ctx.postMessage(out)
  } catch (err) {
    const out: OutMsg = {
      type: 'error',
      requestId: msg.requestId,
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(out)
  }
}
