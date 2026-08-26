export type ForegroundMask = { data: Uint8ClampedArray; width: number; height: number }

/**
 * Resolves per-pixel alpha from a raw foreground-confidence mask against a
 * threshold/feather pair, so stray low-confidence "islands" from the
 * matting model (common around hair/fine edges) can be tuned out without
 * re-running inference — only this cheap pixel pass needs to rerun as the
 * sliders move.
 *
 * Below `threshold - feather`: fully transparent. Above `threshold +
 * feather`: mask value passed through unchanged (preserves soft
 * antialiased edges instead of a hard cutout). In between: linearly ramped,
 * so raising the cutoff doesn't introduce a jagged edge.
 */
export function compositeForegroundMask(
  base: ImageData,
  mask: ForegroundMask,
  threshold: number,
  feather: number,
): ImageData {
  const { width, height } = base
  const out = new ImageData(new Uint8ClampedArray(base.data), width, height)
  const lo = Math.max(0, threshold - feather)
  const hi = Math.min(255, threshold + feather)
  const span = hi - lo || 1
  for (let i = 0; i < width * height; i++) {
    const m = mask.data[i] ?? 0
    const alpha = m <= lo ? 0 : m >= hi ? m : m * ((m - lo) / span)
    const idx = i * 4 + 3
    out.data[idx] = Math.min(out.data[idx]!, alpha)
  }
  return out
}
