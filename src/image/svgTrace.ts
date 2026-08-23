import type { ImageTracerOptions } from 'imagetracerjs'
import type { ImageNode } from '../types'

/** UI-facing trace options — mapped onto imagetracerjs's option object. */
export type TraceUiOptions = {
  numberOfColors: number
  detail: number
  splitDetail: boolean
  detailQ: number
  pathOmit: number
  blurRadius: number
  rightAngleEnhance: boolean
  colorSampling: number
  strokeWidth: number
  colorQuantCycles: number
}

export function defaultTraceUiOptions(): TraceUiOptions {
  return {
    numberOfColors: 12,
    detail: 1,
    splitDetail: false,
    detailQ: 1,
    pathOmit: 8,
    blurRadius: 0,
    rightAngleEnhance: true,
    colorSampling: 2,
    strokeWidth: 1,
    colorQuantCycles: 3,
  }
}

export function buildImageTracerOptions(ui: TraceUiOptions): ImageTracerOptions {
  return {
    numberofcolors: ui.numberOfColors,
    ltres: ui.detail,
    qtres: ui.splitDetail ? ui.detailQ : ui.detail,
    pathomit: ui.pathOmit,
    blurradius: ui.blurRadius,
    blurdelta: 20,
    rightangleenhance: ui.rightAngleEnhance,
    colorsampling: ui.colorSampling,
    strokewidth: ui.strokeWidth,
    colorquantcycles: ui.colorQuantCycles,
    mincolorratio: 0,
    linefilter: false,
    roundcoords: 1,
    // Fixed: our own placement matrix handles scale/rotation; sequential
    // layering (0) is required for the hole/compound-path structure below.
    scale: 1,
    viewbox: true,
    layering: 0,
    desc: false,
  }
}

type WorkerOutMsg =
  | { type: 'loaded'; requestId: number }
  | { type: 'result'; requestId: number; svg: string }
  | { type: 'error'; requestId: number; message: string }

type Pending =
  | { kind: 'load'; resolve: () => void; reject: (e: Error) => void }
  | { kind: 'trace'; resolve: (svg: string) => void; reject: (e: Error) => void }

/** Thin client around the svgTrace worker: one image loaded, many re-traces. */
export class SvgTraceWorkerClient {
  private worker: Worker
  private nextRequestId = 0
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL('../workers/svgTrace.worker.ts', import.meta.url), {
      type: 'module',
    })
    this.worker.onmessage = (e: MessageEvent<WorkerOutMsg>) => {
      const msg = e.data
      const p = this.pending.get(msg.requestId)
      if (!p) return
      this.pending.delete(msg.requestId)
      if (msg.type === 'error') {
        p.reject(new Error(msg.message))
        return
      }
      if (msg.type === 'loaded' && p.kind === 'load') p.resolve()
      else if (msg.type === 'result' && p.kind === 'trace') p.resolve(msg.svg)
    }
  }

  load(imageData: ImageData): Promise<void> {
    const requestId = ++this.nextRequestId
    const data = new Uint8ClampedArray(imageData.data)
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { kind: 'load', resolve, reject })
      this.worker.postMessage(
        { type: 'load', requestId, width: imageData.width, height: imageData.height, data },
        [data.buffer],
      )
    })
  }

  /** Synchronous requestId so callers can discard stale in-flight results. */
  trace(options: ImageTracerOptions): { requestId: number; result: Promise<string> } {
    const requestId = ++this.nextRequestId
    const result = new Promise<string>((resolve, reject) => {
      this.pending.set(requestId, { kind: 'trace', resolve, reject })
      this.worker.postMessage({ type: 'trace', requestId, options })
    })
    return { requestId, result }
  }

  destroy(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

export type ParsedTracePath = {
  d: string
  r: number
  g: number
  b: number
  opacity: number
}

const RGB_RE = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/

/** Extract {d, color, opacity} per traced region from imagetracerjs's SVG output. */
export function parseTracedSvg(svg: string): ParsedTracePath[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out: ParsedTracePath[] = []
  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const d = el.getAttribute('d')
    if (!d) continue
    const match = RGB_RE.exec(el.getAttribute('fill') ?? '')
    if (!match) continue
    const opacityAttr = el.getAttribute('opacity')
    const opacity = opacityAttr !== null ? Math.max(0, Math.min(1, Number(opacityAttr))) : 1
    out.push({ d, r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), opacity })
  }
  return out
}

export type PlacementXform = (x: number, y: number) => readonly [number, number]

/**
 * Maps imagetracerjs's native-pixel-space coordinates onto the document,
 * matching the ImageNode's box/rotation exactly. Uses a single uniform scale
 * + centering offset (not independent x/y scale) to reproduce the browser's
 * `preserveAspectRatio="xMidYMid meet"` behavior used to render/export the
 * raster itself (NodeViews.tsx, exportSvg.ts) — otherwise the traced result
 * would be stretched relative to what's actually displayed whenever the
 * image box's aspect ratio has drifted from the raster's native ratio.
 * Rotation pivots at center, mirroring NodeViews.tsx's
 * `rotationProps(node, x + width/2, y + height/2)`.
 */
export function buildPlacementMatrix(
  image: ImageNode,
  naturalWidth: number,
  naturalHeight: number,
): PlacementXform {
  const scale = Math.min(image.width / naturalWidth, image.height / naturalHeight)
  const offsetX = (image.width - naturalWidth * scale) / 2
  const offsetY = (image.height - naturalHeight * scale) / 2
  const theta = (image.rotation * Math.PI) / 180
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const cx = image.x + image.width / 2
  const cy = image.y + image.height / 2
  return (px, py) => {
    const lx = px * scale + offsetX - image.width / 2
    const ly = py * scale + offsetY - image.height / 2
    const rx = lx * cos - ly * sin
    const ry = lx * sin + ly * cos
    return [rx + cx, ry + cy] as const
  }
}

const PATH_COMMAND_RE = /([MLQZ])([^MLQZ]*)/gi

/** Rewrites every coordinate in a `d` string (M/L/Q/Z only) through `xform`. */
export function transformPathD(d: string, xform: PlacementXform): string {
  let out = ''
  PATH_COMMAND_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATH_COMMAND_RE.exec(d))) {
    const cmd = match[1]!.toUpperCase()
    if (cmd === 'Z') {
      out += 'Z '
      continue
    }
    const nums = (match[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (cmd === 'M' || cmd === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const [x, y] = xform(nums[i]!, nums[i + 1]!)
        out += `${i === 0 ? cmd : 'L'} ${x} ${y} `
      }
    } else if (cmd === 'Q') {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const [cx1, cy1] = xform(nums[i]!, nums[i + 1]!)
        const [x, y] = xform(nums[i + 2]!, nums[i + 3]!)
        out += `Q ${cx1} ${cy1} ${x} ${y} `
      }
    }
  }
  return out.trim()
}

/** Decode a raster href to ImageData + natural pixel size via an offscreen canvas. */
export async function decodeImageData(
  href: string,
): Promise<{ imageData: ImageData; naturalWidth: number; naturalHeight: number }> {
  const img = new Image()
  img.decoding = 'async'
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to load image'))
  })
  img.src = href
  await loaded

  const naturalWidth = img.naturalWidth
  const naturalHeight = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = naturalWidth
  canvas.height = naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, naturalWidth, naturalHeight)
  return { imageData, naturalWidth, naturalHeight }
}
