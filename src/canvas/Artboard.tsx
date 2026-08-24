import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { defaultStyle, defaultTextStyle, nextId, snapPoint, useDocStore } from '../store/documentStore'
import { paintNone } from '../style/paint'
import {
  artboardFramesExtent,
  buildParentIndex,
  documentExtent,
  nodeBBox,
  parentOf,
  selectionBBox,
  idsInMarquee,
  normalizeMarquee,
} from '../geometry'
import { ToolCursorOverlay } from './ToolCursorOverlay'
import { GradientDefs } from './GradientDefs'
import { NodeView, isCreateTool } from './NodeViews'
import { PathAnchorOverlay } from './PathAnchorOverlay'
import { SelectionOverlay } from './SelectionOverlay'
import { snapBBox } from './snap'
import { TextEditOverlay } from './TextEditOverlay'
import { Rulers } from '../components/Rulers'
import { pointsToPolylineD, simplifyPoints } from '../ops/pencil'
import { polygonPath, starPath } from '../ops/shapes'
import type { BBox, Tool, VecNode, VectorDocument } from '../types'

/**
 * Memoized so panning/marquee-dragging (Artboard's own high-frequency local
 * state) doesn't force a re-diff of every node on the canvas — only re-renders
 * when the document, tool, or the two handler props actually change.
 */
const NodeList = memo(function NodeList({
  doc,
  tool,
  handMode,
  outlineMode,
  onPointerDown,
  onDoubleClick,
  editingTextId,
  liveEditText,
  selectedIds,
  dragOffset,
}: {
  doc: VectorDocument
  tool: Tool
  handMode: boolean
  outlineMode: boolean
  onPointerDown: (id: string, e: ReactPointerEvent) => void
  onDoubleClick: (id: string, e: ReactMouseEvent) => void
  editingTextId: string | null
  liveEditText: string | null
  selectedIds: string[]
  dragOffset: { dx: number; dy: number } | null
}) {
  return (
    <g pointerEvents={isCreateTool(tool) || handMode ? 'none' : 'auto'}>
      {doc.zOrder.map((id) => {
        const node = doc.nodes[id]
        if (!node) return null
        const view = (
          <NodeView
            node={node}
            doc={doc}
            outlineMode={outlineMode}
            tool={tool}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            editingTextId={editingTextId}
            liveEditText={liveEditText}
          />
        )
        // Live drag preview: translate the whole selected node via a single
        // transform instead of mutating (and re-diffing) every descendant —
        // the only way dragging a 5000+-shape group stays smooth.
        if (dragOffset && selectedIds.includes(id)) {
          return (
            <g key={id} transform={`translate(${dragOffset.dx} ${dragOffset.dy})`}>
              {view}
            </g>
          )
        }
        return <g key={id}>{view}</g>
      })}
    </g>
  )
})

export function Artboard() {
  const doc = useDocStore((s) => s.doc)
  const tool = useDocStore((s) => s.tool)
  const guides = useDocStore((s) => s.guides)
  const draftNode = useDocStore((s) => s.draftNode)
  const penDraft = useDocStore((s) => s.penDraft)
  const select = useDocStore((s) => s.select)
  const clearSelection = useDocStore((s) => s.clearSelection)
  const setDraftNode = useDocStore((s) => s.setDraftNode)
  const setShapeDialog = useDocStore((s) => s.setShapeDialog)
  const addNode = useDocStore((s) => s.addNode)
  const addPenPoint = useDocStore((s) => s.addPenPoint)
  const finishPen = useDocStore((s) => s.finishPen)
  const moveSelectedTo = useDocStore((s) => s.moveSelectedTo)
  const pushHistory = useDocStore((s) => s.pushHistory)
  const setGuides = useDocStore((s) => s.setGuides)
  const selectedIds = useDocStore((s) => s.selectedIds)
  const dragOffset = useDocStore((s) => s.dragOffset)
  const setDragOffset = useDocStore((s) => s.setDragOffset)
  const sampleStyleFromNode = useDocStore((s) => s.sampleStyleFromNode)
  const outlineMode = useDocStore((s) => s.outlineMode)
  const setActiveArtboard = useDocStore((s) => s.setActiveArtboard)
  const scissorsAt = useDocStore((s) => s.scissorsAt)
  const shearSelected = useDocStore((s) => s.shearSelected)
  const zoom = useDocStore((s) => s.zoom)
  const zoomPinned = useDocStore((s) => s.zoomPinned)
  const fitNonce = useDocStore((s) => s.fitNonce)
  const setZoom = useDocStore((s) => s.setZoom)
  const spaceHand = useDocStore((s) => s.spaceHand)
  const handMode = tool === 'hand' || spaceHand
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const scale = zoom
  /** Camera: top-left of the viewport in document space. Zoom is applied via viewBox. */
  const [cam, setCam] = useState({ x: 0, y: 0 })
  const camRef = useRef(cam)
  camRef.current = cam
  const [viewport, setViewport] = useState({ w: 1, h: 1 })
  const viewportRef = useRef(viewport)
  viewportRef.current = viewport
  /** When true, zoom change already adjusted cam (fit / zoom-at-cursor). */
  const skipCamZoomSync = useRef(false)
  const prevZoomForCam = useRef(zoom)
  const [penCursor, setPenCursor] = useState<{ x: number; y: number } | null>(null)
  const draw = useRef<{
    startX: number
    startY: number
    kind: 'rect' | 'rounded-rect' | 'ellipse' | 'line' | 'polygon' | 'star' | 'area-text'
  } | null>(null)
  const shearDrag = useRef<{
    startClientX: number
    startClientY: number
    axis: 'x' | 'y'
  } | null>(null)
  const penDrag = useRef<{ x: number; y: number } | null>(null)
  const [penDragNow, setPenDragNow] = useState<{ x: number; y: number } | null>(null)
  /** Tracks clicks so we can close on double-click (pointerup.detail is unreliable). */
  const penLastClick = useRef<{ t: number; x: number; y: number } | null>(null)
  const pencilPts = useRef<Array<{ x: number; y: number }>>([])
  const [pencilPreview, setPencilPreview] = useState<string>('')
  const moveDrag = useRef<{
    startLocalX: number
    startLocalY: number
    originBox: BBox
    /** Other nodes' bboxes, cached at drag-start (see geometry.ts buildParentIndex). */
    others: BBox[]
  } | null>(null)
  const panDrag = useRef<{
    clientX: number
    clientY: number
    camX: number
    camY: number
  } | null>(null)
  const [handDragging, setHandDragging] = useState(false)
  const marquee = useRef<{
    x0: number
    y0: number
    x1: number
    y1: number
    additive: boolean
    mode: 'select' | 'direct'
  } | null>(null)
  const [marqueeBox, setMarqueeBox] = useState<BBox | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const editingTextIdRef = useRef<string | null>(null)
  const textEditOriginal = useRef<string>('')
  const textEditIsNew = useRef(false)
  const textEditDirty = useRef(false)
  /** Live draft shown in SVG while the overlay caret is active — avoids baseline jump. */
  const [liveEditText, setLiveEditText] = useState<string | null>(null)

  const extent = useMemo(
    () => documentExtent(doc),
    [doc.artboards, doc.artboard],
  )
  const fitExtent = useMemo(
    () => artboardFramesExtent(doc),
    [doc.artboards, doc.artboard],
  )
  const gradientExtra = useMemo(() => {
    if (!draftNode) return undefined
    return [
      ...(draftNode.style.fill.type === 'linear' || draftNode.style.fill.type === 'radial'
        ? [{ id: `fill-${draftNode.id}`, paint: draftNode.style.fill }]
        : []),
      ...(draftNode.style.stroke.type === 'linear' || draftNode.style.stroke.type === 'radial'
        ? [{ id: `stroke-${draftNode.id}`, paint: draftNode.style.stroke }]
        : []),
    ]
  }, [draftNode])

  const beginTextEdit = (id: string, opts?: { isNew?: boolean }) => {
    // The edit overlay positions itself from the node's raw x/y via the
    // root SVG's CTM, which doesn't know about an ancestor group's unbaked
    // move — bake first so a text node inside a just-moved group edits in
    // the right spot.
    useDocStore.getState().flushGroupMoves()
    const n = useDocStore.getState().doc.nodes[id]
    if (!n || n.type !== 'text' || n.locked) return
    moveDrag.current = null
    marquee.current = null
    setMarqueeBox(null)
    textEditOriginal.current = n.text
    textEditIsNew.current = !!opts?.isNew
    textEditDirty.current = false
    editingTextIdRef.current = id
    setLiveEditText(n.text)
    const selected = useDocStore.getState().selectedIds
    if (selected.length !== 1 || selected[0] !== id) {
      select([id], false)
    }
    useDocStore.getState().setEditingTextId(id)
    setEditingTextId(id)
  }

  const liveTextChange = (text: string) => {
    textEditDirty.current = true
    setLiveEditText(text)
  }

  const commitTextEdit = (text: string) => {
    const id = editingTextIdRef.current
    const isNew = textEditIsNew.current
    const original = textEditOriginal.current
    editingTextIdRef.current = null
    useDocStore.getState().setEditingTextId(null)
    setEditingTextId(null)
    setLiveEditText(null)
    if (!id) return
    const next = text === '' ? 'Text' : text
    if (!isNew && next !== original) {
      pushHistory()
    }
    useDocStore.getState().updateNode(
      id,
      { text: next, name: next.slice(0, 24) } as never,
      false,
    )
  }

  const cancelTextEdit = () => {
    const id = editingTextIdRef.current
    const isNew = textEditIsNew.current
    const dirty = textEditDirty.current
    editingTextIdRef.current = null
    useDocStore.getState().setEditingTextId(null)
    setEditingTextId(null)
    setLiveEditText(null)
    if (!id) return
    if (isNew || dirty) {
      useDocStore.getState().undo()
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const fit = () => {
      const pad = 48
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      setViewport({ w, h })
      // Fit to artboards only — pasteboard stays reachable via pan.
      const sx = (w - pad) / fitExtent.width
      const sy = (h - pad) / fitExtent.height
      const next = Math.min(64, Math.max(0.05, Math.min(sx, sy)))
      const vw = w / next
      const vh = h / next
      skipCamZoomSync.current = true
      prevZoomForCam.current = next
      setZoom(next, false)
      setCam({
        x: fitExtent.x - (vw - fitExtent.width) / 2,
        y: fitExtent.y - (vh - fitExtent.height) / 2,
      })
    }

    const onResize = () => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      setViewport({ w, h })
      if (!useDocStore.getState().zoomPinned) fit()
    }

    if (!zoomPinned) fit()
    else {
      setViewport({
        w: Math.max(1, host.clientWidth),
        h: Math.max(1, host.clientHeight),
      })
    }

    const ro = new ResizeObserver(onResize)
    ro.observe(host)
    return () => ro.disconnect()
  }, [fitExtent.width, fitExtent.height, fitNonce, zoomPinned, setZoom])

  /** Toolbar / shortcut zoom: keep viewport center stable. */
  useEffect(() => {
    const prev = prevZoomForCam.current
    if (prev === zoom) return
    if (skipCamZoomSync.current) {
      skipCamZoomSync.current = false
      prevZoomForCam.current = zoom
      return
    }
    const vp = viewportRef.current
    const cx = camRef.current.x + vp.w / prev / 2
    const cy = camRef.current.y + vp.h / prev / 2
    prevZoomForCam.current = zoom
    setCam({
      x: cx - vp.w / zoom / 2,
      y: cy - vp.h / zoom / 2,
    })
  }, [zoom])

  /** Zoom keeping the document point under the cursor stable. */
  const zoomAtClient = (clientX: number, clientY: number, nextZoom: number) => {
    const host = hostRef.current
    const prev = zoomRef.current
    const clamped = Math.min(64, Math.max(0.05, nextZoom))
    if (!host || clamped === prev) {
      setZoom(clamped, true)
      return
    }
    const rect = host.getBoundingClientRect()
    const mx = clientX - rect.left
    const my = clientY - rect.top
    const docX = camRef.current.x + mx / prev
    const docY = camRef.current.y + my / prev
    skipCamZoomSync.current = true
    prevZoomForCam.current = clamped
    setZoom(clamped, true)
    setCam({
      x: docX - mx / clamped,
      y: docY - my / clamped,
    })
  }

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = Math.exp(-e.deltaY * 0.0018)
        zoomAtClient(e.clientX, e.clientY, zoomRef.current * factor)
        return
      }
      // Trackpad / wheel pan in document space
      e.preventDefault()
      const z = zoomRef.current
      setCam((c) => ({
        x: c.x + e.deltaX / z,
        y: c.y + e.deltaY / z,
      }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setZoom])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const block = (e: Event) => e.preventDefault()
    svg.addEventListener('selectstart', block)
    return () => svg.removeEventListener('selectstart', block)
  }, [])

  const toLocal = (e: ReactPointerEvent | MouseEvent) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const local = pt.matrixTransform(ctm.inverse())
    return { x: local.x, y: local.y }
  }

  const beginPan = (e: ReactPointerEvent) => {
    e.stopPropagation()
    svgRef.current?.setPointerCapture(e.pointerId)
    panDrag.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      camX: camRef.current.x,
      camY: camRef.current.y,
    }
    setHandDragging(true)
  }

  const onNodePointerDown = (id: string, e: ReactPointerEvent) => {
    window.getSelection()?.removeAllRanges()
    if (editingTextId) return
    if (handMode) {
      beginPan(e)
      return
    }
    if (tool === 'zoom') {
      e.stopPropagation()
      const factor = e.altKey || e.shiftKey ? 1 / 1.5 : 1.5
      zoomAtClient(e.clientX, e.clientY, zoomRef.current * factor)
      return
    }
    if (tool === 'eyedropper') {
      e.stopPropagation()
      sampleStyleFromNode(id)
      return
    }

    if (tool === 'scissors') {
      const n = doc.nodes[id]
      if (n?.type === 'path') {
        e.stopPropagation()
        const { x, y } = toLocal(e)
        scissorsAt(id, x, y)
      }
      return
    }

    if (tool === 'text' || tool === 'area-text') {
      const n = doc.nodes[id]
      if (n?.type === 'text' && !n.locked) {
        e.stopPropagation()
        beginTextEdit(id)
        return
      }
      // Non-text under Type: place a new point-text at this click.
      if (tool === 'text' && n && n.type !== 'text') {
        const { x, y } = toLocal(e)
        const snapped = snapPoint(x, y, doc.settings, doc.artboards)
        const node: VecNode = {
          id: nextId('text'),
          type: 'text',
          name: 'Text',
          visible: true,
          locked: false,
          rotation: 0,
          style: defaultTextStyle(),
          x: snapped.x,
          y: snapped.y,
          text: '',
          fontSize: 24,
          fontFamily: 'Segoe UI, system-ui, sans-serif',
          fontWeight: 'normal',
          fontStyle: 'normal',
        }
        addNode(node)
        beginTextEdit(node.id, { isNew: true })
      }
      return
    }

    if (tool === 'shear') {
      const parent = parentOf(id, doc)
      const targetId = parent ?? id
      if (!useDocStore.getState().selectedIds.includes(targetId)) {
        select([targetId], false)
      }
      e.stopPropagation()
      svgRef.current?.setPointerCapture(e.pointerId)
      shearDrag.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        axis: e.shiftKey ? 'y' : 'x',
      }
      return
    }

    if (tool !== 'select' && tool !== 'direct') return
    const node = doc.nodes[id]
    if (!node) return

    if (tool === 'direct') {
      // Direct select targets a specific leaf's own geometry (anchor
      // editing reads/writes it directly), which stays stale under an
      // ancestor's unbaked move — bake before it becomes the target.
      useDocStore.getState().flushGroupMoves()
      // Direct select prefers the leaf path/shape, not the parent group
      if (e.shiftKey) {
        select([id], true)
        return
      }
      select([id], false)
      return
    }

    // Prefer selecting top-level group if child clicked
    const parent = parentOf(id, doc)
    const targetId = parent ?? id
    const target = doc.nodes[targetId]
    if (!target) return

    // Shift toggles selection only (no drag).
    if (e.shiftKey) {
      select([targetId], true)
      return
    }

    const state = useDocStore.getState()
    const alreadySelected = state.selectedIds.includes(targetId)
    if (!alreadySelected) {
      select([targetId], false)
    }

    if (target.locked) return

    // Second click of a double-click — keep selection, skip drag (edit starts on dblclick).
    if (e.detail >= 2) return

    const after = useDocStore.getState()
    const box = selectionBBox(after.selectedIds, after.doc)
    if (!box) return

    e.stopPropagation()
    svgRef.current?.setPointerCapture(e.pointerId)
    pushHistory()
    const local = toLocal(e)
    const parentIndex = buildParentIndex(doc)
    const others = Object.values(doc.nodes)
      .filter((n) => n.visible && !after.selectedIds.includes(n.id) && !parentIndex.has(n.id))
      .map((n) => nodeBBox(n, doc))
    moveDrag.current = {
      startLocalX: local.x,
      startLocalY: local.y,
      originBox: { ...box },
      others,
    }
  }

  const onNodeDoubleClick = (id: string, e: ReactMouseEvent) => {
    e.stopPropagation()
    const n = doc.nodes[id]
    if (n?.type === 'text' && !n.locked) {
      beginTextEdit(id)
    }
  }

  // Referentially-stable wrappers for NodeList's memo: onNodePointerDown/
  // onNodeDoubleClick close over lots of render-fresh state and aren't
  // memoized themselves, so we route through a ref instead of chasing a
  // useCallback dependency list through their whole closure chain.
  const onNodePointerDownRef = useRef(onNodePointerDown)
  onNodePointerDownRef.current = onNodePointerDown
  const stableOnNodePointerDown = useCallback((id: string, e: ReactPointerEvent) => {
    onNodePointerDownRef.current(id, e)
  }, [])
  const onNodeDoubleClickRef = useRef(onNodeDoubleClick)
  onNodeDoubleClickRef.current = onNodeDoubleClick
  const stableOnNodeDoubleClick = useCallback((id: string, e: ReactMouseEvent) => {
    onNodeDoubleClickRef.current(id, e)
  }, [])

  const onBackgroundDown = (e: ReactPointerEvent) => {
    // Kill any stray DOM text selection (SVG <text> is otherwise selectable while dragging).
    window.getSelection()?.removeAllRanges()
    if (editingTextId) {
      // Blur on the input will commit; don't start another gesture.
      return
    }
    if (handMode) {
      beginPan(e)
      return
    }
    if (tool === 'zoom') {
      const factor = e.altKey || e.shiftKey ? 1 / 1.5 : 1.5
      zoomAtClient(e.clientX, e.clientY, zoomRef.current * factor)
      return
    }
    const { x, y } = toLocal(e)

    if (tool === 'select' || tool === 'direct') {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      marquee.current = {
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        additive: e.shiftKey,
        mode: tool,
      }
      setMarqueeBox(normalizeMarquee(x, y, x, y))
      return
    }

    const snapped = snapPoint(x, y, doc.settings, doc.artboards)

    if (tool === 'text') {
      const node: VecNode = {
        id: nextId('text'),
        type: 'text',
        name: 'Text',
        visible: true,
        locked: false,
        rotation: 0,
        style: defaultTextStyle(),
        x: snapped.x,
        y: snapped.y,
        text: '',
        fontSize: 24,
        fontFamily: 'Segoe UI, system-ui, sans-serif',
        fontWeight: 'normal',
        fontStyle: 'normal',
      }
      addNode(node)
      beginTextEdit(node.id, { isNew: true })
      return
    }

    if (tool === 'area-text') {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      draw.current = { startX: snapped.x, startY: snapped.y, kind: 'area-text' }
      setDraftNode(
        makeAreaTextDraft(snapped.x, snapped.y, snapped.x, snapped.y),
      )
      return
    }

    if (tool === 'pen') {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      penDrag.current = { x: snapped.x, y: snapped.y }
      setPenDragNow(snapped)
      return
    }

    if (tool === 'pencil') {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      pencilPts.current = [snapped]
      setPencilPreview(pointsToPolylineD([snapped]))
      return
    }

    if (
      tool === 'rect' ||
      tool === 'rounded-rect' ||
      tool === 'ellipse' ||
      tool === 'line' ||
      tool === 'polygon' ||
      tool === 'star'
    ) {
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      draw.current = { startX: snapped.x, startY: snapped.y, kind: tool }
      setDraftNode(
        makeDraft(tool, snapped.x, snapped.y, snapped.x, snapped.y, e.shiftKey),
      )
    }
  }

  const onPointerMove = (e: ReactPointerEvent) => {
    if (panDrag.current) {
      const z = zoomRef.current
      const dx = (e.clientX - panDrag.current.clientX) / z
      const dy = (e.clientY - panDrag.current.clientY) / z
      setCam({
        x: panDrag.current.camX - dx,
        y: panDrag.current.camY - dy,
      })
      return
    }

    if (moveDrag.current) {
      const local = toLocal(e)
      const dx = local.x - moveDrag.current.startLocalX
      const dy = local.y - moveDrag.current.startLocalY
      const { originBox, others } = moveDrag.current
      // Live preview only — snap and show the offset via transform, don't
      // touch the document. Mutating every selected node's geometry (and
      // re-diffing it) on every pointermove is what makes dragging a large
      // group unusable; the real move is committed once on pointer up.
      const snapped = snapBBox(
        { ...originBox, x: originBox.x + dx, y: originBox.y + dy },
        others,
        doc.artboards,
        doc.settings,
        doc.manualGuides,
      )
      setDragOffset({
        dx: snapped.x - originBox.x,
        dy: snapped.y - originBox.y,
      })
      setGuides(snapped.guides)
      return
    }

    if (shearDrag.current) {
      // Live preview skipped — commit on pointer up from total delta.
      return
    }

    if (marquee.current) {
      const { x, y } = toLocal(e)
      marquee.current.x1 = x
      marquee.current.y1 = y
      const box = normalizeMarquee(
        marquee.current.x0,
        marquee.current.y0,
        x,
        y,
      )
      setMarqueeBox(box)
      return
    }

    const { x, y } = toLocal(e)
    const snapped = snapPoint(x, y, doc.settings, doc.artboards)

    if (tool === 'pen') {
      setPenCursor(snapped)
      if (penDrag.current) {
        setPenDragNow(snapped)
      }
      setGuides(snapped.guides)
      return
    }

    if (tool === 'pencil' && pencilPts.current.length) {
      const last = pencilPts.current[pencilPts.current.length - 1]
      if (Math.hypot(snapped.x - last.x, snapped.y - last.y) >= 1.5) {
        pencilPts.current.push(snapped)
        setPencilPreview(pointsToPolylineD(pencilPts.current))
      }
      setGuides(snapped.guides)
      return
    }

    if (!draw.current) return
    setGuides(snapped.guides)
    if (draw.current.kind === 'area-text') {
      setDraftNode(
        makeAreaTextDraft(
          draw.current.startX,
          draw.current.startY,
          snapped.x,
          snapped.y,
        ),
      )
      return
    }
    setDraftNode(
      makeDraft(
        draw.current.kind,
        draw.current.startX,
        draw.current.startY,
        snapped.x,
        snapped.y,
        e.shiftKey,
      ),
    )
  }

  const onPointerUp = (e: ReactPointerEvent) => {
    if (panDrag.current) {
      panDrag.current = null
      setHandDragging(false)
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId)
      }
      return
    }

    if (moveDrag.current) {
      const { originBox, others } = moveDrag.current
      const local = toLocal(e)
      const dx = local.x - moveDrag.current.startLocalX
      const dy = local.y - moveDrag.current.startLocalY
      moveDrag.current = null
      setDragOffset(null)
      setGuides([])
      // Single commit for the whole gesture — this is the only point the
      // document (and every selected descendant's geometry) actually gets
      // rewritten. Skip entirely for a plain click (no pointer movement) so
      // selecting a large group doesn't pay the translate cost for nothing.
      if (dx !== 0 || dy !== 0) {
        moveSelectedTo(originBox.x + dx, originBox.y + dy, others, originBox)
      }
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId)
      }
      return
    }

    if (shearDrag.current) {
      const drag = shearDrag.current
      shearDrag.current = null
      const delta =
        drag.axis === 'x'
          ? (e.clientX - drag.startClientX) / 180
          : (e.clientY - drag.startClientY) / 180
      if (Math.abs(delta) > 0.02) {
        shearSelected(drag.axis, delta)
      }
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId)
      }
      return
    }

    if (marquee.current) {
      const m = marquee.current
      marquee.current = null
      setMarqueeBox(null)
      const box = normalizeMarquee(m.x0, m.y0, m.x1, m.y1)
      const dragged = box.width > 2 || box.height > 2
      if (!dragged) {
        if (!m.additive) clearSelection()
      } else {
        // Direct-mode marquee compares individual children's own absolute
        // bboxes, which stay stale under an ancestor's unbaked move.
        if (m.mode === 'direct') useDocStore.getState().flushGroupMoves()
        const ids = idsInMarquee(useDocStore.getState().doc, box, {
          mode: m.mode,
        })
        if (m.additive) {
          const next = new Set(useDocStore.getState().selectedIds)
          for (const id of ids) next.add(id)
          select([...next], false)
        } else {
          select(ids, false)
        }
      }
      if (svgRef.current?.hasPointerCapture(e.pointerId)) {
        svgRef.current.releasePointerCapture(e.pointerId)
      }
      return
    }

    const { x, y } = toLocal(e)
    const snapped = snapPoint(x, y, doc.settings, doc.artboards)

    if (tool === 'pen' && penDrag.current) {
      const start = penDrag.current
      penDrag.current = null
      setPenDragNow(null)
      setPenCursor(snapped)

      const now = performance.now()
      const prev = penLastClick.current
      const isDouble =
        !!prev &&
        now - prev.t < 400 &&
        Math.hypot(start.x - prev.x, start.y - prev.y) < 8 / scale

      if (isDouble) {
        penLastClick.current = null
        // Second click of a double-click — close without adding another anchor.
        finishPen({ close: true })
        return
      }

      const dist = Math.hypot(snapped.x - start.x, snapped.y - start.y)
      if (dist > 3) {
        addPenPoint(start.x, start.y, { cx: snapped.x, cy: snapped.y })
      } else {
        addPenPoint(start.x, start.y)
      }
      penLastClick.current = { t: now, x: start.x, y: start.y }

      // Click near the first point also closes.
      const pts = useDocStore.getState().penDraft?.points ?? []
      if (pts.length >= 3) {
        const first = pts[0]
        const closeHit = Math.hypot(start.x - first.x, start.y - first.y) < 10 / scale
        if (closeHit) {
          // Drop the duplicate closing click on the start anchor.
          useDocStore.setState({
            penDraft: { points: pts.slice(0, -1) },
          })
          penLastClick.current = null
          finishPen({ close: true })
        }
      }
      return
    }

    if (tool === 'pencil' && pencilPts.current.length) {
      const simplified = simplifyPoints(pencilPts.current, 1.75)
      pencilPts.current = []
      setPencilPreview('')
      setGuides([])
      if (simplified.length >= 2) {
        const node: VecNode = {
          id: nextId('path'),
          type: 'path',
          name: 'Pencil',
          visible: true,
          locked: false,
          rotation: 0,
          style: { ...defaultStyle(), fill: paintNone() },
          d: pointsToPolylineD(simplified),
        }
        addNode(node)
      }
      return
    }

    if (draw.current) {
      if (draw.current.kind === 'area-text') {
        const n = makeAreaTextDraft(
          draw.current.startX,
          draw.current.startY,
          snapped.x,
          snapped.y,
        )
        const valid =
          n.type === 'text' && (n.width ?? 0) > 8 && (n.height ?? 0) > 8
        if (valid) {
          const id = nextId('text')
          addNode({ ...n, id })
          beginTextEdit(id, { isNew: true })
        }
        setDraftNode(null)
        draw.current = null
        setGuides([])
        return
      }
      const n = makeDraft(
        draw.current.kind,
        draw.current.startX,
        draw.current.startY,
        snapped.x,
        snapped.y,
        e.shiftKey,
      )
      const startX = draw.current.startX
      const startY = draw.current.startY
      const kind = draw.current.kind
      const clickOnly =
        Math.hypot(snapped.x - startX, snapped.y - startY) < Math.max(3, 4 / scale)
      if (
        clickOnly &&
        (kind === 'rect' ||
          kind === 'rounded-rect' ||
          kind === 'ellipse' ||
          kind === 'line' ||
          kind === 'polygon' ||
          kind === 'star')
      ) {
        setDraftNode(null)
        draw.current = null
        setGuides([])
        setShapeDialog({ kind, x: startX, y: startY })
        return
      }
      const valid =
        (n.type === 'rect' && n.width > 1 && n.height > 1) ||
        (n.type === 'ellipse' && n.rx > 1 && n.ry > 1) ||
        (n.type === 'line' && (n.x1 !== n.x2 || n.y1 !== n.y2)) ||
        (n.type === 'path' && n.d.length > 4)
      if (valid) {
        addNode({ ...n, id: nextId(n.type) })
      }
      setDraftNode(null)
      draw.current = null
      setGuides([])
    }
  }

  const penPoints = penDraft?.points ?? []
  const penCommittedPath = penPoints.length ? penPointsToPath(penPoints) : ''
  const lastPen = penPoints.length ? penPoints[penPoints.length - 1] : null
  const penRubber =
    tool === 'pen' && lastPen && penCursor && !penDrag.current
      ? { x1: lastPen.x, y1: lastPen.y, x2: penCursor.x, y2: penCursor.y }
      : null
  const penCurvePreview =
    tool === 'pen' && penDrag.current && penDragNow
      ? {
          anchor: penDrag.current,
          handle: penDragNow,
          // Illustrator-style: opposite handle for cubic preview from previous point
          mirror: {
            x: 2 * penDrag.current.x - penDragNow.x,
            y: 2 * penDrag.current.y - penDragNow.y,
          },
        }
      : null
  const penLiveSegment =
    penCurvePreview && lastPen
      ? `M ${lastPen.x} ${lastPen.y} C ${lastPen.cx ?? lastPen.x} ${lastPen.cy ?? lastPen.y} ${penCurvePreview.mirror.x} ${penCurvePreview.mirror.y} ${penCurvePreview.anchor.x} ${penCurvePreview.anchor.y}`
      : ''
  const hs = 5 / scale

  useEffect(() => {
    if (tool !== 'pen') {
      setPenCursor(null)
      setPenDragNow(null)
      penLastClick.current = null
    }
  }, [tool])

  const penClose =
    tool === 'pen' &&
    penPoints.length >= 2 &&
    penCursor &&
    !penDrag.current &&
    Math.hypot(penCursor.x - penPoints[0].x, penCursor.y - penPoints[0].y) < 10 / scale

  const viewBoxW = viewport.w / Math.max(scale, 0.0001)
  const viewBoxH = viewport.h / Math.max(scale, 0.0001)

  return (
    <Rulers scale={scale} camera={cam}>
    <div
      ref={hostRef}
      className={`artboard-host${outlineMode ? ' artboard-host--outline' : ''}`}
    >
      <ToolCursorOverlay
        tool={tool}
        hostRef={hostRef}
        override={
          handDragging
            ? 'hand-closed'
            : handMode
              ? 'hand'
              : penClose
                ? 'pen-close'
                : null
        }
      />
      <svg
        ref={svgRef}
        className="artboard-svg artboard-svg--custom-cursor"
        width="100%"
        height="100%"
        viewBox={`${cam.x} ${cam.y} ${viewBoxW} ${viewBoxH}`}
        preserveAspectRatio="none"
        onPointerDown={onBackgroundDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          if (tool === 'pen' && !penDrag.current) setPenCursor(null)
        }}
      >
        <GradientDefs doc={doc} extra={gradientExtra} />
        <defs>
          <filter
            id="artboard-frame-shadow"
            x="-8%"
            y="-8%"
            width="116%"
            height="116%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow
              dx={0}
              dy={6 / scale}
              stdDeviation={10 / scale}
              floodColor="var(--canvas-frame-shadow, #000)"
              floodOpacity={0.28}
            />
          </filter>
        </defs>
        {/* Workspace chrome behind artboards */}
        <rect
          x={extent.x}
          y={extent.y}
          width={extent.width}
          height={extent.height}
          fill="var(--canvas-pad, #1a1612)"
        />
        {doc.artboards.map((ab) => (
          <g key={ab.id} filter="url(#artboard-frame-shadow)">
            <rect
              x={ab.x}
              y={ab.y}
              width={ab.width}
              height={ab.height}
              fill={ab.background ?? '#ffffff'}
              stroke={ab.id === doc.activeArtboardId ? 'var(--accent-strong)' : 'var(--border, #444)'}
              strokeWidth={(ab.id === doc.activeArtboardId ? 2 : 1) / scale}
              onPointerDown={() => {
                setActiveArtboard(ab.id)
              }}
            />
          </g>
        ))}
        <NodeList
          doc={doc}
          tool={tool}
          handMode={handMode}
          outlineMode={outlineMode}
          onPointerDown={stableOnNodePointerDown}
          onDoubleClick={stableOnNodeDoubleClick}
          editingTextId={editingTextId}
          liveEditText={liveEditText}
          selectedIds={selectedIds}
          dragOffset={dragOffset}
        />
        {draftNode && (
          <NodeView
            node={draftNode}
            doc={doc}
            outlineMode={outlineMode}
            tool={tool}
            onPointerDown={() => undefined}
          />
        )}
        {pencilPreview && (
          <path
            d={pencilPreview}
            fill="none"
            stroke="var(--accent-strong)"
            strokeWidth={1.5 / scale}
            pointerEvents="none"
          />
        )}
        {tool === 'pen' && (
          <g className="pen-overlay" pointerEvents="none">
            {penCommittedPath && (
              <path
                d={penCommittedPath}
                fill="none"
                stroke="var(--accent-strong)"
                strokeWidth={1.5 / scale}
              />
            )}
            {penLiveSegment && (
              <path
                d={penLiveSegment}
                fill="none"
                stroke="var(--accent-strong)"
                strokeWidth={1.5 / scale}
                opacity={0.85}
              />
            )}
            {penRubber && (
              <line
                x1={penRubber.x1}
                y1={penRubber.y1}
                x2={penRubber.x2}
                y2={penRubber.y2}
                stroke="var(--accent)"
                strokeWidth={1 / scale}
                strokeDasharray={`${4 / scale} ${3 / scale}`}
                opacity={0.9}
              />
            )}
            {penCurvePreview && (
              <>
                <line
                  x1={penCurvePreview.mirror.x}
                  y1={penCurvePreview.mirror.y}
                  x2={penCurvePreview.handle.x}
                  y2={penCurvePreview.handle.y}
                  stroke="var(--accent)"
                  strokeWidth={1 / scale}
                  opacity={0.75}
                />
                <circle
                  cx={penCurvePreview.handle.x}
                  cy={penCurvePreview.handle.y}
                  r={hs * 0.7}
                  fill="var(--chrome)"
                  stroke="var(--accent-strong)"
                  strokeWidth={1 / scale}
                />
                <circle
                  cx={penCurvePreview.mirror.x}
                  cy={penCurvePreview.mirror.y}
                  r={hs * 0.7}
                  fill="var(--chrome)"
                  stroke="var(--accent-strong)"
                  strokeWidth={1 / scale}
                />
              </>
            )}
            {penPoints.map((p, i) => (
              <rect
                key={`pen-pt-${i}`}
                x={p.x - hs}
                y={p.y - hs}
                width={hs * 2}
                height={hs * 2}
                fill={i === penPoints.length - 1 ? 'var(--accent-strong)' : 'var(--chrome)'}
                stroke="var(--accent-strong)"
                strokeWidth={1 / scale}
              />
            ))}
            {penCurvePreview && (
              <rect
                x={penCurvePreview.anchor.x - hs}
                y={penCurvePreview.anchor.y - hs}
                width={hs * 2}
                height={hs * 2}
                fill="var(--accent-strong)"
                stroke="var(--text)"
                strokeWidth={1 / scale}
              />
            )}
            {penCursor && !penDrag.current && penPoints.length === 0 && (
              <rect
                x={penCursor.x - hs}
                y={penCursor.y - hs}
                width={hs * 2}
                height={hs * 2}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={1 / scale}
                opacity={0.7}
              />
            )}
          </g>
        )}
        {guides.map((g, i) =>
          g.orientation === 'vertical' ? (
            <line
              key={`gv-${i}`}
              x1={g.position}
              y1={extent.y}
              x2={g.position}
              y2={extent.y + extent.height}
              stroke="#c4a484"
              strokeWidth={1}
              strokeDasharray="4 4"
              pointerEvents="none"
              opacity={0.75}
            />
          ) : (
            <line
              key={`gh-${i}`}
              x1={extent.x}
              y1={g.position}
              x2={extent.x + extent.width}
              y2={g.position}
              stroke="#c4a484"
              strokeWidth={1}
              strokeDasharray="4 4"
              pointerEvents="none"
              opacity={0.75}
            />
          ),
        )}
        {doc.manualGuides.map((g, i) =>
          g.orientation === 'vertical' ? (
            <line
              key={`mgv-${i}`}
              x1={g.position}
              y1={extent.y}
              x2={g.position}
              y2={extent.y + extent.height}
              stroke="#6b8cae"
              strokeWidth={1 / scale}
              pointerEvents="none"
              opacity={0.9}
            />
          ) : (
            <line
              key={`mgh-${i}`}
              x1={extent.x}
              y1={g.position}
              x2={extent.x + extent.width}
              y2={g.position}
              stroke="#6b8cae"
              strokeWidth={1 / scale}
              pointerEvents="none"
              opacity={0.9}
            />
          ),
        )}
        {!editingTextId && (
          <SelectionOverlay
            scale={scale}
            onEditText={(id) => beginTextEdit(id)}
          />
        )}
        <PathAnchorOverlay scale={scale} />
        {marqueeBox && (marqueeBox.width > 0 || marqueeBox.height > 0) && (
          <rect
            className="marquee"
            x={marqueeBox.x}
            y={marqueeBox.y}
            width={Math.max(marqueeBox.width, 0.5)}
            height={Math.max(marqueeBox.height, 0.5)}
            fill="var(--accent)"
            fillOpacity={0.12}
            stroke="var(--accent)"
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
            pointerEvents="none"
          />
        )}
      </svg>
      {editingTextId && (
        <TextEditOverlay
          nodeId={editingTextId}
          hostRef={hostRef}
          svgRef={svgRef}
          isNew={textEditIsNew.current}
          onLiveChange={liveTextChange}
          onCommit={commitTextEdit}
          onCancel={cancelTextEdit}
        />
      )}
      {tool === 'pen' && (
        <div className="pen-hint">
          Click to place points · drag for curves · double-click or click first point to close ·
          Enter to finish open · Esc to cancel
        </div>
      )}
      {tool === 'scissors' && (
        <div className="pen-hint">Click a path to split it at that point</div>
      )}
      {tool === 'shear' && (
        <div className="pen-hint">Drag selection to shear · hold Shift for vertical</div>
      )}
      {tool === 'area-text' && (
        <div className="pen-hint">Drag a frame for area type</div>
      )}
    </div>
    </Rulers>
  )
}

/** Preview helper matching store pen → path conversion. */
function penPointsToPath(
  points: Array<{ x: number; y: number; cx?: number; cy?: number }>,
): string {
  if (points.length === 0) return ''
  const [first, ...rest] = points
  let d = `M ${first.x} ${first.y}`
  for (let i = 0; i < rest.length; i++) {
    const prev = points[i]
    const cur = rest[i]
    if (prev.cx !== undefined && prev.cy !== undefined) {
      const c2x = cur.cx !== undefined ? 2 * cur.x - cur.cx : cur.x
      const c2y = cur.cy !== undefined ? 2 * cur.y - cur.cy : cur.y
      d += ` C ${prev.cx} ${prev.cy} ${c2x} ${c2y} ${cur.x} ${cur.y}`
    } else if (cur.cx !== undefined && cur.cy !== undefined) {
      d += ` Q ${cur.cx} ${cur.cy} ${cur.x} ${cur.y}`
    } else {
      d += ` L ${cur.x} ${cur.y}`
    }
  }
  return d
}

function constrainUniformEnd(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  kind: 'rect' | 'rounded-rect' | 'ellipse' | 'line' | 'polygon' | 'star',
): { x2: number; y2: number } {
  if (kind === 'line') {
    const dx = x2 - x1
    const dy = y2 - y1
    const len = Math.hypot(dx, dy)
    if (len < 0.001) return { x2, y2 }
    const angle = Math.atan2(dy, dx)
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4)
    return {
      x2: x1 + Math.cos(snapped) * len,
      y2: y1 + Math.sin(snapped) * len,
    }
  }

  // Square / circle: use the larger axis and keep the drag quadrant.
  const dx = x2 - x1
  const dy = y2 - y1
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return {
    x2: x1 + Math.sign(dx || 1) * side,
    y2: y1 + Math.sign(dy || 1) * side,
  }
}

function makeDraft(
  kind: 'rect' | 'rounded-rect' | 'ellipse' | 'line' | 'polygon' | 'star',
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  uniform = false,
): VecNode {
  const end = uniform ? constrainUniformEnd(x1, y1, x2, y2, kind) : { x2, y2 }
  x2 = end.x2
  y2 = end.y2

  const style = defaultStyle()
  if (kind === 'line') {
    return {
      id: 'draft',
      type: 'line',
      name: 'Line',
      visible: true,
      locked: false,
      rotation: 0,
      style: { ...style, fill: paintNone() },
      x1,
      y1,
      x2,
      y2,
    }
  }

  // Polygon / star: press = center, drag = radius (Illustrator-style).
  if (kind === 'polygon' || kind === 'star') {
    const cx = x1
    const cy = y1
    const radius = Math.max(1, Math.hypot(x2 - x1, y2 - y1))
    if (kind === 'polygon') {
      const primitive = {
        kind: 'polygon' as const,
        cx,
        cy,
        radius,
        sides: 6,
      }
      return {
        id: 'draft',
        type: 'path',
        name: 'Polygon',
        visible: true,
        locked: false,
        rotation: 0,
        style,
        d: polygonPath(cx, cy, radius, 6),
        primitive,
      }
    }
    const outerRadius = radius
    const innerRadius = outerRadius * 0.45
    const primitive = {
      kind: 'star' as const,
      cx,
      cy,
      outerRadius,
      innerRadius,
      points: 5,
    }
    return {
      id: 'draft',
      type: 'path',
      name: 'Star',
      visible: true,
      locked: false,
      rotation: 0,
      style,
      d: starPath(cx, cy, outerRadius, innerRadius, 5),
      primitive,
    }
  }

  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const w = Math.abs(x2 - x1)
  const h = Math.abs(y2 - y1)
  const cx = x + w / 2
  const cy = y + h / 2

  if (kind === 'rect' || kind === 'rounded-rect') {
    return {
      id: 'draft',
      type: 'rect',
      name: kind === 'rounded-rect' ? 'Rounded Rect' : 'Rectangle',
      visible: true,
      locked: false,
      rotation: 0,
      style,
      x,
      y,
      width: Math.max(1, w),
      height: Math.max(1, h),
      rx: kind === 'rounded-rect' ? Math.min(16, Math.min(w, h) / 4) : undefined,
    }
  }
  return {
    id: 'draft',
    type: 'ellipse',
    name: 'Ellipse',
    visible: true,
    locked: false,
    rotation: 0,
    style,
    cx,
    cy,
    rx: Math.max(0.5, w / 2),
    ry: Math.max(0.5, h / 2),
  }
}

function makeAreaTextDraft(x1: number, y1: number, x2: number, y2: number): VecNode {
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const width = Math.max(1, Math.abs(x2 - x1))
  const height = Math.max(1, Math.abs(y2 - y1))
  return {
    id: 'draft',
    type: 'text',
    name: 'Area Text',
    visible: true,
    locked: false,
    rotation: 0,
    style: defaultTextStyle(),
    x,
    y,
    text: '',
    fontSize: 24,
    fontFamily: 'Segoe UI, system-ui, sans-serif',
    fontWeight: 'normal',
    fontStyle: 'normal',
    width,
    height,
  }
}
