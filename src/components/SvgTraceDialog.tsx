import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDocStore } from '../store/documentStore'
import { useTitleBarDrag } from '../hooks/useTitleBarDrag'
import { rgbToHex } from '../color/colorMath'
import {
  buildImageTracerOptions,
  buildPlacementMatrix,
  decodeImageData,
  defaultTraceUiOptions,
  parseTracedSvg,
  SvgTraceWorkerClient,
  transformPathD,
  type TraceUiOptions,
} from '../image/svgTrace'
import { IconButton } from './Icon'

const TRACE_DEBOUNCE_MS = 300

/** Draggable modal: tune imagetracerjs options against a live worker-rendered preview. */
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
    const { requestId, result } = client.trace(buildImageTracerOptions(uiRef.current))
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
                <span>Colors</span>
                <input
                  type="range"
                  min={2}
                  max={48}
                  step={1}
                  value={ui.numberOfColors}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, numberOfColors: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.numberOfColors}</em>
              </label>
            </div>

            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Shape</h3>
              <label className="field-inline">
                <span>{ui.splitDetail ? 'Curves' : 'Detail'}</span>
                <input
                  type="range"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={ui.detail}
                  onChange={(e) => setUi((u) => ({ ...u, detail: Number(e.target.value) }))}
                />
                <em className="field-inline__val">{ui.detail.toFixed(1)}</em>
              </label>
              <label className="field-inline">
                <span>Ignore</span>
                <input
                  type="range"
                  min={0}
                  max={64}
                  step={1}
                  value={ui.pathOmit}
                  onChange={(e) => setUi((u) => ({ ...u, pathOmit: Number(e.target.value) }))}
                />
                <em className="field-inline__val">{ui.pathOmit}px</em>
              </label>
              <label className="svg-trace-modal__checkbox">
                <input
                  type="checkbox"
                  checked={ui.rightAngleEnhance}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, rightAngleEnhance: e.target.checked }))
                  }
                />
                <span>Enhance right angles</span>
              </label>
            </div>

            <div className="svg-trace-modal__group">
              <h3 className="svg-trace-modal__group-title">Cleanup</h3>
              <label className="field-inline">
                <span>Blur</span>
                <input
                  type="range"
                  min={0}
                  max={5}
                  step={1}
                  value={ui.blurRadius}
                  onChange={(e) => setUi((u) => ({ ...u, blurRadius: Number(e.target.value) }))}
                />
                <em className="field-inline__val">{ui.blurRadius}</em>
              </label>
            </div>

            <details className="svg-trace-modal__group svg-trace-modal__group--advanced">
              <summary>Advanced</summary>
              <label className="field-inline">
                <span>Palette</span>
                <select
                  value={ui.colorSampling}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, colorSampling: Number(e.target.value) }))
                  }
                >
                  <option value={2}>Perceptual</option>
                  <option value={0}>Deterministic</option>
                  <option value={1}>Random</option>
                </select>
              </label>
              <label className="svg-trace-modal__checkbox">
                <input
                  type="checkbox"
                  checked={ui.splitDetail}
                  onChange={(e) => setUi((u) => ({ ...u, splitDetail: e.target.checked }))}
                />
                <span>Separate corner detail</span>
              </label>
              {ui.splitDetail && (
                <label className="field-inline">
                  <span>Corners</span>
                  <input
                    type="range"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={ui.detailQ}
                    onChange={(e) => setUi((u) => ({ ...u, detailQ: Number(e.target.value) }))}
                  />
                  <em className="field-inline__val">{ui.detailQ.toFixed(1)}</em>
                </label>
              )}
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
              <label className="field-inline">
                <span>Passes</span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={ui.colorQuantCycles}
                  onChange={(e) =>
                    setUi((u) => ({ ...u, colorQuantCycles: Number(e.target.value) }))
                  }
                />
                <em className="field-inline__val">{ui.colorQuantCycles}</em>
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
