import type { VecNode, VectorDocument } from '../types'

export type FlatLayerRow = { node: VecNode; depth: number }

/** Groups larger than this default to collapsed unless the user has explicitly toggled them. */
export const AUTO_COLLAPSE_THRESHOLD = 50

/** Whether a group row is expanded — explicit user choice wins, else auto-collapse if huge. */
export function isLayerRowOpen(node: VecNode, collapsed: Record<string, boolean>): boolean {
  if (node.type !== 'group') return false
  if (node.id in collapsed) return !collapsed[node.id]
  return node.children.length <= AUTO_COLLAPSE_THRESHOLD
}

/**
 * Flattens the layer tree (front-to-back, respecting collapse state) into a
 * linear list so the panel can be windowed/virtualized — required for large
 * documents (e.g. thousands of traced SVG paths in one group), since
 * windowing needs simple index math over a flat array.
 */
export function flattenLayerRows(
  doc: VectorDocument,
  collapsed: Record<string, boolean>,
): FlatLayerRow[] {
  const out: FlatLayerRow[] = []
  const walk = (id: string, depth: number) => {
    const node = doc.nodes[id]
    if (!node) return
    out.push({ node, depth })
    if (node.type === 'group' && isLayerRowOpen(node, collapsed)) {
      for (const cid of [...node.children].reverse()) walk(cid, depth + 1)
    }
  }
  for (const id of [...doc.zOrder].reverse()) walk(id, 0)
  return out
}
