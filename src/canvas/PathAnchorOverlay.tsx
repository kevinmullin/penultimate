import { useEffect } from 'react'
import { useDocStore } from '../store/documentStore'
import { anchorsToPath, parseAnchors } from '../ops/pathEdit'

/** Anchor handles for direct-selection path editing. */
export function PathAnchorOverlay({ scale }: { scale: number }) {
  const tool = useDocStore((s) => s.tool)
  const spaceHand = useDocStore((s) => s.spaceHand)
  const doc = useDocStore((s) => s.doc)
  const selectedIds = useDocStore((s) => s.selectedIds)
  const movePathAnchor = useDocStore((s) => s.movePathAnchor)
  const updatePathD = useDocStore((s) => s.updatePathD)
  const pushHistory = useDocStore((s) => s.pushHistory)
  const deletePathAnchor = useDocStore((s) => s.deletePathAnchor)
  const convertPathAnchor = useDocStore((s) => s.convertPathAnchor)
  const addPathAnchor = useDocStore((s) => s.addPathAnchor)
  const flushGroupMoves = useDocStore((s) => s.flushGroupMoves)

  const active = tool === 'direct' && !spaceHand && selectedIds.length === 1
  const activeId = active ? selectedIds[0] : null
  // The handles below position themselves from the path's raw `d` via the
  // root SVG's CTM (no ancestor-transform awareness) — bake any deferred
  // ancestor move whenever this overlay becomes active for a path, not
  // just when it was first direct-selected (the parent could have moved
  // again since, e.g. select tool → move parent → back to direct tool).
  useEffect(() => {
    if (activeId) flushGroupMoves()
  }, [activeId, flushGroupMoves])

  if (!active) return null
  const node = doc.nodes[selectedIds[0]]
  if (!node || node.type !== 'path' || node.locked) return null

  const anchors = parseAnchors(node.d)
  const hs = 6 / scale

  const localPoint = (svg: SVGSVGElement, clientX: number, clientY: number) => {
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const local = pt.matrixTransform(ctm.inverse())
    return { x: local.x, y: local.y }
  }

  const dragHandle = (
    e: React.PointerEvent,
    anchorIndex: number,
    which: 'out' | 'in',
  ) => {
    e.stopPropagation()
    const svg = (e.target as SVGElement).ownerSVGElement
    if (!svg) return
    pushHistory()
    const capture = e.currentTarget
    capture.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent) => {
      const local = localPoint(svg, ev.clientX, ev.clientY)
      const n = useDocStore.getState().doc.nodes[node.id]
      if (!n || n.type !== 'path') return
      const list = parseAnchors(n.d)
      const target = list.find((x) => x.index === anchorIndex)
      if (!target) return
      if (which === 'out') {
        target.cx = local.x
        target.cy = local.y
      } else {
        target.ix = local.x
        target.iy = local.y
      }
      updatePathD(node.id, anchorsToPath(list, false, n.d))
    }
    const onUp = () => {
      capture.releasePointerCapture(e.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <g className="path-anchors">
      {anchors.map((a) => (
        <g key={a.index}>
          {a.cx !== undefined && a.cy !== undefined && (
            <>
              <line
                x1={a.x}
                y1={a.y}
                x2={a.cx}
                y2={a.cy}
                stroke="#e0b87a"
                strokeWidth={1 / scale}
                pointerEvents="none"
              />
              <circle
                cx={a.cx}
                cy={a.cy}
                r={hs * 0.7}
                fill="#1a1a1a"
                stroke="#e0b87a"
                strokeWidth={1 / scale}
                style={{ cursor: 'crosshair' }}
                onPointerDown={(e) => dragHandle(e, a.index, 'out')}
              />
            </>
          )}
          {a.ix !== undefined && a.iy !== undefined && (
            <>
              <line
                x1={a.x}
                y1={a.y}
                x2={a.ix}
                y2={a.iy}
                stroke="#e0b87a"
                strokeWidth={1 / scale}
                pointerEvents="none"
              />
              <circle
                cx={a.ix}
                cy={a.iy}
                r={hs * 0.7}
                fill="#1a1a1a"
                stroke="#c4a484"
                strokeWidth={1 / scale}
                style={{ cursor: 'crosshair' }}
                onPointerDown={(e) => dragHandle(e, a.index, 'in')}
              />
            </>
          )}
          <rect
            x={a.x - hs}
            y={a.y - hs}
            width={hs * 2}
            height={hs * 2}
            fill="#e0b87a"
            stroke="#1a1a1a"
            strokeWidth={1 / scale}
            style={{ cursor: 'move' }}
            onPointerDown={(e) => {
              e.stopPropagation()
              const svg = (e.target as SVGElement).ownerSVGElement
              if (!svg) return
              pushHistory()
              const capture = e.currentTarget
              capture.setPointerCapture(e.pointerId)
              const onMove = (ev: PointerEvent) => {
                const local = localPoint(svg, ev.clientX, ev.clientY)
                movePathAnchor(node.id, a.index, local.x, local.y)
              }
              const onUp = () => {
                capture.releasePointerCapture(e.pointerId)
                window.removeEventListener('pointermove', onMove)
                window.removeEventListener('pointerup', onUp)
              }
              window.addEventListener('pointermove', onMove)
              window.addEventListener('pointerup', onUp)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              convertPathAnchor(node.id, a.index)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              if (e.shiftKey) addPathAnchor(node.id, a.index, a.x + 20, a.y)
              else deletePathAnchor(node.id, a.index)
            }}
          />
        </g>
      ))}
    </g>
  )
}
