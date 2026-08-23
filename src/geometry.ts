import type { BBox, GroupNode, VecNode, VectorDocument } from './types'
import {
  artboardFramesExtent,
  inflateBBox,
  PASTEBOARD_MARGIN,
} from './types'
import { pathBounds, scalePathD, translatePathD } from './ops/pathSvg'
import {
  pathFromPrimitive,
  scalePrimitive,
  translatePrimitive,
} from './ops/shapes'

export { artboardFramesExtent, PASTEBOARD_MARGIN } from './types'

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function nodeBBox(node: VecNode, doc: VectorDocument): BBox {
  switch (node.type) {
    case 'rect':
    case 'image':
      return normalizeBox(node.x, node.y, node.width, node.height)
    case 'ellipse':
      return {
        x: node.cx - node.rx,
        y: node.cy - node.ry,
        width: node.rx * 2,
        height: node.ry * 2,
      }
    case 'line': {
      const x = Math.min(node.x1, node.x2)
      const y = Math.min(node.y1, node.y2)
      return {
        x,
        y,
        width: Math.max(1, Math.abs(node.x2 - node.x1)),
        height: Math.max(1, Math.abs(node.y2 - node.y1)),
      }
    }
    case 'text': {
      if (node.width && node.height && node.width > 0 && node.height > 0) {
        return { x: node.x, y: node.y, width: node.width, height: node.height }
      }
      const w = Math.max(20, node.text.length * node.fontSize * 0.55)
      const h = node.fontSize * 1.2
      return { x: node.x, y: node.y - node.fontSize, width: w, height: h }
    }
    case 'path':
      return pathBBox(node.d)
    case 'group':
      return groupBBox(node, doc)
  }
}

function normalizeBox(x: number, y: number, w: number, h: number): BBox {
  const x2 = x + w
  const y2 = y + h
  const nx = Math.min(x, x2)
  const ny = Math.min(y, y2)
  return {
    x: nx,
    y: ny,
    width: Math.max(1, Math.abs(w)),
    height: Math.max(1, Math.abs(h)),
  }
}

export function pathBBox(d: string): BBox {
  return pathBounds(d) ?? { x: 0, y: 0, width: 1, height: 1 }
}

function groupBBox(group: GroupNode, doc: VectorDocument): BBox {
  const boxes = group.children
    .map((id) => doc.nodes[id])
    .filter(Boolean)
    .map((n) => nodeBBox(n, doc))
  if (boxes.length === 0) {
    return { x: group.x, y: group.y, width: 1, height: 1 }
  }
  return unionBoxes(boxes)
}

export function unionBoxes(boxes: BBox[]): BBox {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  }
}

/**
 * Editor canvas extent: artboard union + fixed pasteboard margin.
 * Intentionally does NOT grow with object bounds — dynamic growth made the
 * SVG (`extent * zoom`) hit browser size limits and capped zoom-in.
 */
export function documentExtent(doc: VectorDocument): BBox {
  return inflateBBox(artboardFramesExtent(doc), PASTEBOARD_MARGIN)
}

export function selectionBBox(ids: string[], doc: VectorDocument): BBox | null {
  const boxes = ids
    .map((id) => doc.nodes[id])
    .filter((n): n is VecNode => Boolean(n) && n.visible)
    .map((n) => nodeBBox(n, doc))
  if (boxes.length === 0) return null
  return unionBoxes(boxes)
}

export function normalizeMarquee(x0: number, y0: number, x1: number, y1: number): BBox {
  const x = Math.min(x0, x1)
  const y = Math.min(y0, y1)
  return {
    x,
    y,
    width: Math.max(0, Math.abs(x1 - x0)),
    height: Math.max(0, Math.abs(y1 - y0)),
  }
}

export function boxesIntersect(a: BBox, b: BBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

/**
 * Marquee hit test — objects that intersect the selection rectangle.
 */
export function idsInMarquee(
  doc: VectorDocument,
  marquee: BBox,
  opts: {
    /** `select` = top-level only; `direct` = leaf nodes (skip groups). */
    mode: 'select' | 'direct'
  },
): string[] {
  const hit = (box: BBox) => boxesIntersect(marquee, box)

  if (opts.mode === 'select') {
    return doc.zOrder.filter((id) => {
      const n = doc.nodes[id]
      if (!n || !n.visible) return false
      return hit(nodeBBox(n, doc))
    })
  }

  return Object.values(doc.nodes)
    .filter((n) => n.visible && n.type !== 'group')
    .filter((n) => hit(nodeBBox(n, doc)))
    .map((n) => n.id)
}

export function translateNode(node: VecNode, dx: number, dy: number): VecNode {
  switch (node.type) {
    case 'rect':
    case 'image':
      return { ...node, x: round2(node.x + dx), y: round2(node.y + dy) }
    case 'ellipse':
      return { ...node, cx: round2(node.cx + dx), cy: round2(node.cy + dy) }
    case 'line':
      return {
        ...node,
        x1: round2(node.x1 + dx),
        y1: round2(node.y1 + dy),
        x2: round2(node.x2 + dx),
        y2: round2(node.y2 + dy),
      }
    case 'text':
      return { ...node, x: round2(node.x + dx), y: round2(node.y + dy) }
    case 'path': {
      if (node.primitive) {
        const primitive = translatePrimitive(node.primitive, dx, dy)
        return {
          ...node,
          primitive,
          d: pathFromPrimitive(primitive),
        }
      }
      return { ...node, d: translatePathD(node.d, dx, dy) }
    }
    case 'group':
      return { ...node, x: round2(node.x + dx), y: round2(node.y + dy) }
  }
}

export function scaleNodeFromBox(
  node: VecNode,
  oldBox: BBox,
  newBox: BBox,
): VecNode {
  const sx = newBox.width / oldBox.width
  const sy = newBox.height / oldBox.height
  const mapX = (x: number) => round2(newBox.x + (x - oldBox.x) * sx)
  const mapY = (y: number) => round2(newBox.y + (y - oldBox.y) * sy)

  switch (node.type) {
    case 'rect':
    case 'image':
      return {
        ...node,
        x: mapX(node.x),
        y: mapY(node.y),
        width: round2(Math.max(1, Math.abs(node.width * sx))),
        height: round2(Math.max(1, Math.abs(node.height * sy))),
      }
    case 'ellipse':
      return {
        ...node,
        cx: mapX(node.cx),
        cy: mapY(node.cy),
        rx: round2(Math.max(0.5, Math.abs(node.rx * sx))),
        ry: round2(Math.max(0.5, Math.abs(node.ry * sy))),
      }
    case 'line':
      return {
        ...node,
        x1: mapX(node.x1),
        y1: mapY(node.y1),
        x2: mapX(node.x2),
        y2: mapY(node.y2),
      }
    case 'text':
      return {
        ...node,
        x: mapX(node.x),
        y: mapY(node.y),
        fontSize: round2(Math.max(4, Math.abs(node.fontSize * sy))),
        ...(node.width && node.height
          ? {
              width: round2(Math.max(8, Math.abs(node.width * sx))),
              height: round2(Math.max(8, Math.abs(node.height * sy))),
            }
          : {}),
      }
    case 'path': {
      if (node.primitive) {
        const primitive = scalePrimitive(node.primitive, mapX, mapY, sx, sy)
        return {
          ...node,
          primitive,
          d: pathFromPrimitive(primitive),
        }
      }
      return { ...node, d: scalePathD(node.d, oldBox, sx, sy, newBox) }
    }
    case 'group':
      return { ...node, x: mapX(node.x), y: mapY(node.y) }
  }
}

export function setNodeRotation(node: VecNode, rotation: number): VecNode {
  return { ...node, rotation: round2(rotation) }
}

/** Parent id if node is inside a group, else null */
export function parentOf(id: string, doc: VectorDocument): string | null {
  for (const n of Object.values(doc.nodes)) {
    if (n.type === 'group' && n.children.includes(id)) return n.id
  }
  return null
}

/**
 * O(1)-lookup version of `parentOf` for hot paths (e.g. per-pointermove
 * during a drag) — `parentOf` itself is O(n) per call and shouldn't be
 * called in a loop over many nodes. Build once per gesture, not per event.
 */
export function buildParentIndex(doc: VectorDocument): Map<string, string> {
  const index = new Map<string, string>()
  for (const n of Object.values(doc.nodes)) {
    if (n.type === 'group') {
      for (const childId of n.children) index.set(childId, n.id)
    }
  }
  return index
}

export function topLevelIds(doc: VectorDocument): string[] {
  return doc.zOrder.filter((id) => doc.nodes[id])
}

export function collectDescendants(id: string, doc: VectorDocument): string[] {
  const node = doc.nodes[id]
  if (!node) return []
  if (node.type !== 'group') return [id]
  return [id, ...node.children.flatMap((c) => collectDescendants(c, doc))]
}
