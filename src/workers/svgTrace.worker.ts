/// <reference lib="webworker" />
import init, { vectorize_rgba } from '../vendor/vtracer-wasm/vtracer_wasm.js'
import wasmUrl from '../vendor/vtracer-wasm/vtracer_wasm_bg.wasm?url'
import type { VtracerOptions } from '../image/svgTrace'

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
  options: VtracerOptions
}
type InMsg = LoadMsg | TraceMsg

type OutMsg =
  | { type: 'loaded'; requestId: number }
  | { type: 'result'; requestId: number; svg: string }
  | { type: 'error'; requestId: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

let cached: ImageData | null = null
const ready = init(wasmUrl)

ctx.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data
  void (async () => {
    try {
      await ready
      if (msg.type === 'load') {
        cached = new ImageData(msg.data, msg.width, msg.height)
        const out: OutMsg = { type: 'loaded', requestId: msg.requestId }
        ctx.postMessage(out)
        return
      }
      if (!cached) throw new Error('No image loaded')
      const svg = vectorize_rgba(
        new Uint8Array(cached.data.buffer),
        cached.width,
        cached.height,
        msg.options,
      )
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
  })()
}
