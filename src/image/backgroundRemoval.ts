import { segmentForeground } from '@imgly/background-removal'
import type { BgRemovalModel } from './bgRemovalModels'
import type { ForegroundMask } from './maskComposite'

/**
 * Runs foreground/background segmentation only — returns the raw per-pixel
 * confidence mask (0-255, one byte per pixel) rather than a finished
 * cutout. Kept separate from compositing (see maskComposite.ts) so the
 * threshold/feather sliders in SvgTraceDialog can be dragged live without
 * re-running inference, which is the expensive step.
 *
 * Runs entirely client-side via WASM/onnxruntime-web. Model weights are
 * fetched from IMG.LY's CDN on first use per tier and cached by the browser
 * afterward — the underlying `@imgly/background-removal-data` package is
 * 200MB+ unpacked, too large to vendor the way vtracer's wasm is vendored in
 * src/vendor. Image pixels themselves never leave the browser; only the
 * model weights come from the CDN.
 */
export async function computeForegroundMask(
  href: string,
  model: BgRemovalModel,
  onProgress?: (fraction: number) => void,
): Promise<ForegroundMask> {
  const blob = await segmentForeground(href, {
    device: 'cpu',
    model,
    proxyToWorker: true,
    output: { format: 'image/png' },
    progress: (_key, current, total) => {
      if (total > 0) onProgress?.(current / total)
    },
  })
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context unavailable')
  ctx.drawImage(bitmap, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  const mask = new Uint8ClampedArray(width * height)
  for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3]!
  return { data: mask, width, height }
}
