import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useDocStore } from '../store/documentStore'
import { useTitleBarDrag } from '../hooks/useTitleBarDrag'
import { rgbToHex } from '../color/colorMath'
import {
  buildPlacementMatrix,
  buildPreviewSvg,
  buildVtracerOptions,
  decodeImageData,
  defaultTraceUiOptions,
  parseTracedSvg,
  SvgTraceWorkerClient,
  transformPathD,
  type TraceUiOptions,
} from '../image/svgTrace'
import { IconButton } from './Icon'

const TRACE_DEBOUNCE_MS = 300

/** Round to the same decimal precision as `step` (avoids float drift from repeated +/- clicks). */
function roundToStep(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** A range slider with -/+ stepper buttons and a live value readout. */
function TraceSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, roundToStep(v, step)))
  return (
    <label className="field-inline trace-slider">
      <span>{label}</span>
      <button
        type="button"
        className="trace-slider__step"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
      />
      <button
        type="button"
        className="trace-slider__step"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        +
      </button>
      <em className="field-inline__val">{format ? format(value) : value}</em>
    </label>
  )
}

/** Draggable modal: tune vtracer options against a live worker-rendered preview. */
export function SvgTraceDialog() {
  const nodeId = useDocStore((s) => s.svgTraceNodeId)
  const setSvgTraceNodeId = useDocStore((s) => s.setSvgTraceNodeId)
  const commitSvgTrace = useDocStore((s) => s.commitSvgTrace)
  const doc = useDocStore((s) => s.doc)
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const { pos, reset, titleBarProps } = useTitleBarDrag()

  const [ui, setUi] = useState<TraceUiOptions>(defaultTraceUiOptions)
  const uiRef = useRef(ui)
  uiRef.current = ui

  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [svgPreview, setSvgPreview] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /** Reveal-slider position (0-100): how much of the traced result shows over the original. */
  const [reveal, setReveal] = useState(50)
  const compareRef = useRef<HTMLDivElement>(null)

  const clientRef = useRef<SvgTraceWorkerClient | null>(null)
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null)
  const latestRequestId = useRef(0)

  const node = nodeId ? doc.nodes[nodeId] : null
  const imageNode = node && node.type === 'image' ? node : null

  // Reset options + panel position each time the dialog opens for a node.
  useEffect(() => {
    if (!nodeId) return
    setUi(defaultTraceUiOptions())
    setReveal(50)
    reset(null)
  }, [nodeId, reset])

  const updateRevealFromClientX = useCallback((clientX: number) => {
    const el = compareRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return
    const pct = ((clientX - rect.left) / rect.width) * 100
    setReveal(Math.min(100, Math.max(0, pct)))
  }, [])

  const beginRevealDrag = (e: ReactPointerEvent) => {
    e.preventDefault()
    updateRevealFromClientX(e.clientX)
    const onMove = (ev: PointerEvent) => updateRevealFromClientX(ev.clientX)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Decode the source raster and hand it to a fresh worker for this session.
  useEffect(() => {
    if (!nodeId) return
    const src = useDocStore.getState().doc.nodes[nodeId]
    if (!src || src.type !== 'image') return

    let cancelled = false
    setReady(false)
    setBusy(true)
    setError(null)
    setSvgPreview(null)
    naturalSizeRef.current = null

    const client = new SvgTraceWorkerClient()
    clientRef.current = client

    decodeImageData(src.href)
      .then(({ imageData, naturalWidth, naturalHeight }) => {
        if (cancelled) return
        naturalSizeRef.current = { w: naturalWidth, h: naturalHeight }
        return client.load(imageData)
      })
      .then(() => {
        if (cancelled) return
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      client.destroy()
      clientRef.current = null
    }
  }, [nodeId])

  const runTrace = useCallback(() => {
    const client = clientRef.current
    if (!client) return
    setBusy(true)
    setError(null)
    const { requestId, result } = client.trace(buildVtracerOptions(uiRef.current))
    latestRequestId.current = requestId
    result
      .then((svg) => {
        if (latestRequestId.current !== requestId) return
        setSvgPreview(svg)
        setBusy(false)
      })
      .catch((err: unknown) => {
        if (latestRequestId.current !== requestId) return
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      })
  }, [])

  // Debounced (re)trace whenever the worker is ready or options change.
  useEffect(() => {
    if (!ready) return
    const t = window.setTimeout(runTrace, TRACE_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [ui, ready, runTrace])

  // Blob URL for the preview <img> — avoids dangerouslySetInnerHTML. Goes
  // through buildPreviewSvg so what's shown here (including the stroke
  // overlay, which vtracer itself never emits) is pixel-for-pixel what
  // `apply()` below actually places on the canvas.
  useEffect(() => {
    if (!svgPreview) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(
      new Blob([buildPreviewSvg(svgPreview, ui.strokeWidth)], { type: 'image/svg+xml' }),
    )
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [svgPreview, ui.strokeWidth])

  const pathCount = useMemo(
    () => (svgPreview ? (svgPreview.match(/<path /g) ?? []).length : 0),
    [svgPreview],
  )

  const close = useCallback(() => setSvgTraceNodeId(null), [setSvgTraceNodeId])

  useEffect(() => {
    if (!nodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    panelRef.current?.querySelector<HTMLElement>('input, button')?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [nodeId, close])

  const apply = () => {
    if (!svgPreview || !imageNode || !naturalSizeRef.current) return
    const parsed = parseTracedSvg(svgPreview)
    if (parsed.length === 0) return
    const xform = buildPlacementMatrix(
      imageNode,
      naturalSizeRef.current.w,
      naturalSizeRef.current.h,
    )
    const paths = parsed.map((p) => {
      const hex = rgbToHex(p.r, p.g, p.b)
      return {
        d: transformPathD(p.d, xform),
        fillHex: hex,
        strokeHex: hex,
        strokeWidth: ui.strokeWidth,
        opacity: p.opacity,
      }
    })
    commitSvgTrace(imageNode.id, paths)
    close()
  }

  if (!nodeId || !imageNode) return null

  const canApply = !busy && !error && Boolean(svgPreview) && pathCount > 0

  return createPortal(
    <div
      className="settings-modal"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        className="settings-modal__panel svg-trace-modal__panel"
        data-drag-panel
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={pos ? { position: 'fixed', left: pos.left, top: pos.top, margin: 0 } : undefined}
      >
        <div className="settings-modal__header" {...titleBarProps}>
          <h2 id={titleId} className="settings-modal__title">
            Convert to SVG
          </h2>
          <IconButton icon="cancel" label="Cancel" onClick={close} />
        </div>

        <div className="settings-modal__body svg-trace-modal__body">
          <div className="svg-trace-modal__controls">
            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Color</h3>
              <label className="field-inline">
                <span>Mode</span>
                <select
                  value={ui.clustering}
                  onChange={(e) =>
                    setUi((u) => ({
                      ...u,
                      clustering: e.target.value as TraceUiOptions['clustering'],
                    }))
                  }
                >
                  <option value="color-cluster">Color cluster</option>
                  <option value="bw">Black &amp; white</option>
                  <option value="watershed">Watershed</option>
                </select>
              </label>

              {ui.clustering === 'color-cluster' && (
                <>
                  <TraceSlider
                    label="Precision"
                    value={ui.colorPrecision}
                    min={1}
                    max={8}
                    step={1}
                    onChange={(v) => setUi((u) => ({ ...u, colorPrecision: v }))}
                  />
                  <TraceSlider
                    label="Gradient step"
                    value={ui.layerDifference}
                    min={0}
                    max={255}
                    step={1}
                    onChange={(v) => setUi((u) => ({ ...u, layerDifference: v }))}
                  />
                </>
              )}

              {ui.clustering === 'bw' && (
                <>
                  <label className="svg-trace-modal__checkbox">
                    <input
                      type="checkbox"
                      checked={ui.adaptive}
                      onChange={(e) => setUi((u) => ({ ...u, adaptive: e.target.checked }))}
                    />
                    <span>Adaptive threshold</span>
                  </label>
                  {/* Fixed threshold and adaptive tuning are mutually exclusive
                      in vtracer (binaryThreshold is ignored once adaptive is
                      on) — only show whichever one is actually in effect. */}
                  {!ui.adaptive && (
                    <TraceSlider
                      label="Threshold"
                      value={ui.binaryThreshold}
                      min={0}
                      max={255}
                      step={1}
                      onChange={(v) => setUi((u) => ({ ...u, binaryThreshold: v }))}
                    />
                  )}
                  {ui.adaptive && (
                    <>
                      <TraceSlider
                        label="Adapt window"
                        value={ui.adaptiveWindow}
                        min={0}
                        max={400}
                        step={2}
                        format={(v) => (v === 0 ? 'auto' : `${v}px`)}
                        onChange={(v) => setUi((u) => ({ ...u, adaptiveWindow: v }))}
                      />
                      <TraceSlider
                        label="Adapt sensitivity"
                        value={ui.adaptiveT}
                        min={1}
                        max={50}
                        step={1}
                        format={(v) => `${v}%`}
                        onChange={(v) => setUi((u) => ({ ...u, adaptiveT: v }))}
                      />
                    </>
                  )}
                </>
              )}

              {ui.clustering === 'watershed' && (
                <TraceSlider
                  label="Detail"
                  value={ui.watershedDetail}
                  min={0}
                  max={255}
                  step={1}
                  onChange={(v) => setUi((u) => ({ ...u, watershedDetail: v }))}
                />
              )}

              <TraceSlider
                label="Max colors"
                value={ui.maxColors}
                min={0}
                max={256}
                step={1}
                format={(v) => (v === 0 ? 'off' : String(v))}
                onChange={(v) => setUi((u) => ({ ...u, maxColors: v }))}
              />
            </div>

            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Shape</h3>
              <label className="field-inline">
                <span>Fit</span>
                <select
                  value={ui.mode}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, mode: e.target.value as TraceUiOptions['mode'] }))
                  }
                >
                  <option value="spline">Curves</option>
                  <option value="polygon">Polygon</option>
                  <option value="pixel">Pixel</option>
                </select>
              </label>
              <label className="field-inline">
                <span>Layering</span>
                <select
                  value={ui.hierarchical}
                  onChange={(e) =>
                    setUi((u) => ({
                      ...u,
                      hierarchical: e.target.value as TraceUiOptions['hierarchical'],
                    }))
                  }
                >
                  <option value="stacked">Stacked</option>
                  <option value="cutout">Seam-free cutout</option>
                </select>
              </label>
              <TraceSlider
                label="Ignore"
                value={ui.filterSpeckle}
                min={0}
                max={128}
                step={1}
                format={(v) => `${v}px`}
                onChange={(v) => setUi((u) => ({ ...u, filterSpeckle: v }))}
              />

              {ui.mode === 'spline' && (
                <>
                  <TraceSlider
                    label="Corners"
                    value={ui.cornerThreshold}
                    min={0}
                    max={180}
                    step={1}
                    format={(v) => `${v}°`}
                    onChange={(v) => setUi((u) => ({ ...u, cornerThreshold: v }))}
                  />
                  <TraceSlider
                    label="Segment length"
                    value={ui.lengthThreshold}
                    min={3.5}
                    max={10}
                    step={0.5}
                    format={(v) => `${v}px`}
                    onChange={(v) => setUi((u) => ({ ...u, lengthThreshold: v }))}
                  />
                  <TraceSlider
                    label="Splice angle"
                    value={ui.spliceThreshold}
                    min={0}
                    max={180}
                    step={1}
                    format={(v) => `${v}°`}
                    onChange={(v) => setUi((u) => ({ ...u, spliceThreshold: v }))}
                  />
                  <TraceSlider
                    label="Max iterations"
                    value={ui.maxIterations}
                    min={1}
                    max={50}
                    step={1}
                    onChange={(v) => setUi((u) => ({ ...u, maxIterations: v }))}
                  />
                </>
              )}
            </div>

            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Cleanup</h3>
              {ui.mode === 'spline' && (
                <TraceSlider
                  label="Simplify"
                  value={ui.simplify}
                  min={0}
                  max={2.5}
                  step={0.1}
                  format={(v) => (v === 0 ? 'off' : v.toFixed(1))}
                  onChange={(v) => setUi((u) => ({ ...u, simplify: v }))}
                />
              )}
              <TraceSlider
                label="Path precision"
                value={ui.pathPrecision}
                min={0}
                max={6}
                step={1}
                format={(v) => `${v}dp`}
                onChange={(v) => setUi((u) => ({ ...u, pathPrecision: v }))}
              />
            </div>

            <details className="svg-trace-modal__group svg-trace-modal__group--advanced">
              <summary>Advanced</summary>
              <label className="field-inline">
                <span>Palette</span>
                <input
                  type="text"
                  placeholder="#112233, #445566…"
                  value={ui.palette}
                  onChange={(e) => setUi((u) => ({ ...u, palette: e.target.value }))}
                />
              </label>
              <TraceSlider
                label="Stroke"
                value={ui.strokeWidth}
                min={0}
                max={3}
                step={0.5}
                onChange={(v) => setUi((u) => ({ ...u, strokeWidth: v }))}
              />
            </details>
          </div>

          <div className="svg-trace-modal__preview">
            {previewUrl && (
              <div
                ref={compareRef}
                className="svg-trace-compare"
                onPointerDown={beginRevealDrag}
              >
                <img
                  className="svg-trace-compare__base"
                  src={imageNode.href}
                  alt="Original"
                  draggable={false}
                />
                <div
                  className="svg-trace-compare__overlay"
                  style={{ clipPath: `inset(0 ${100 - reveal}% 0 0)` }}
                >
                  <img src={previewUrl} alt="Traced SVG preview" draggable={false} />
                </div>
                <div className="svg-trace-compare__handle" style={{ left: `${reveal}%` }}>
                  <div className="svg-trace-compare__grip" />
                </div>
              </div>
            )}
            {busy && <div className="svg-trace-modal__busy">Tracing…</div>}
            {error && (
              <div className="svg-trace-modal__busy svg-trace-modal__busy--error">{error}</div>
            )}
            {!busy && !error && pathCount > 0 && (
              <div className="svg-trace-modal__caption">
                {pathCount} shape{pathCount === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </div>

        <div className="settings-modal__footer">
          <button type="button" className="ghost-btn" onClick={close}>
            Cancel
          </button>
          <button type="button" className="primary-btn" disabled={!canApply} onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
