import type { BBox } from '../types'
import { parsePathItem } from './paperUtils'
import paper from 'paper'

export { parsePathItem } from './paperUtils'

export function pathBounds(d: string): BBox | null {
  const item = parsePathItem(d)
  if (!item) return null
  const b = item.bounds
  const box: BBox = {
    x: b.x,
    y: b.y,
    width: Math.max(1, b.width),
    height: Math.max(1, b.height),
  }
  item.remove()
  return box
}

/**
 * True only if `d` uses exclusively absolute M/L/C/Z commands — no relative
 * commands (including Paper.js's own lowercase `c`/`z`/`l` output from
 * boolean ops), no arcs, no H/V/S/Q/T shorthand. When true, every number in
 * the path is an (x, y) coordinate pair with no other meaning, so a plain
 * translate can shift them directly.
 */
function isSimpleAbsolutePath(d: string): boolean {
  return !/[HhVvSsQqTtAamlcz]/.test(d)
}

const SIMPLE_CMD_RE = /([MLCZ])([^MLCZ]*)/g
const SIMPLE_NUM_RE = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/g

/** Fast path for `translatePathD` — see `isSimpleAbsolutePath`. */
function translateSimplePathD(d: string, dx: number, dy: number): string {
  let out = ''
  SIMPLE_CMD_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SIMPLE_CMD_RE.exec(d))) {
    const cmd = match[1]
    if (cmd === 'Z') {
      out += 'Z '
      continue
    }
    const nums = (match[2].match(SIMPLE_NUM_RE) ?? []).map(Number)
    out += `${cmd} `
    for (let i = 0; i + 1 < nums.length; i += 2) {
      out += `${round2(nums[i] + dx)} ${round2(nums[i + 1] + dy)} `
    }
  }
  return out.trim()
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Translate an SVG path. Every path this app generates itself (pen/pencil,
 * boolean/offset/scissors ops, traced imports) either matches the simple
 * absolute-only fast path above, or — for Paper.js's own boolean-op output,
 * which mixes an absolute first move with relative curves — falls through
 * to Paper so relative cmds / arcs / compounds stay intact. (Naive
 * number-pair rewriting across the board breaks Paper.js pathfinder output,
 * since it doesn't distinguish relative deltas from absolute coordinates.)
 */
export function translatePathD(d: string, dx: number, dy: number): string {
  if (!dx && !dy) return d
  if (isSimpleAbsolutePath(d)) return translateSimplePathD(d, dx, dy)
  const item = parsePathItem(d)
  if (!item) return d
  item.translate(new paper.Point(dx, dy))
  const out = item.pathData
  item.remove()
  return out
}

/** Scale path from oldBox → newBox via Paper. */
export function scalePathD(
  d: string,
  oldBox: BBox,
  sx: number,
  sy: number,
  newBox: BBox,
): string {
  const item = parsePathItem(d)
  if (!item) return d
  item.translate(new paper.Point(-oldBox.x, -oldBox.y))
  item.scale(sx, sy, new paper.Point(0, 0))
  item.translate(new paper.Point(newBox.x, newBox.y))
  const out = item.pathData
  item.remove()
  return out
}

/** Re-parse and re-export path data so boolean results are stable for later edits. */
export function normalizePathD(d: string): string {
  const item = parsePathItem(d)
  if (!item) return d
  item.applyMatrix = true
  const out = item.pathData
  item.remove()
  return out
}
