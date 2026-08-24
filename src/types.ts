import {
  normalizePaint,
  paintNone,
  paintSolid,
  type Paint,
} from './style/paint'
import {
  normalizeStrokeAlign,
  type StrokeAlign,
} from './style/strokeAlign'

export type { Paint, GradientStop } from './style/paint'
export type { StrokeAlign } from './style/strokeAlign'

export type Tool =
  | 'select'
  | 'direct'
  | 'rect'
  | 'rounded-rect'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'line'
  | 'pen'
  | 'pencil'
  | 'text'
  | 'area-text'
  | 'eyedropper'
  | 'scissors'
  | 'shear'
  | 'hand'
  | 'zoom'

export type StrokeLinecap = 'butt' | 'round' | 'square'
export type StrokeLinejoin = 'miter' | 'round' | 'bevel'

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'

export type DropShadow = {
  enabled: boolean
  dx: number
  dy: number
  blur: number
  color: string
  opacity: number
}

export type NodeStyle = {
  fill: Paint
  stroke: Paint
  strokeWidth: number
  /** Where the stroke sits relative to the path edge. Default: center. */
  strokeAlign: StrokeAlign
  opacity: number
  strokeLinecap: StrokeLinecap
  strokeLinejoin: StrokeLinejoin
  /** SVG dash array, e.g. "6 4". Empty/null = solid. */
  strokeDasharray: string | null
  /** Draw a triangle arrowhead at the end of strokes (lines/open paths). */
  strokeArrow: boolean
  /** CSS/SVG mix-blend-mode. */
  blendMode: BlendMode
  /** Optional drop shadow (SVG feDropShadow). */
  shadow: DropShadow
}

export type NodeBase = {
  id: string
  name: string
  visible: boolean
  locked: boolean
  rotation: number
  style: NodeStyle
}

export type RectNode = NodeBase & {
  type: 'rect'
  x: number
  y: number
  width: number
  height: number
  /** Corner radius (rounded rect). */
  rx?: number
}

export type EllipseNode = NodeBase & {
  type: 'ellipse'
  cx: number
  cy: number
  rx: number
  ry: number
}

export type LineNode = NodeBase & {
  type: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
}

export type TextNode = NodeBase & {
  type: 'text'
  x: number
  y: number
  text: string
  fontSize: number
  fontFamily: string
  fontWeight: 'normal' | 'bold'
  fontStyle: 'normal' | 'italic'
  /**
   * When set, this is area text boxed in a frame (width×height).
   * Point text omits these (or width/height ≤ 0).
   */
  width?: number
  height?: number
}

/** Live polygon/star params — regenerate `d` when these change. */
export type PolygonPrimitive = {
  kind: 'polygon'
  cx: number
  cy: number
  radius: number
  sides: number
}

export type StarPrimitive = {
  kind: 'star'
  cx: number
  cy: number
  outerRadius: number
  innerRadius: number
  points: number
}

export type ShapePrimitive = PolygonPrimitive | StarPrimitive

export type PathNode = NodeBase & {
  type: 'path'
  d: string
  /** When set, path was created as a live polygon/star and stays editable. */
  primitive?: ShapePrimitive
}

export type ImageNode = NodeBase & {
  type: 'image'
  x: number
  y: number
  width: number
  height: number
  /** Data URL or absolute/blob URL for the raster. */
  href: string
}

export type GroupNode = NodeBase & {
  type: 'group'
  children: string[]
  x: number
  y: number
  /**
   * When true, first child is the clipping path; remaining children are clipped.
   * Illustrator-style clipping mask.
   */
  clipped?: boolean
  /**
   * Unbaked translate from a move, rendered as an SVG transform instead of
   * being written into every child's coordinates. Lets moving a huge group
   * (thousands of children) stay O(1) — the move only touches this node.
   * Anything that needs real child geometry (resize, pathfinder, direct
   * path edit, export, ...) must bake it first via `bakeGroupMove` in
   * geometry.ts, which clears this field back to absent.
   */
  pendingMove?: { dx: number; dy: number }
}

export type VecNode =
  | RectNode
  | EllipseNode
  | LineNode
  | TextNode
  | PathNode
  | ImageNode
  | GroupNode

/** Legacy / active-artboard size+bg sync field. */
export type Artboard = {
  width: number
  height: number
  background: string | null
}

export type ArtboardFrame = {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  background: string | null
}

export type DocSettings = {
  gridSize: number
  showGrid: boolean
  snapToGrid: boolean
  snapToNeighbors: boolean
  snapThreshold: number
}

export type VectorDocument = {
  version: 1
  name: string
  /** Synced from the active artboard for snap/export compatibility. */
  artboard: Artboard
  artboards: ArtboardFrame[]
  activeArtboardId: string
  settings: DocSettings
  nodes: Record<string, VecNode>
  /** Top-level draw order, bottom → top */
  zOrder: string[]
  /** Document color swatches (hex). */
  swatches: string[]
  /** User-placed ruler guides (persisted). */
  manualGuides: SnapGuide[]
}

export type SnapGuide = {
  orientation: 'vertical' | 'horizontal'
  position: number
}

export type BBox = {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_SHADOW: DropShadow = {
  enabled: false,
  dx: 2,
  dy: 2,
  blur: 4,
  color: '#000000',
  opacity: 0.35,
}

export const DEFAULT_STYLE: NodeStyle = {
  fill: paintSolid('#ffffff'),
  stroke: paintSolid('#000000'),
  strokeWidth: 1,
  strokeAlign: 'center',
  opacity: 1,
  strokeLinecap: 'butt',
  strokeLinejoin: 'miter',
  strokeDasharray: null,
  strokeArrow: false,
  blendMode: 'normal',
  shadow: { ...DEFAULT_SHADOW },
}

export function createArtboardFrame(
  partial?: Partial<ArtboardFrame> & Pick<ArtboardFrame, 'width' | 'height'>,
): ArtboardFrame {
  const id = partial?.id ?? `artboard-${Date.now()}`
  return {
    id,
    name: partial?.name ?? 'Artboard 1',
    x: partial?.x ?? 0,
    y: partial?.y ?? 0,
    width: partial?.width ?? 800,
    height: partial?.height ?? 600,
    background: partial?.background === undefined ? '#ffffff' : partial.background,
  }
}

export function createEmptyDocument(): VectorDocument {
  const frame = createArtboardFrame({ width: 800, height: 600 })
  return {
    version: 1,
    name: 'Untitled',
    artboard: {
      width: frame.width,
      height: frame.height,
      background: frame.background,
    },
    artboards: [frame],
    activeArtboardId: frame.id,
    settings: {
      gridSize: 16,
      showGrid: false,
      snapToGrid: true,
      snapToNeighbors: true,
      snapThreshold: 6,
    },
    nodes: {},
    zOrder: [],
    swatches: ['#ffffff', '#000000', '#808080', '#c0c0c0', '#ff0000', '#00ff00', '#0000ff', '#ffff00'],
    manualGuides: [],
  }
}

export function defaultStyle(): NodeStyle {
  return {
    fill: paintSolid('#ffffff'),
    stroke: paintSolid('#000000'),
    strokeWidth: 1,
    strokeAlign: 'center',
    opacity: 1,
    strokeLinecap: 'butt',
    strokeLinejoin: 'miter',
    strokeDasharray: null,
    strokeArrow: false,
    blendMode: 'normal',
    shadow: { ...DEFAULT_SHADOW },
  }
}

/** Point / area type defaults: black fill, no stroke. */
export function defaultTextStyle(): NodeStyle {
  return {
    fill: paintSolid('#000000'),
    stroke: paintNone(),
    strokeWidth: 0,
    strokeAlign: 'center',
    opacity: 1,
    strokeLinecap: 'butt',
    strokeLinejoin: 'miter',
    strokeDasharray: null,
    strokeArrow: false,
    blendMode: 'normal',
    shadow: { ...DEFAULT_SHADOW },
  }
}

function normalizeLinecap(raw: unknown): StrokeLinecap {
  return raw === 'round' || raw === 'square' ? raw : 'butt'
}

function normalizeLinejoin(raw: unknown): StrokeLinejoin {
  return raw === 'round' || raw === 'bevel' ? raw : 'miter'
}

export function normalizeNodeStyle(raw: unknown): NodeStyle {
  const base = defaultStyle()
  if (!raw || typeof raw !== 'object') return base
  const s = raw as Record<string, unknown>
  return {
    fill: normalizePaint(s.fill, base.fill),
    stroke: normalizePaint(s.stroke, base.stroke),
    strokeWidth:
      typeof s.strokeWidth === 'number' && Number.isFinite(s.strokeWidth)
        ? Math.max(0, s.strokeWidth)
        : base.strokeWidth,
    strokeAlign: normalizeStrokeAlign(s.strokeAlign),
    opacity:
      typeof s.opacity === 'number' && Number.isFinite(s.opacity)
        ? Math.max(0, Math.min(1, s.opacity))
        : base.opacity,
    strokeLinecap: normalizeLinecap(s.strokeLinecap),
    strokeLinejoin: normalizeLinejoin(s.strokeLinejoin),
    strokeDasharray:
      typeof s.strokeDasharray === 'string' && s.strokeDasharray.trim()
        ? s.strokeDasharray
        : null,
    strokeArrow: Boolean(s.strokeArrow),
    blendMode: normalizeBlendMode(s.blendMode),
    shadow: normalizeShadow(s.shadow),
  }
}

const BLEND_MODES: BlendMode[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
]

function normalizeBlendMode(raw: unknown): BlendMode {
  return typeof raw === 'string' && (BLEND_MODES as string[]).includes(raw)
    ? (raw as BlendMode)
    : 'normal'
}

function normalizeShadow(raw: unknown): DropShadow {
  const base = { ...DEFAULT_SHADOW }
  if (!raw || typeof raw !== 'object') return base
  const s = raw as Record<string, unknown>
  return {
    enabled: Boolean(s.enabled),
    dx: typeof s.dx === 'number' && Number.isFinite(s.dx) ? s.dx : base.dx,
    dy: typeof s.dy === 'number' && Number.isFinite(s.dy) ? s.dy : base.dy,
    blur:
      typeof s.blur === 'number' && Number.isFinite(s.blur) ? Math.max(0, s.blur) : base.blur,
    color: typeof s.color === 'string' && s.color ? s.color : base.color,
    opacity:
      typeof s.opacity === 'number' && Number.isFinite(s.opacity)
        ? Math.max(0, Math.min(1, s.opacity))
        : base.opacity,
  }
}

export function normalizeNode(node: VecNode): VecNode {
  const style = normalizeNodeStyle(node.style)
  if (node.type === 'text') {
    return {
      ...node,
      style,
      fontWeight: node.fontWeight === 'bold' ? 'bold' : 'normal',
      fontStyle: node.fontStyle === 'italic' ? 'italic' : 'normal',
      width:
        typeof node.width === 'number' && Number.isFinite(node.width) && node.width > 0
          ? node.width
          : undefined,
      height:
        typeof node.height === 'number' && Number.isFinite(node.height) && node.height > 0
          ? node.height
          : undefined,
    }
  }
  if (node.type === 'rect') {
    return {
      ...node,
      style,
      rx:
        typeof node.rx === 'number' && Number.isFinite(node.rx)
          ? Math.max(0, node.rx)
          : undefined,
    }
  }
  if (node.type === 'image') {
    return {
      ...node,
      style,
      width: Math.max(1, node.width),
      height: Math.max(1, node.height),
      href: typeof node.href === 'string' ? node.href : '',
    }
  }
  if (node.type === 'group') {
    return {
      ...node,
      style,
      clipped: Boolean(node.clipped),
      children: Array.isArray(node.children) ? node.children.filter((c) => typeof c === 'string') : [],
    }
  }
  if (node.type === 'path') {
    return {
      ...node,
      style,
      primitive: normalizePrimitive(node.primitive),
    }
  }
  return { ...node, style }
}

function normalizePrimitive(raw: unknown): ShapePrimitive | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  if (p.kind === 'polygon') {
    return {
      kind: 'polygon',
      cx: Number(p.cx) || 0,
      cy: Number(p.cy) || 0,
      radius: Math.max(1, Number(p.radius) || 1),
      sides: Math.max(3, Math.round(Number(p.sides) || 3)),
    }
  }
  if (p.kind === 'star') {
    return {
      kind: 'star',
      cx: Number(p.cx) || 0,
      cy: Number(p.cy) || 0,
      outerRadius: Math.max(1, Number(p.outerRadius) || 1),
      innerRadius: Math.max(0.5, Number(p.innerRadius) || 0.5),
      points: Math.max(3, Math.round(Number(p.points) || 3)),
    }
  }
  return undefined
}

/** Keep legacy `artboard` field in sync with the active frame. */
export function syncArtboardFromActive(doc: VectorDocument): VectorDocument {
  const active =
    doc.artboards.find((a) => a.id === doc.activeArtboardId) ?? doc.artboards[0]
  if (!active) return doc
  return {
    ...doc,
    activeArtboardId: active.id,
    artboard: {
      width: active.width,
      height: active.height,
      background: active.background,
    },
  }
}

/** Pasteboard padding around artboard frames (document units). */
export const PASTEBOARD_MARGIN = 200

/** Union bounds of all artboard frames (no pasteboard / objects). */
export function artboardFramesExtent(doc: VectorDocument): BBox {
  if (doc.artboards.length === 0) {
    return { x: 0, y: 0, width: doc.artboard.width, height: doc.artboard.height }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const a of doc.artboards) {
    minX = Math.min(minX, a.x)
    minY = Math.min(minY, a.y)
    maxX = Math.max(maxX, a.x + a.width)
    maxY = Math.max(maxY, a.y + a.height)
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/** Inflate a bbox by `margin` on every side. */
export function inflateBBox(box: BBox, margin: number): BBox {
  return {
    x: box.x - margin,
    y: box.y - margin,
    width: Math.max(1, box.width + margin * 2),
    height: Math.max(1, box.height + margin * 2),
  }
}
