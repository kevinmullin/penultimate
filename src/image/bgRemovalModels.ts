/**
 * Model choice metadata lives in its own module (not backgroundRemoval.ts,
 * which pulls in @imgly/background-removal) so SvgTraceDialog can import the
 * label list statically without defeating the dynamic import that keeps the
 * segmentation library out of the main bundle until "Remove background" is
 * actually used.
 */

/** The three precision tiers of IMG.LY's ISNet segmentation model. */
export type BgRemovalModel = 'isnet_quint8' | 'isnet_fp16' | 'isnet'

export const BG_REMOVAL_MODELS: {
  value: BgRemovalModel
  label: string
  description: string
}[] = [
  { value: 'isnet_quint8', label: 'Fast', description: 'Quantized int8, ~40MB — best on CPU' },
  { value: 'isnet_fp16', label: 'Balanced', description: 'Half precision, ~80MB' },
  { value: 'isnet', label: 'Best quality', description: 'Full precision, ~176MB — slowest' },
]
