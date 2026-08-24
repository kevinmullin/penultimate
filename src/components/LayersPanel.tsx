import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useDocStore } from '../store/documentStore'
import { parentOf } from '../geometry'
import { IconButton } from './Icon'
import { PanelHeader } from './PanelHeader'
import { flattenLayerRows, isLayerRowOpen } from './layerRows'
import type { VecNode } from '../types'

type DropPlace = 'before' | 'after'

type DragState = {
  id: string
  parentKey: string | null
  overId: string | null
  place: DropPlace
}

/** Initial guess before the first row is measured; real rows are all the same height. */
const DEFAULT_ROW_SLOT = 40
const OVERSCAN = 6

export function LayersPanel() {
  const doc = useDocStore((s) => s.doc)
  const selectedIds = useDocStore((s) => s.selectedIds)
  const select = useDocStore((s) => s.select)
  const reorderTo = useDocStore((s) => s.reorderTo)
  const toggleVisible = useDocStore((s) => s.toggleVisible)
  const toggleLocked = useDocStore((s) => s.toggleLocked)
  const renameNode = useDocStore((s) => s.renameNode)
  const deleteSelected = useDocStore((s) => s.deleteSelected)
  const [folded, setFolded] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<{
    id: string
    parentKey: string | null
    startY: number
    active: boolean
    pointerId: number
    overId: string | null
    place: DropPlace
  } | null>(null)
  const suppressClickRef = useRef(false)

  const flatRows = useMemo(() => flattenLayerRows(doc, collapsed), [doc, collapsed])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)
  const [rowSlot, setRowSlot] = useState(DEFAULT_ROW_SLOT)
  const measuredRef = useRef(false)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportH(el.clientHeight)
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setViewportH(entry.contentRect.height)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const measureFirstRow = useCallback((el: HTMLLIElement | null) => {
    if (!el || measuredRef.current) return
    const style = getComputedStyle(el)
    const height = el.getBoundingClientRect().height + parseFloat(style.marginBottom || '0')
    if (height > 0) {
      measuredRef.current = true
      setRowSlot(height)
    }
  }, [])

  const total = flatRows.length
  const startIndex = Math.max(0, Math.floor(scrollTop / rowSlot) - OVERSCAN)
  const endIndex = Math.min(total, Math.ceil((scrollTop + viewportH) / rowSlot) + OVERSCAN)
  const visible = flatRows.slice(startIndex, endIndex)
  const topSpacer = startIndex * rowSlot
  const bottomSpacer = (total - endIndex) * rowSlot

  const onRowPointerDown = useCallback(
    (id: string, e: ReactPointerEvent) => {
      if (e.button !== 0) return
      const target = e.target as HTMLElement
      if (target.closest('button, input, a')) return
      dragRef.current = {
        id,
        parentKey: parentOf(id, doc),
        startY: e.clientY,
        active: false,
        pointerId: e.pointerId,
        overId: null,
        place: 'before',
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [doc],
  )

  const onRowPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const pending = dragRef.current
      if (!pending || pending.pointerId !== e.pointerId) return

      if (!pending.active) {
        if (Math.abs(e.clientY - pending.startY) < 5) return
        pending.active = true
        select([pending.id], false)
        setDrag({
          id: pending.id,
          parentKey: pending.parentKey,
          overId: null,
          place: 'before',
        })
      }

      const el = document.elementFromPoint(e.clientX, e.clientY)
      const row = el?.closest('[data-layer-id]') as HTMLElement | null
      const overId = row?.dataset.layerId ?? null
      if (!overId || overId === pending.id || parentOf(overId, doc) !== pending.parentKey) {
        pending.overId = null
        setDrag({
          id: pending.id,
          parentKey: pending.parentKey,
          overId: null,
          place: 'before',
        })
        return
      }
      const rect = row!.getBoundingClientRect()
      const place: DropPlace = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
      pending.overId = overId
      pending.place = place
      setDrag({
        id: pending.id,
        parentKey: pending.parentKey,
        overId,
        place,
      })
    },
    [doc, select],
  )

  const onRowPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      const pending = dragRef.current
      if (!pending || pending.pointerId !== e.pointerId) return
      const wasDragging = pending.active
      const { id, overId, place } = pending
      dragRef.current = null
      setDrag(null)
      if (wasDragging) {
        suppressClickRef.current = true
        if (overId) reorderTo(id, overId, place)
      }
    },
    [reorderTo],
  )

  return (
    <aside className={`layers-panel${folded ? ' is-collapsed' : ''}`}>
      <PanelHeader
        title="Layers"
        collapsed={folded}
        onToggle={() => setFolded((v) => !v)}
      />
      {!folded && (
        <div
          className="layers-body"
          ref={scrollRef}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {total === 0 ? (
            <p className="panel-empty">No objects yet. Use a shape tool to draw.</p>
          ) : (
            <ul className={`layer-list${drag ? ' layer-list--dragging' : ''}`}>
              {topSpacer > 0 && <li aria-hidden style={{ height: topSpacer }} />}
              {visible.map((row, i) => {
                const rowIsOpen = isLayerRowOpen(row.node, collapsed)
                return (
                  <LayerRow
                    key={row.node.id}
                    node={row.node}
                    depth={row.depth}
                    selected={selectedSet.has(row.node.id)}
                    isOpen={rowIsOpen}
                    dragging={drag?.id === row.node.id}
                    dropBefore={drag?.overId === row.node.id && drag.place === 'before'}
                    dropAfter={drag?.overId === row.node.id && drag.place === 'after'}
                    measureRef={startIndex + i === 0 ? measureFirstRow : undefined}
                    select={select}
                    toggleVisible={toggleVisible}
                    toggleLocked={toggleLocked}
                    renameNode={renameNode}
                    deleteSelected={deleteSelected}
                    onToggleCollapse={() =>
                      setCollapsed((c) => ({ ...c, [row.node.id]: rowIsOpen }))
                    }
                    suppressClickRef={suppressClickRef}
                    onRowPointerDown={onRowPointerDown}
                    onRowPointerMove={onRowPointerMove}
                    onRowPointerUp={onRowPointerUp}
                  />
                )
              })}
              {bottomSpacer > 0 && <li aria-hidden style={{ height: bottomSpacer }} />}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}

type LayerRowProps = {
  node: VecNode
  depth: number
  selected: boolean
  isOpen: boolean
  dragging: boolean
  dropBefore: boolean
  dropAfter: boolean
  measureRef?: (el: HTMLLIElement | null) => void
  select: (ids: string[], additive?: boolean) => void
  toggleVisible: (id: string) => void
  toggleLocked: (id: string) => void
  renameNode: (id: string, name: string) => void
  deleteSelected: () => void
  onToggleCollapse: () => void
  suppressClickRef: { current: boolean }
  onRowPointerDown: (id: string, e: ReactPointerEvent) => void
  onRowPointerMove: (e: ReactPointerEvent) => void
  onRowPointerUp: (e: ReactPointerEvent) => void
}

function layerRowPropsEqual(prev: LayerRowProps, next: LayerRowProps): boolean {
  return (
    prev.node === next.node &&
    prev.depth === next.depth &&
    prev.selected === next.selected &&
    prev.isOpen === next.isOpen &&
    prev.dragging === next.dragging &&
    prev.dropBefore === next.dropBefore &&
    prev.dropAfter === next.dropAfter &&
    prev.measureRef === next.measureRef &&
    prev.select === next.select &&
    prev.toggleVisible === next.toggleVisible &&
    prev.toggleLocked === next.toggleLocked &&
    prev.renameNode === next.renameNode &&
    prev.deleteSelected === next.deleteSelected &&
    prev.onToggleCollapse === next.onToggleCollapse &&
    prev.suppressClickRef === next.suppressClickRef &&
    prev.onRowPointerDown === next.onRowPointerDown &&
    prev.onRowPointerMove === next.onRowPointerMove &&
    prev.onRowPointerUp === next.onRowPointerUp
  )
}

/** A single flattened layer row — leaf renderer, no recursion (see layerRows.ts). */
const LayerRow = memo(function LayerRow({
  node,
  depth,
  selected,
  isOpen,
  dragging,
  dropBefore,
  dropAfter,
  measureRef,
  select,
  toggleVisible,
  toggleLocked,
  renameNode,
  deleteSelected,
  onToggleCollapse,
  suppressClickRef,
  onRowPointerDown,
  onRowPointerMove,
  onRowPointerUp,
}: LayerRowProps) {
  const id = node.id
  const isGroup = node.type === 'group'

  return (
    <li
      ref={measureRef}
      data-layer-id={id}
      className={[
        'layer-row',
        `layer-row--${node.type}`,
        node.type === 'rect' && (node.rx ?? 0) > 0 ? 'layer-row--round' : '',
        selected ? 'layer-row--selected' : '',
        !node.visible ? 'layer-row--hidden' : '',
        node.locked ? 'layer-row--locked' : '',
        node.type === 'group' && node.clipped ? 'layer-row--clip' : '',
        dragging ? 'layer-row--dragging' : '',
        dropBefore ? 'layer-row--drop-before' : '',
        dropAfter ? 'layer-row--drop-after' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ ['--layer-depth' as string]: String(depth) }}
      onClick={(e) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        select([id], e.shiftKey)
      }}
      onPointerDown={(e) => onRowPointerDown(id, e)}
      onPointerMove={onRowPointerMove}
      onPointerUp={onRowPointerUp}
      onPointerCancel={onRowPointerUp}
    >
      <div className="layer-row__main">
        {isGroup ? (
          <button
            type="button"
            className="layer-twist"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleCollapse()
            }}
          >
            {isOpen ? '▾' : '▸'}
          </button>
        ) : (
          <span className="layer-twist layer-twist--spacer" />
        )}
        <span className="layer-glyph" aria-hidden="true" />
        <IconButton
          icon={node.visible ? 'visible' : 'hidden'}
          label={node.visible ? 'Hide' : 'Show'}
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            toggleVisible(id)
          }}
        />
        <IconButton
          icon={node.locked ? 'locked' : 'unlocked'}
          label={node.locked ? 'Unlock' : 'Lock'}
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            toggleLocked(id)
          }}
        />
        <span className="layer-type" title={node.type}>
          {shortType(node)}
          {node.type === 'group' && node.clipped ? ' ✂' : ''}
        </span>
        <input
          className="layer-name"
          defaultValue={node.name}
          key={`${id}-${node.name}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const next = e.target.value.trim() || node.name
            if (next !== node.name) renameNode(id, next)
          }}
        />
        <IconButton
          icon="delete"
          label="Delete"
          danger
          className="icon-btn"
          onClick={(e) => {
            e.stopPropagation()
            select([id])
            deleteSelected()
          }}
        />
      </div>
    </li>
  )
}, layerRowPropsEqual)

function shortType(node: VecNode): string {
  if (node.type === 'rect' && (node.rx ?? 0) > 0) return 'round'
  switch (node.type) {
    case 'ellipse':
      return 'oval'
    case 'image':
      return 'img'
    default:
      return node.type
  }
}
