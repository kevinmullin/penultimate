import { hexToRgb } from '../color/colorMath'
import type { ImageNode } from '../types'

/** Options accepted by the vendored vtracer wasm binding (see src/vendor/vtracer-wasm). */
export type VtracerOptions = {
  clustering?: 'color-cluster' | 'bw' | 'watershed'
  hierarchical?: 'stacked' | 'cutout'
  mode?: 'pixel' | 'polygon' | 'spline'
  filterSpeckle?: number
  colorPrecision?: number
  layerDifference?: number
  cornerThreshold?: number
  lengthThreshold?: number
  maxIterations?: number
  spliceThreshold?: number
  simplify?: number
  pathPrecision?: number
  palette?: string[]
  maxColors?: number
  optimize?: number
  binaryThreshold?: number
  adaptive?: boolean
  adaptiveWindow?: number
  adaptiveT?: number
  watershedDetail?: number
  preset?: 'bw' | 'poster' | 'photo'
}

/**
 * UI-facing trace options — mapped onto vtracer's option object. Field
 * ranges/behavior below are taken from vtracer's own CLI help text and
 * `crates/vtracer/src/config.rs` (tag 1.0.0-alpha.3, the version vendored in
 * src/vendor/vtracer-wasm), then confirmed by calling the wasm module
 * directly with values at and past each documented bound — see the
 * per-field notes.
 */
export type TraceUiOptions = {
  mode: 'pixel' | 'polygon' | 'spline'
  /** Seam-free mosaic (`cutout`) vs. the classic overlapping-layer stack (`stacked`, default). */
  hierarchical: 'stacked' | 'cutout'
  clustering: 'color-cluster' | 'bw' | 'watershed'
  /** Significant bits per RGB channel. Hard-capped at 8 (full 8-bit channel) — confirmed 12 behaves identically to 8, not clamped-with-error. Color-cluster only. */
  colorPrecision: number
  /** Color-cluster only. */
  layerDifference: number
  /** 0 = off. Auto-quantize to at most N colors; applies after clustering regardless of mode. */
  maxColors: number
  /** Comma-separated #rrggbb list; empty = off. Takes priority over maxColors. */
  palette: string
  /** bw clustering only: fixed threshold 0-255 (used unless adaptive is on). */
  binaryThreshold: number
  /** bw clustering only: Bradley–Roth adaptive thresholding instead of the fixed cutoff. */
  adaptive: boolean
  /** bw clustering only, adaptive: window size in px, 0 = auto. */
  adaptiveWindow: number
  /** bw clustering only, adaptive: % below local mean, vtracer default 15. */
  adaptiveT: number
  /** watershed clustering only: hierarchy cut level 0-255, higher = more regions. */
  watershedDetail: number
  /** Discard patches smaller than this (px side length, area = value²). CLI-documented range 0-128. */
  filterSpeckle: number
  /** Spline mode only. */
  cornerThreshold: number
  /** Spline mode only. CLI-documented range 3.5-10 (not hard-enforced, but outside it is untested/degenerate). */
  lengthThreshold: number
  /** Spline mode only, uncapped in the library; CLI hides this flag since the default serves virtually every conversion. */
  maxIterations: number
  /** Spline mode only. */
  spliceThreshold: number
  /** Spline mode only; pixel/polygon polylines pass through untouched. 0 = off. */
  simplify: number
  /** Decimal places in output path coordinates. */
  pathPrecision: number
  strokeWidth: number
}

export function defaultTraceUiOptions(): TraceUiOptions {
  return {
    mode: 'spline',
    hierarchical: 'stacked',
    clustering: 'color-cluster',
    colorPrecision: 6,
    layerDifference: 16,
    maxColors: 0,
    palette: '',
    binaryThreshold: 128,
    adaptive: false,
    adaptiveWindow: 0,
    adaptiveT: 15,
    watershedDetail: 128,
    filterSpeckle: 4,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    simplify: 0,
    pathPrecision: 2,
    strokeWidth: 1,
  }
}

export function buildVtracerOptions(ui: TraceUiOptions): VtracerOptions {
  const palette = ui.palette
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return {
    mode: ui.mode,
    hierarchical: ui.hierarchical,
    clustering: ui.clustering,
    colorPrecision: ui.colorPrecision,
    layerDifference: ui.layerDifference,
    maxColors: ui.maxColors > 0 ? ui.maxColors : undefined,
    palette: palette.length > 0 ? palette : undefined,
    binaryThreshold: ui.binaryThreshold,
    // The wasm binding treats *any* adaptive-tuning field as an implicit
    // `adaptive: true` (see src/vendor/vtracer-wasm/README.md's linked
    // lib.rs) — sending adaptiveWindow/adaptiveT unconditionally would
    // silently force adaptive mode on regardless of the checkbox.
    adaptive: ui.adaptive || undefined,
    adaptiveWindow: ui.adaptive ? ui.adaptiveWindow : undefined,
    adaptiveT: ui.adaptive ? ui.adaptiveT : undefined,
    watershedDetail: ui.watershedDetail,
    filterSpeckle: ui.filterSpeckle,
    cornerThreshold: ui.cornerThreshold,
    lengthThreshold: ui.lengthThreshold,
    maxIterations: ui.maxIterations,
    spliceThreshold: ui.spliceThreshold,
    simplify: ui.simplify > 0 ? ui.simplify : undefined,
    pathPrecision: ui.pathPrecision,
    // Force absolute, unabbreviated path commands (M/L/C/Z only) — parseTracedSvg
    // and transformPathD don't handle vtracer's optimized output (relative
    // lowercase commands, H/V shorthands).
    optimize: 0,
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
  trace(options: VtracerOptions): { requestId: number; result: Promise<string> } {
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

/** Extract {d, color, opacity} per traced region from vtracer's SVG output (fill="#rrggbb"). */
export function parseTracedSvg(svg: string): ParsedTracePath[] {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const out: ParsedTracePath[] = []
  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const d = el.getAttribute('d')
    if (!d) continue
    const rgb = hexToRgb(el.getAttribute('fill') ?? '')
    if (!rgb) continue
    const opacityAttr = el.getAttribute('opacity')
    const opacity = opacityAttr !== null ? Math.max(0, Math.min(1, Number(opacityAttr))) : 1
    out.push({ d, r: rgb.r, g: rgb.g, b: rgb.b, opacity })
  }
  return out
}

/**
 * Rewrites the raw vtracer SVG into exactly what `apply()` places on the
 * canvas will look like: `commitSvgTrace` gives every path a same-color
 * stroke (closes hairline antialiasing seams between adjacent traced
 * regions), which the raw wasm output never has. Without this, the preview
 * pane shows a visibly different (unstroked) result from what actually
 * gets applied whenever strokeWidth > 0 — this keeps them identical.
 */
export function buildPreviewSvg(svg: string, strokeWidth: number): string {
  if (strokeWidth <= 0) return svg
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  for (const el of Array.from(doc.querySelectorAll('path'))) {
    const fill = el.getAttribute('fill')
    if (!fill) continue
    el.setAttribute('stroke', fill)
    el.setAttribute('stroke-width', String(strokeWidth))
  }
  return new XMLSerializer().serializeToString(doc)
}

export type PlacementXform = (x: number, y: number) => readonly [number, number]

/**
 * Maps vtracer's native-pixel-space coordinates onto the document,
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

const PATH_COMMAND_RE = /([MLCZ])([^MLCZ]*)/gi

/**
 * Rewrites every coordinate in a `d` string through `xform`. Handles only
 * M/L/C/Z — the commands vtracer emits with `optimize: 0` (absolute,
 * unabbreviated: no relative lowercase commands, no H/V shorthand).
 */
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
    } else if (cmd === 'C') {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const [cx1, cy1] = xform(nums[i]!, nums[i + 1]!)
        const [cx2, cy2] = xform(nums[i + 2]!, nums[i + 3]!)
        const [x, y] = xform(nums[i + 4]!, nums[i + 5]!)
        out += `C ${cx1} ${cy1} ${cx2} ${cy2} ${x} ${y} `
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
