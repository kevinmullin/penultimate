import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { buildParentIndex, nodeBBox, selectionBBox } from '../geometry'
import { useDocStore } from '../store/documentStore'
import { snapBBox, snapResizeBBox } from './snap'
import { isCreateTool } from './NodeViews'
import type { BBox } from '../types'

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 'e' | 's' | 'w' | 'rotate'

type DragState = {
  kind: 'move' | Handle
  startLocalX: number
  startLocalY: number
  originBox: { x: number; y: number; width: number; height: number }
  originRotation: number
  startPointerAngle: number
  svg: SVGSVGElement
  /** Other nodes' bboxes, cached at drag-start (see geometry.ts buildParentIndex). */
  others: BBox[]
  /** Latest snapped translate offset for a 'move' drag — committed once on pointer up. */
  moveDx: number
  moveDy: number
}

function svgLocalFromClient(
  clientX: number,
  clientY: number,
  svg: SVGSVGElement,
): { x: number; y: number } | null {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  const ctm = svg.getScreenCTM()
  if (!ctm) return null
  const local = pt.matrixTransform(ctm.inverse())
  return { x: local.x, y: local.y }
}

function ownerSvg(el: Element): SVGSVGElement | null {
  if (el instanceof SVGSVGElement) return el
  if (el instanceof SVGElement) return el.ownerSVGElement
  return null
}

function rotatePoint(
  x: number,
  y: number,
  cx: number,
  cy: number,
  deg: number,
): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = x - cx
  const dy = y - cy
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
}

export function SelectionOverlay({
  scale,
  onEditText,
}: {
  scale: number
  onEditText?: (id: string) => void
}) {
  const doc = useDocStore((s) => s.doc)
  const selectedIds = useDocStore((s) => s.selectedIds)
  const tool = useDocStore((s) => s.tool)
  const spaceHand = useDocStore((s) => s.spaceHand)
  const aspectLock = useDocStore((s) => s.aspectLock)
  const pushHistory = useDocStore((s) => s.pushHistory)
  const moveSelectedTo = useDocStore((s) => s.moveSelectedTo)
  const resizeSelectionTo = useDocStore((s) => s.resizeSelectionTo)
  const rotateSelected = useDocStore((s) => s.rotateSelected)
  const setGuides = useDocStore((s) => s.setGuides)
  const dragOffset = useDocStore((s) => s.dragOffset)
  const setDragOffset = useDocStore((s) => s.setDragOffset)

  const drag = useRef<DragState | null>(null)
  const aspectLockRef = useRef(aspectLock)
  aspectLockRef.current = aspectLock

  const [rotatePointer, setRotatePointer] = useState<{ x: number; y: number } | null>(
    null,
  )
  const [rotating, setRotating] = useState(false)
  // Delay hit-testing so a double-click to edit text isn't eaten by the
  // selection chrome that mounts after the first click.
  const [interactive, setInteractive] = useState(false)

  // Memoized: unioning a large group's children is real work, and doc only
  // changes reference on actual mutations (post NodeView/PaintedShape memo
  // fix), so this now only recomputes on real selection/doc changes.
  const box = useMemo(() => selectionBBox(selectedIds, doc), [selectedIds, doc])

  useEffect(() => {
    setInteractive(false)
    const t = window.setTimeout(() => setInteractive(true), 280)
    return () => window.clearTimeout(t)
  }, [selectedIds.join('|')])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const local = svgLocalFromClient(e.clientX, e.clientY, d.svg)
      if (!local) return
      const dx = local.x - d.startLocalX
      const dy = local.y - d.startLocalY

      if (d.kind === 'move') {
        // Live preview only (see NodeList in Artboard.tsx) — snap and show
        // the offset via transform without mutating every selected node's
        // geometry on each pointermove. Committed once on pointer up.
        const liveDoc = useDocStore.getState().doc
        const snapped = snapBBox(
          { ...d.originBox, x: d.originBox.x + dx, y: d.originBox.y + dy },
          d.others,
          liveDoc.artboards,
          liveDoc.settings,
          liveDoc.manualGuides,
        )
        d.moveDx = snapped.x - d.originBox.x
        d.moveDy = snapped.y - d.originBox.y
        setDragOffset({ dx: d.moveDx, dy: d.moveDy })
        setGuides(snapped.guides)
        return
      }

      if (d.kind === 'rotate') {
        setRotatePointer(local)
        const ocx = d.originBox.x + d.originBox.width / 2
        const ocy = d.originBox.y + d.originBox.height / 2
        const angleNow = Math.atan2(local.y - ocy, local.x - ocx)
        let deg =
          d.originRotation + ((angleNow - d.startPointerAngle) * 180) / Math.PI
        if (e.shiftKey) deg = Math.round(deg / 15) * 15
        rotateSelected(Math.round(deg))
        return
      }

      let { x, y, width, height } = d.originBox
      const kind = d.kind
      if (kind.includes('e')) width = Math.max(4, d.originBox.width + dx)
      if (kind.includes('s')) height = Math.max(4, d.originBox.height + dy)
      if (kind.includes('w')) {
        width = Math.max(4, d.originBox.width - dx)
        x = d.originBox.x + (d.originBox.width - width)
      }
      if (kind.includes('n')) {
        height = Math.max(4, d.originBox.height - dy)
        y = d.originBox.y + (d.originBox.height - height)
      }

      const lock = aspectLockRef.current || e.shiftKey
      if (lock && d.originBox.width > 0 && d.originBox.height > 0) {
        const ratio = d.originBox.width / d.originBox.height
        const isCorner =
          kind === 'nw' || kind === 'ne' || kind === 'sw' || kind === 'se'
        const isEdgeH = kind === 'e' || kind === 'w'
        const isEdgeV = kind === 'n' || kind === 's'

        if (isCorner || isEdgeH) {
          height = Math.max(4, width / ratio)
          if (kind.includes('n')) y = d.originBox.y + d.originBox.height - height
          if (kind === 'e' || kind === 'w') {
            y = d.originBox.y + (d.originBox.height - height) / 2
          }
        } else if (isEdgeV) {
          width = Math.max(4, height * ratio)
          x = d.originBox.x + (d.originBox.width - width) / 2
        }
      }

      const edges = {
        left: kind.includes('w'),
        right: kind.includes('e'),
        top: kind.includes('n'),
        bottom: kind.includes('s'),
      }
      const liveDoc = useDocStore.getState().doc
      const others = d.others
      const snapped = snapResizeBBox(
        { x, y, width, height },
        edges,
        others,
        liveDoc.artboards,
        liveDoc.settings,
        liveDoc.manualGuides,
      )
      ;({ x, y, width, height } = snapped.box)

      // Re-apply aspect after edge snap so magnetized edges keep the ratio.
      if (lock && d.originBox.width > 0 && d.originBox.height > 0) {
        const ratio = d.originBox.width / d.originBox.height
        const isCorner =
          kind === 'nw' || kind === 'ne' || kind === 'sw' || kind === 'se'
        const isEdgeH = kind === 'e' || kind === 'w'
        const isEdgeV = kind === 'n' || kind === 's'
        if (isCorner || isEdgeH) {
          height = Math.max(4, width / ratio)
          if (kind.includes('n')) y = d.originBox.y + d.originBox.height - height
          if (kind === 'e' || kind === 'w') {
            y = d.originBox.y + (d.originBox.height - height) / 2
          }
        } else if (isEdgeV) {
          width = Math.max(4, height * ratio)
          x = d.originBox.x + (d.originBox.width - width) / 2
        }
      }

      setGuides(snapped.guides)
      resizeSelectionTo({ x, y, width, height })
    }

    const onUp = () => {
      const d = drag.current
      if (!d) return
      drag.current = null
      setRotatePointer(null)
      setRotating(false)
      setGuides([])
      if (d.kind === 'move') {
        setDragOffset(null)
        // Single commit for the whole gesture (see onMove's 'move' branch).
        if (d.moveDx !== 0 || d.moveDy !== 0) {
          moveSelectedTo(d.originBox.x + d.moveDx, d.originBox.y + d.moveDy, d.others)
        }
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [moveSelectedTo, resizeSelectionTo, rotateSelected, setGuides, setDragOffset])

  if (selectedIds.length === 0) return null
  // Keep bounds visible after create / Type so Appearance still has a clear target
  // even while the create tool stays active (Illustrator-style).
  if (tool === 'hand' || spaceHand) return null
  if (tool !== 'select' && tool !== 'text' && tool !== 'area-text' && !isCreateTool(tool)) {
    return null
  }
  if (!box) return null

  // Visual-only position during a live move drag — `box` itself stays put
  // (the document isn't mutated until pointer up) so the chrome tracks the
  // same transform preview NodeList applies to the selected shapes.
  const renderBox = dragOffset
    ? { ...box, x: box.x + dragOffset.dx, y: box.y + dragOffset.dy }
    : box

  const hs = 8 / scale
  const stroke = 1.5 / scale
  const stem = 24 / scale

  const selected = selectedIds.map((id) => doc.nodes[id]).filter(Boolean)
  const rotation = selected.length === 1 ? selected[0].rotation : 0
  const cx = renderBox.x + renderBox.width / 2
  const cy = renderBox.y + renderBox.height / 2
  const topCenter = rotatePoint(cx, renderBox.y, cx, cy, rotation)
  const restHandle = rotatePoint(cx, renderBox.y - stem, cx, cy, rotation)

  const beginDrag = (
    kind: 'move' | Handle,
    e: ReactPointerEvent,
    startPointerAngle = 0,
  ) => {
    if (selected.some((n) => n.locked)) return
    const svg = ownerSvg(e.currentTarget)
    if (!svg) return
    e.stopPropagation()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    pushHistory()
    const local = svgLocalFromClient(e.clientX, e.clientY, svg)
    if (!local) return
    const liveDoc = useDocStore.getState().doc
    const liveSelected = useDocStore.getState().selectedIds
    const parentIndex = buildParentIndex(liveDoc)
    const others = Object.values(liveDoc.nodes)
      .filter((n) => n.visible && !liveSelected.includes(n.id) && !parentIndex.has(n.id))
      .map((n) => nodeBBox(n, liveDoc))
    drag.current = {
      kind,
      startLocalX: local.x,
      startLocalY: local.y,
      originBox: { ...box },
      originRotation: rotation,
      startPointerAngle,
      svg,
      others,
      moveDx: 0,
      moveDy: 0,
    }
    if (kind === 'rotate') {
      setRotating(true)
      setRotatePointer(local)
    }
  }

  const onMoveDown = (e: ReactPointerEvent) => beginDrag('move', e)

  const onHandleDown = (kind: Handle) => (e: ReactPointerEvent) => {
    const svg = ownerSvg(e.currentTarget)
    if (!svg) return
    let startPointerAngle = -Math.PI / 2
    if (kind === 'rotate') {
      const local = svgLocalFromClient(e.clientX, e.clientY, svg)
      if (local) startPointerAngle = Math.atan2(local.y - cy, local.x - cx)
    }
    beginDrag(kind, e, startPointerAngle)
  }

  const handles: Array<{ kind: Handle; x: number; y: number; cursor: string }> = [
    { kind: 'nw', x: renderBox.x, y: renderBox.y, cursor: 'nwse-resize' },
    { kind: 'ne', x: renderBox.x + renderBox.width, y: renderBox.y, cursor: 'nesw-resize' },
    { kind: 'sw', x: renderBox.x, y: renderBox.y + renderBox.height, cursor: 'nesw-resize' },
    {
      kind: 'se',
      x: renderBox.x + renderBox.width,
      y: renderBox.y + renderBox.height,
      cursor: 'nwse-resize',
    },
    { kind: 'n', x: renderBox.x + renderBox.width / 2, y: renderBox.y, cursor: 'ns-resize' },
    {
      kind: 's',
      x: renderBox.x + renderBox.width / 2,
      y: renderBox.y + renderBox.height,
      cursor: 'ns-resize',
    },
    { kind: 'w', x: renderBox.x, y: renderBox.y + renderBox.height / 2, cursor: 'ew-resize' },
    {
      kind: 'e',
      x: renderBox.x + renderBox.width,
      y: renderBox.y + renderBox.height / 2,
      cursor: 'ew-resize',
    },
  ]

  const handlePos = rotating && rotatePointer ? rotatePointer : restHandle
  const soleText =
    selectedIds.length === 1 ? doc.nodes[selectedIds[0]] : null
  const soleTextId =
    soleText?.type === 'text' && !soleText.locked ? soleText.id : null
  const typeTool = tool === 'text' || tool === 'area-text'
  // Type tool: selection chrome is visual-only so clicks hit the text and enter edit.
  // Also non-interactive briefly after selection so dblclick reaches the node.
  const passClicksThrough = !interactive || typeTool

  return (
    <g>
      <g transform={`rotate(${rotation} ${cx} ${cy})`}>
        <rect
          className="sel-move"
          x={renderBox.x}
          y={renderBox.y}
          width={renderBox.width}
          height={renderBox.height}
          fill="transparent"
          stroke="#c4a484"
          strokeWidth={stroke}
          strokeDasharray={`${4 / scale} ${4 / scale}`}
          pointerEvents={passClicksThrough ? 'none' : 'all'}
          onPointerDown={passClicksThrough ? undefined : onMoveDown}
          onDoubleClick={
            soleTextId
              ? (e) => {
                  e.stopPropagation()
                  onEditText?.(soleTextId)
                }
              : undefined
          }
        />
        {handles.map((h) => (
          <rect
            key={h.kind}
            className="sel-handle"
            data-cursor={h.cursor}
            x={h.x - hs / 2}
            y={h.y - hs / 2}
            width={hs}
            height={hs}
            fill="#221c17"
            stroke="#c4a484"
            strokeWidth={stroke}
            style={{ cursor: h.cursor }}
            pointerEvents={passClicksThrough ? 'none' : 'all'}
            onPointerDown={onHandleDown(h.kind)}
          />
        ))}
      </g>

      <line
        x1={topCenter.x}
        y1={topCenter.y}
        x2={handlePos.x}
        y2={handlePos.y}
        stroke="#c4a484"
        strokeWidth={stroke}
        pointerEvents="none"
      />
      <circle
        className="sel-rotate"
        cx={handlePos.x}
        cy={handlePos.y}
        r={hs / 1.5}
        fill="#e0b87a"
        style={{ cursor: rotating ? 'grabbing' : 'grab' }}
        pointerEvents={passClicksThrough ? 'none' : 'all'}
        onPointerDown={onHandleDown('rotate')}
      />
    </g>
  )
}
