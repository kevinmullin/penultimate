import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDocStore } from '../store/documentStore'
import { useTitleBarDrag } from '../hooks/useTitleBarDrag'
import { rgbToHex } from '../color/colorMath'
import {
  buildPlacementMatrix,
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

  const clientRef = useRef<SvgTraceWorkerClient | null>(null)
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null)
  const latestRequestId = useRef(0)

  const node = nodeId ? doc.nodes[nodeId] : null
  const imageNode = node && node.type === 'image' ? node : null

  // Reset options + panel position each time the dialog opens for a node.
  useEffect(() => {
    if (!nodeId) return
    setUi(defaultTraceUiOptions())
    reset(null)
  }, [nodeId, reset])

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

  // Blob URL for the preview <img> — avoids dangerouslySetInnerHTML.
  useEffect(() => {
    if (!svgPreview) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(new Blob([svgPreview], { type: 'image/svg+xml' }))
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [svgPreview])

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
                <span>Precision</span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={ui.colorPrecision}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, colorPrecision: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.colorPrecision}</em>
              </label>
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
                <span>Corners</span>
                <input
                  type="range"
                  min={0}
                  max={180}
                  step={1}
                  value={ui.cornerThreshold}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, cornerThreshold: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.cornerThreshold}°</em>
              </label>
              <label className="field-inline">
                <span>Ignore</span>
                <input
                  type="range"
                  min={0}
                  max={64}
                  step={1}
                  value={ui.filterSpeckle}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, filterSpeckle: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.filterSpeckle}px</em>
              </label>
            </div>

            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Cleanup</h3>
              <label className="field-inline">
                <span>Simplify</span>
                <input
                  type="range"
                  min={0}
                  max={2.5}
                  step={0.1}
                  value={ui.simplify}
                  onChange={(e) => setUi((u) => ({ ...u, simplify: Number(e.target.value) }))}
                />
                <em className="field-inline__val">{ui.simplify === 0 ? 'off' : ui.simplify.toFixed(1)}</em>
              </label>
            </div>

            <details className="svg-trace-modal__group svg-trace-modal__group--advanced">
              <summary>Advanced</summary>
              <label className="field-inline">
                <span>Gradient step</span>
                <input
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={ui.layerDifference}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, layerDifference: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.layerDifference}</em>
              </label>
              <label className="field-inline">
                <span>Segment length</span>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={0.5}
                  value={ui.lengthThreshold}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, lengthThreshold: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.lengthThreshold}px</em>
              </label>
              <label className="field-inline">
                <span>Splice angle</span>
                <input
                  type="range"
                  min={0}
                  max={180}
                  step={1}
                  value={ui.spliceThreshold}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, spliceThreshold: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.spliceThreshold}°</em>
              </label>
              <label className="field-inline">
                <span>Stroke</span>
                <input
                  type="range"
                  min={0}
                  max={3}
                  step={0.5}
                  value={ui.strokeWidth}
                  onChange={(e) => setUi((u) => ({ ...u, strokeWidth: Number(e.target.value) }))}
                />
                <em className="field-inline__val">{ui.strokeWidth}</em>
              </label>
            </details>
          </div>

          <div className="svg-trace-modal__preview">
            {previewUrl && <img src={previewUrl} alt="Traced SVG preview" />}
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
