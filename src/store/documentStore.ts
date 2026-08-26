import { create } from 'zustand'
import { snapBBox, snapPoint } from '../canvas/snap'
import {
  bakeAllPendingMoves,
  buildParentIndex,
  collectDescendants,
  nodeBBox,
  parentOf,
  pathBBox,
  scaleNodeFromBox,
  selectionBBox,
  setNodeRotation,
  translateNode,
  unionBoxes,
} from '../geometry'
import { alignNodes, distributeNodes, type AlignMode, type DistributeMode } from '../ops/align'
import { makeClippingMask, releaseClippingMask } from '../ops/clipMask'
import { groupSelected, nextId, ungroupSelected } from '../ops/group'
import { pathfinder, type PathfinderOp } from '../ops/pathfinder'
import { joinSelectedPaths as joinPathsOp, scissorsSplit } from '../ops/pathSplit'
import { offsetSelected, outlineStrokeSelected as outlineStrokeOp } from '../ops/offsetPath'
import { shearNodes } from '../ops/shear'
import {
  addAnchorAfter,
  convertAnchor,
  deleteAnchor,
  moveAnchor,
} from '../ops/pathEdit'
import { reflectNodes, type ReflectAxis } from '../ops/reflect'
import { paintNone, paintSolid } from '../style/paint'
import {
  createArtboardFrame,
  createEmptyDocument,
  defaultStyle,
  defaultTextStyle,
  normalizeNode,
  syncArtboardFromActive,
  type ArtboardFrame,
  type BBox,
  type GroupNode,
  type PathNode,
  type SnapGuide,
  type Tool,
  type VecNode,
  type VectorDocument,
} from '../types'

const MAX_HISTORY = 50

type Snapshot = Pick<
  VectorDocument,
  | 'name'
  | 'artboard'
  | 'artboards'
  | 'activeArtboardId'
  | 'settings'
  | 'nodes'
  | 'zOrder'
  | 'swatches'
  | 'manualGuides'
>

type PenDraft = {
  points: Array<{ x: number; y: number; cx?: number; cy?: number }>
}

type DocState = {
  doc: VectorDocument
  selectedIds: string[]
  tool: Tool
  /** Space held — temporary hand pan without switching the tool rail. */
  spaceHand: boolean
  guides: SnapGuide[]
  penDraft: PenDraft | null
  draftNode: VecNode | null
  /**
   * Live translate offset for an in-progress move drag, shown as an SVG
   * transform instead of mutating every selected node's geometry per
   * pointermove — keeps dragging large groups (5000+ children) smooth.
   * Committed into the document once via `moveSelectedTo` on pointer up.
   */
  dragOffset: { dx: number; dy: number } | null
  past: Snapshot[]
  future: Snapshot[]
  outlineMode: boolean
  aspectLock: boolean
  showRulers: boolean
  /** Artboard display scale (1 = 100%). */
  zoom: number
  /** When true, resize no longer auto-fits the artboard. */
  zoomPinned: boolean
  /** Bump to ask Artboard to re-fit into the viewport. */
  fitNonce: number
  settingsOpen: boolean
  helpOpen: boolean
  /** Exact-size create dialog for shape tools (click without drag). */
  shapeDialog: null | {
    kind: 'rect' | 'rounded-rect' | 'ellipse' | 'line' | 'polygon' | 'star'
    x: number
    y: number
  }
  /** Id of the ImageNode open in the "Convert to SVG" dialog, null = closed. */
  svgTraceNodeId: string | null
  /** Canvas text edit session — blocks tool hotkeys even if focus slips. */
  editingTextId: string | null
  /** Last soft-save timestamp (ms), null until first write. */
  autosaveAt: number | null

  setTool: (tool: Tool) => void
  setSpaceHand: (on: boolean) => void
  setGuides: (guides: SnapGuide[]) => void
  setDraftNode: (node: VecNode | null) => void
  setDragOffset: (offset: { dx: number; dy: number } | null) => void
  select: (ids: string[], additive?: boolean) => void
  clearSelection: () => void
  setOutlineMode: (on: boolean) => void
  setAspectLock: (on: boolean) => void
  setShowRulers: (on: boolean) => void
  setZoom: (zoom: number, pinned?: boolean) => void
  zoomBy: (factor: number) => void
  requestFitZoom: () => void
  zoomTo100: () => void
  setSettingsOpen: (open: boolean) => void
  toggleSettingsOpen: () => void
  setHelpOpen: (open: boolean) => void
  toggleHelpOpen: () => void
  setShapeDialog: (
    dialog: DocState['shapeDialog'],
  ) => void
  setSvgTraceNodeId: (id: string | null) => void
  /**
   * Insert traced paths as a new group above `imageNodeId` and hide the
   * original raster (kept, not deleted). One history checkpoint.
   */
  commitSvgTrace: (
    imageNodeId: string,
    paths: Array<{
      d: string
      fillHex: string
      strokeHex: string
      strokeWidth: number
      opacity: number
    }>,
    clip?: { d: string },
  ) => void
  setEditingTextId: (id: string | null) => void
  setAutosaveAt: (at: number | null) => void

  pushHistory: () => void
  undo: () => void
  redo: () => void

  setName: (name: string) => void
  setArtboardSize: (width: number, height: number) => void
  setArtboardBackground: (background: string | null, recordHistory?: boolean) => void
  setSettings: (partial: Partial<VectorDocument['settings']>) => void
  setActiveArtboard: (id: string) => void
  addArtboard: () => void
  removeActiveArtboard: () => void
  removeArtboard: (id: string) => void
  renameArtboard: (id: string, name: string) => void
  /** Delete objects that intersect the active artboard (undoable). */
  clearActiveArtboard: () => void
  /** Clear objects on a specific artboard (undoable). */
  clearArtboard: (id: string) => void

  addNode: (node: VecNode) => void
  updateNode: (id: string, patch: Partial<VecNode>, recordHistory?: boolean) => void
  updateNodes: (nodes: Record<string, VecNode>, recordHistory?: boolean) => void
  deleteSelected: () => void
  reorder: (id: string, direction: 'up' | 'down') => void
  /** Place `id` before/after `targetId` in the Layers panel (siblings only). */
  reorderTo: (
    id: string,
    targetId: string,
    place: 'before' | 'after',
  ) => void
  renameNode: (id: string, name: string) => void
  toggleVisible: (id: string) => void
  toggleLocked: (id: string) => void

  nudgeSelected: (dx: number, dy: number) => void
  moveSelectedTo: (
    x: number,
    y: number,
    othersOverride?: BBox[],
    originBoxOverride?: BBox,
  ) => void
  resizeSelectionTo: (newBox: { x: number; y: number; width: number; height: number }) => void
  rotateSelected: (rotation: number) => void
  applyStyleToSelected: (
    stylePatch: Partial<VecNode['style']>,
    recordHistory?: boolean,
  ) => void
  reflectSelected: (axis: ReflectAxis) => void
  sampleStyleFromNode: (id: string) => void

  align: (mode: AlignMode, relativeToArtboard?: boolean) => void
  distribute: (mode: DistributeMode) => void
  group: () => void
  ungroup: () => void
  makeClipMask: () => void
  releaseClipMask: () => void
  reorderExtreme: (direction: 'front' | 'back') => void
  duplicateSelected: () => void
  copySelected: () => void
  pasteClipboard: () => void
  pathfinderSelected: (op: PathfinderOp) => void
  joinSelectedPaths: () => void
  scissorsAt: (pathId: string, x: number, y: number) => void
  outlineStrokeSelected: () => void
  offsetPathSelected: (distance: number) => void
  shearSelected: (axis: 'x' | 'y', amount: number) => void
  addManualGuide: (guide: SnapGuide) => void
  removeManualGuide: (index: number) => void
  clearManualGuides: () => void
  updatePathD: (id: string, d: string, recordHistory?: boolean) => void
  movePathAnchor: (id: string, anchorIndex: number, x: number, y: number) => void
  deletePathAnchor: (id: string, anchorIndex: number) => void
  addPathAnchor: (id: string, afterIndex: number, x: number, y: number) => void
  convertPathAnchor: (id: string, anchorIndex: number) => void
  /** Bake every top-level group's deferred move (see `GroupNode.pendingMove`) into real child coordinates. */
  flushGroupMoves: () => void

  addSwatch: (color: string) => void
  addSwatches: (colors: string[]) => void
  removeSwatch: (color: string) => void
  applySwatch: (color: string, target: 'fill' | 'stroke') => void

  beginPen: () => void
  addPenPoint: (x: number, y: number, control?: { cx: number; cy: number }) => void
  finishPen: (opts?: { close?: boolean }) => void
  cancelPen: () => void

  loadDocument: (doc: VectorDocument) => void
  getDocument: () => VectorDocument
}

let clipboard: { nodes: Record<string, VecNode>; zOrder: string[] } | null = null

/**
 * INVARIANT this relies on: node objects (and artboards/manualGuides
 * elements) are never mutated in place anywhere in this codebase — every
 * update replaces the whole object via spread (`{ ...n, ...patch }`).
 * That means a shallow copy of `nodes`/`artboards`/`manualGuides` is enough
 * for undo/redo correctness; a deep `structuredClone` per node is wasted
 * work (real cost on large documents). If any future code ever mutates a
 * live node's fields in place instead of replacing the node, this shallow
 * copy would silently corrupt history snapshots — don't do that.
 */
function snapshotOf(doc: VectorDocument): Snapshot {
  return {
    name: doc.name,
    artboard: { ...doc.artboard },
    artboards: [...doc.artboards],
    activeArtboardId: doc.activeArtboardId,
    settings: { ...doc.settings },
    nodes: { ...doc.nodes },
    zOrder: [...doc.zOrder],
    swatches: [...doc.swatches],
    manualGuides: [...doc.manualGuides],
  }
}

/** See the invariant documented on `snapshotOf` above — applies here too. */
function applySnapshot(s: Snapshot): VectorDocument {
  return syncArtboardFromActive({
    version: 1,
    name: s.name,
    artboard: { ...s.artboard },
    artboards: [...s.artboards],
    activeArtboardId: s.activeArtboardId,
    settings: { ...s.settings },
    nodes: { ...s.nodes },
    zOrder: [...s.zOrder],
    swatches: [...(s.swatches ?? [])],
    manualGuides: [...(s.manualGuides ?? [])],
  })
}

function pointsToPath(
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

export const useDocStore = create<DocState>((set, get) => ({
  doc: createEmptyDocument(),
  selectedIds: [],
  tool: 'select',
  spaceHand: false,
  guides: [],
  penDraft: null,
  draftNode: null,
  dragOffset: null,
  past: [],
  future: [],
  outlineMode: false,
  aspectLock: false,
  showRulers: true,
  zoom: 1,
  zoomPinned: false,
  fitNonce: 0,
  settingsOpen: false,
  helpOpen: false,
  shapeDialog: null,
  svgTraceNodeId: null,
  editingTextId: null,
  autosaveAt: null,

  setTool: (tool) => set({ tool, penDraft: tool === 'pen' ? { points: [] } : null }),
  setSpaceHand: (on) => set({ spaceHand: on }),
  setGuides: (guides) => set({ guides }),
  setDraftNode: (node) => set({ draftNode: node }),
  setDragOffset: (offset) => set({ dragOffset: offset }),
  setOutlineMode: (outlineMode) => set({ outlineMode }),
  setAspectLock: (aspectLock) => set({ aspectLock }),
  setShowRulers: (showRulers) => set({ showRulers }),
  setZoom: (zoom, pinned = true) =>
    set({
      zoom: Math.min(64, Math.max(0.05, zoom)),
      zoomPinned: pinned,
    }),
  zoomBy: (factor) => {
    const { zoom } = get()
    set({
      zoom: Math.min(64, Math.max(0.05, zoom * factor)),
      zoomPinned: true,
    })
  },
  requestFitZoom: () =>
    set((s) => ({ fitNonce: s.fitNonce + 1, zoomPinned: false })),
  zoomTo100: () => set({ zoom: 1, zoomPinned: true }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleSettingsOpen: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  toggleHelpOpen: () => set((s) => ({ helpOpen: !s.helpOpen })),
  setShapeDialog: (shapeDialog) => set({ shapeDialog }),
  setSvgTraceNodeId: (svgTraceNodeId) => set({ svgTraceNodeId }),

  commitSvgTrace: (imageNodeId, paths, clip) => {
    const { doc } = get()
    const imageNode = doc.nodes[imageNodeId]
    if (!imageNode || imageNode.type !== 'image' || paths.length === 0) return

    get().pushHistory()

    const nodes = { ...doc.nodes }
    const pathIds: string[] = []
    for (const p of paths) {
      const id = nextId('path')
      const pathNode: PathNode = normalizeNode({
        id,
        type: 'path',
        name: 'Traced Path',
        visible: true,
        locked: false,
        rotation: 0,
        style: {
          ...defaultStyle(),
          fill: paintSolid(p.fillHex),
          stroke: paintSolid(p.strokeHex),
          strokeWidth: p.strokeWidth,
          opacity: p.opacity,
        },
        d: p.d,
      }) as PathNode
      nodes[id] = pathNode
      pathIds.push(id)
    }

    const box = unionBoxes(pathIds.map((id) => pathBBox((nodes[id] as PathNode).d)))
    const groupId = nextId('group')

    let children = pathIds
    let clipped: true | undefined
    if (clip) {
      const clipId = nextId('path')
      const clipNode: PathNode = normalizeNode({
        id: clipId,
        type: 'path',
        name: 'Background Clip',
        visible: false,
        locked: false,
        rotation: 0,
        style: defaultStyle(),
        d: clip.d,
      }) as PathNode
      nodes[clipId] = clipNode
      children = [clipId, ...pathIds]
      clipped = true
    }

    const group: GroupNode = {
      id: groupId,
      type: 'group',
      name: 'Traced SVG',
      visible: true,
      locked: false,
      rotation: 0,
      style: defaultStyle(),
      children,
      x: box.x,
      y: box.y,
      clipped,
    }
    nodes[groupId] = group
    nodes[imageNodeId] = { ...imageNode, visible: false }

    const imgIndex = doc.zOrder.indexOf(imageNodeId)
    const zOrder = [...doc.zOrder]
    zOrder.splice(imgIndex + 1, 0, groupId)

    set((s) => ({
      doc: { ...s.doc, nodes, zOrder },
      selectedIds: [groupId],
    }))
  },

  setEditingTextId: (editingTextId) => set({ editingTextId }),
  setAutosaveAt: (autosaveAt) => set({ autosaveAt }),

  select: (ids, additive = false) => {
    set((s) => {
      if (!additive) return { selectedIds: ids }
      const next = new Set(s.selectedIds)
      for (const id of ids) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return { selectedIds: [...next] }
    })
  },

  clearSelection: () => set({ selectedIds: [] }),

  pushHistory: () => {
    const { doc, past } = get()
    const next = [...past, snapshotOf(doc)]
    if (next.length > MAX_HISTORY) next.shift()
    set({ past: next, future: [] })
  },

  undo: () => {
    const { past, doc, future } = get()
    if (past.length === 0) return
    const prev = past[past.length - 1]
    set({
      past: past.slice(0, -1),
      future: [snapshotOf(doc), ...future].slice(0, MAX_HISTORY),
      doc: applySnapshot(prev),
      guides: [],
      draftNode: null,
    })
  },

  redo: () => {
    const { past, doc, future } = get()
    if (future.length === 0) return
    const next = future[0]
    set({
      future: future.slice(1),
      past: [...past, snapshotOf(doc)].slice(-MAX_HISTORY),
      doc: applySnapshot(next),
      guides: [],
      draftNode: null,
    })
  },

  setName: (name) => set((s) => ({ doc: { ...s.doc, name } })),

  setArtboardSize: (width, height) => {
    get().pushHistory()
    set((s) => {
      const artboards = s.doc.artboards.map((a) =>
        a.id === s.doc.activeArtboardId
          ? { ...a, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }
          : a,
      )
      return { doc: syncArtboardFromActive({ ...s.doc, artboards }) }
    })
  },

  setArtboardBackground: (background, recordHistory = true) => {
    if (recordHistory) get().pushHistory()
    set((s) => {
      const artboards = s.doc.artboards.map((a) =>
        a.id === s.doc.activeArtboardId ? { ...a, background } : a,
      )
      return { doc: syncArtboardFromActive({ ...s.doc, artboards }) }
    })
  },

  setSettings: (partial) => {
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, settings: { ...s.doc.settings, ...partial } },
    }))
  },

  setActiveArtboard: (id) => {
    set((s) => {
      if (!s.doc.artboards.some((a) => a.id === id)) return s
      return { doc: syncArtboardFromActive({ ...s.doc, activeArtboardId: id }) }
    })
  },

  addArtboard: () => {
    get().pushHistory()
    set((s) => {
      const last = s.doc.artboards[s.doc.artboards.length - 1]
      const frame: ArtboardFrame = createArtboardFrame({
        name: `Artboard ${s.doc.artboards.length + 1}`,
        x: (last?.x ?? 0) + (last?.width ?? 800) + 40,
        y: last?.y ?? 0,
        width: last?.width ?? 800,
        height: last?.height ?? 600,
        background: last?.background ?? '#ffffff',
      })
      return {
        doc: syncArtboardFromActive({
          ...s.doc,
          artboards: [...s.doc.artboards, frame],
          activeArtboardId: frame.id,
        }),
      }
    })
  },

  removeActiveArtboard: () => {
    get().removeArtboard(get().doc.activeArtboardId)
  },

  removeArtboard: (id) => {
    if (get().doc.artboards.length <= 1) return
    if (!get().doc.artboards.some((a) => a.id === id)) return
    get().pushHistory()
    set((s) => {
      const artboards = s.doc.artboards.filter((a) => a.id !== id)
      const activeArtboardId =
        s.doc.activeArtboardId === id ? artboards[0].id : s.doc.activeArtboardId
      return {
        doc: syncArtboardFromActive({
          ...s.doc,
          artboards,
          activeArtboardId,
        }),
      }
    })
  },

  renameArtboard: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    get().pushHistory()
    set((s) => ({
      doc: {
        ...s.doc,
        artboards: s.doc.artboards.map((a) =>
          a.id === id ? { ...a, name: trimmed } : a,
        ),
      },
    }))
  },

  clearActiveArtboard: () => {
    get().clearArtboard(get().doc.activeArtboardId)
  },

  clearArtboard: (id) => {
    const { doc } = get()
    const ab = doc.artboards.find((a) => a.id === id)
    if (!ab) return
    const frame = { x: ab.x, y: ab.y, width: ab.width, height: ab.height }
    const toDelete = new Set<string>()
    for (const nid of doc.zOrder) {
      const n = doc.nodes[nid]
      if (!n) continue
      const box = nodeBBox(n, doc)
      const overlaps =
        box.x < frame.x + frame.width &&
        box.x + box.width > frame.x &&
        box.y < frame.y + frame.height &&
        box.y + box.height > frame.y
      if (!overlaps) continue
      for (const d of collectDescendants(nid, doc)) toDelete.add(d)
    }
    if (toDelete.size === 0) return
    get().pushHistory()
    const nodes = { ...doc.nodes }
    for (const delId of toDelete) delete nodes[delId]
    set({
      doc: {
        ...doc,
        nodes,
        zOrder: doc.zOrder.filter((nid) => !toDelete.has(nid)),
      },
      selectedIds: [],
      guides: [],
      draftNode: null,
      penDraft: null,
      editingTextId: null,
      shapeDialog: null,
    })
  },

  addNode: (node) => {
    // Never persist the in-progress draft id into the document.
    const id = !node.id || node.id === 'draft' ? nextId(node.type) : node.id
    const committed = { ...node, id }
    set((s) => {
      const nextPast = [...s.past, snapshotOf(s.doc)]
      if (nextPast.length > MAX_HISTORY) nextPast.shift()
      return {
        past: nextPast,
        future: [],
        doc: {
          ...s.doc,
          nodes: { ...s.doc.nodes, [id]: committed },
          zOrder: [...s.doc.zOrder, id],
        },
        selectedIds: [id],
        draftNode: null,
      }
    })
  },

  updateNode: (id, patch, recordHistory = false) => {
    if (recordHistory) get().pushHistory()
    set((s) => {
      const prev = s.doc.nodes[id]
      if (!prev) return s
      return {
        doc: {
          ...s.doc,
          nodes: { ...s.doc.nodes, [id]: { ...prev, ...patch } as VecNode },
        },
      }
    })
  },

  updateNodes: (nodes, recordHistory = false) => {
    if (recordHistory) get().pushHistory()
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  deleteSelected: () => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    const toDelete = new Set<string>()
    for (const id of selectedIds) {
      for (const d of collectDescendants(id, doc)) toDelete.add(d)
    }
    const nodes = { ...doc.nodes }
    for (const id of toDelete) {
      // Remove from parent group children lists
      const parent = parentOf(id, doc)
      if (parent && nodes[parent]?.type === 'group') {
        const g = nodes[parent]
        if (g.type === 'group') {
          nodes[parent] = { ...g, children: g.children.filter((c) => c !== id) }
        }
      }
      delete nodes[id]
    }
    set({
      doc: {
        ...doc,
        nodes,
        zOrder: doc.zOrder.filter((id) => !toDelete.has(id)),
      },
      selectedIds: [],
      guides: [],
    })
  },

  reorder: (id, direction) => {
    const { doc } = get()
    const parentId = parentOf(id, doc)
    if (parentId) {
      const parent = doc.nodes[parentId]
      if (!parent || parent.type !== 'group') return
      const children = [...parent.children]
      const idx = children.indexOf(id)
      if (idx < 0) return
      const swap = direction === 'up' ? idx + 1 : idx - 1
      if (swap < 0 || swap >= children.length) return
      get().pushHistory()
      ;[children[idx], children[swap]] = [children[swap], children[idx]]
      set((s) => ({
        doc: {
          ...s.doc,
          nodes: { ...s.doc.nodes, [parentId]: { ...parent, children } },
        },
      }))
      return
    }
    const idx = doc.zOrder.indexOf(id)
    if (idx < 0) return
    const swap = direction === 'up' ? idx + 1 : idx - 1
    if (swap < 0 || swap >= doc.zOrder.length) return
    get().pushHistory()
    const zOrder = [...doc.zOrder]
    ;[zOrder[idx], zOrder[swap]] = [zOrder[swap], zOrder[idx]]
    set((s) => ({ doc: { ...s.doc, zOrder } }))
  },

  reorderTo: (id, targetId, place) => {
    if (id === targetId) return
    const { doc } = get()
    const dragParent = parentOf(id, doc)
    const targetParent = parentOf(targetId, doc)
    if (dragParent !== targetParent) return

    const insertInVisual = (stack: string[]) => {
      // Panel lists front→back (reverse of draw order).
      const visual = [...stack].reverse()
      if (!visual.includes(id) || !visual.includes(targetId)) return null
      const next = visual.filter((x) => x !== id)
      let idx = next.indexOf(targetId)
      if (idx < 0) return null
      if (place === 'after') idx += 1
      next.splice(idx, 0, id)
      return next.reverse()
    }

    if (dragParent) {
      const parent = doc.nodes[dragParent]
      if (!parent || parent.type !== 'group') return
      const children = insertInVisual(parent.children)
      if (!children) return
      const same =
        children.length === parent.children.length &&
        children.every((c, i) => c === parent.children[i])
      if (same) return
      get().pushHistory()
      set((s) => ({
        doc: {
          ...s.doc,
          nodes: {
            ...s.doc.nodes,
            [dragParent]: { ...parent, children },
          },
        },
      }))
      return
    }

    const zOrder = insertInVisual(doc.zOrder)
    if (!zOrder) return
    const same =
      zOrder.length === doc.zOrder.length &&
      zOrder.every((c, i) => c === doc.zOrder[i])
    if (same) return
    get().pushHistory()
    set((s) => ({ doc: { ...s.doc, zOrder } }))
  },

  renameNode: (id, name) => {
    get().updateNode(id, { name } as Partial<VecNode>, true)
  },

  toggleVisible: (id) => {
    const n = get().doc.nodes[id]
    if (!n) return
    get().updateNode(id, { visible: !n.visible } as Partial<VecNode>, true)
  },

  toggleLocked: (id) => {
    const n = get().doc.nodes[id]
    if (!n) return
    get().updateNode(id, { locked: !n.locked } as Partial<VecNode>, true)
  },

  nudgeSelected: (dx, dy) => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    const nodes = { ...doc.nodes }
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || n.locked) continue
      nodes[id] = translateNode(n, dx, dy)
      if (n.type === 'group') {
        for (const childId of n.children) {
          const child = nodes[childId]
          if (child) nodes[childId] = translateNode(child, dx, dy)
        }
      }
    }
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  moveSelectedTo: (x, y, othersOverride, originBoxOverride) => {
    const { selectedIds, doc } = get()
    // Callers that already tracked the drag from a fixed origin (Artboard,
    // SelectionOverlay) pass it straight through — the document hasn't
    // moved since then, so recomputing it here would just be another full
    // bbox union (path-bounds parse for every selected node) for nothing.
    const box = originBoxOverride ?? selectionBBox(selectedIds, doc)
    if (!box) return
    const others =
      othersOverride ??
      (() => {
        const parentIndex = buildParentIndex(doc)
        return Object.values(doc.nodes)
          .filter((n) => n.visible && !selectedIds.includes(n.id) && !parentIndex.has(n.id))
          .map((n) => nodeBBox(n, doc))
      })()
    const snapped = snapBBox(
      { ...box, x, y },
      others,
      doc.artboards,
      doc.settings,
      doc.manualGuides,
    )
    const dx = snapped.x - box.x
    const dy = snapped.y - box.y

    // Moving a single top-level group: defer baking the offset into every
    // child (that's what makes dragging a huge traced-SVG group slow) —
    // accumulate it on the group itself and render it as a transform.
    // Anything that later needs real child geometry bakes it first via
    // `bakeGroupMove` (geometry.ts).
    if (selectedIds.length === 1) {
      const only = doc.nodes[selectedIds[0]]
      // Restricted to top-level groups: keeps "only a top-level group can
      // carry an unflushed pendingMove" a simple invariant (bakeAllPendingMoves
      // only scans zOrder, not nested children) — a nested group can be
      // selected directly from the Layers panel, so this can't be assumed.
      if (only && !only.locked && only.type === 'group' && !parentOf(only.id, doc)) {
        const prev = only.pendingMove ?? { dx: 0, dy: 0 }
        const nodes = {
          ...doc.nodes,
          [only.id]: { ...only, pendingMove: { dx: prev.dx + dx, dy: prev.dy + dy } },
        }
        set((s) => ({ doc: { ...s.doc, nodes }, guides: snapped.guides }))
        return
      }
    }

    const nodes = { ...doc.nodes }
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || n.locked) continue
      nodes[id] = translateNode(n, dx, dy)
      if (n.type === 'group') {
        for (const childId of n.children) {
          const child = nodes[childId]
          if (child) nodes[childId] = translateNode(child, dx, dy)
        }
      }
    }
    set((s) => ({ doc: { ...s.doc, nodes }, guides: snapped.guides }))
  },

  resizeSelectionTo: (newBox) => {
    const { selectedIds } = get()
    // Resize needs every child's real geometry to scale it — bake any
    // deferred move first (see `moveSelectedTo` / `bakeAllPendingMoves`).
    const doc = bakeAllPendingMoves(get().doc)
    const oldBox = selectionBBox(selectedIds, doc)
    if (!oldBox) return
    const nodes = { ...doc.nodes }
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || n.locked) continue
      if (n.type === 'group') {
        for (const childId of n.children) {
          const child = nodes[childId]
          if (child) nodes[childId] = scaleNodeFromBox(child, oldBox, newBox)
        }
        nodes[id] = scaleNodeFromBox(n, oldBox, newBox)
      } else {
        nodes[id] = scaleNodeFromBox(n, oldBox, newBox)
      }
    }
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  rotateSelected: (rotation) => {
    const { selectedIds, doc } = get()
    const nodes = { ...doc.nodes }
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || n.locked) continue
      nodes[id] = setNodeRotation(n, rotation)
    }
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  applyStyleToSelected: (stylePatch, recordHistory = true) => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    if (recordHistory) get().pushHistory()
    const nodes = { ...doc.nodes }
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || n.locked) continue
      nodes[id] = { ...n, style: { ...n.style, ...stylePatch } }
    }
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  reflectSelected: (axis) => {
    const { selectedIds } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    // reflectNodes mutates the group node and its children independently
    // (see ops/reflect.ts) — bake any deferred move first so it doesn't
    // double up with the reflect.
    const doc = bakeAllPendingMoves(get().doc)
    const nodes = reflectNodes(doc, selectedIds, axis)
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  sampleStyleFromNode: (id) => {
    const { doc, selectedIds } = get()
    const src = doc.nodes[id]
    if (!src || src.type === 'group') return
    if (selectedIds.length === 0) {
      // No selection: stash onto next draw via default — apply to nothing, keep eyedropper
      return
    }
    get().pushHistory()
    const nodes = { ...doc.nodes }
    for (const sid of selectedIds) {
      const n = nodes[sid]
      if (!n || n.locked || n.type === 'group' || n.type === 'image') continue
      nodes[sid] = { ...n, style: { ...structuredClone(src.style) } }
    }
    set((s) => ({ doc: { ...s.doc, nodes }, tool: 'select' }))
  },

  align: (mode, relativeToArtboard = false) => {
    const { selectedIds } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    const doc = bakeAllPendingMoves(get().doc)
    const nodes = alignNodes(doc, selectedIds, mode, relativeToArtboard)
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  distribute: (mode) => {
    const { selectedIds } = get()
    if (selectedIds.length < 3) return
    get().pushHistory()
    const doc = bakeAllPendingMoves(get().doc)
    const nodes = distributeNodes(doc, selectedIds, mode)
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  group: () => {
    const { selectedIds } = get()
    // Keeps "only top-level groups carry an unflushed move" simple —
    // otherwise a group-with-pendingMove could end up nested.
    const doc = bakeAllPendingMoves(get().doc)
    const result = groupSelected(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: [result.groupId],
    }))
  },

  ungroup: () => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = ungroupSelected(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: result.revealed,
    }))
  },

  makeClipMask: () => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = makeClippingMask(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: [result.groupId],
    }))
  },

  releaseClipMask: () => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = releaseClippingMask(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: result.revealed,
    }))
  },

  reorderExtreme: (direction) => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    const moving = selectedIds.filter((id) => doc.zOrder.includes(id))
    const rest = doc.zOrder.filter((id) => !moving.includes(id))
    const zOrder = direction === 'front' ? [...rest, ...moving] : [...moving, ...rest]
    set((s) => ({ doc: { ...s.doc, zOrder } }))
  },

  duplicateSelected: () => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    const nodes = { ...doc.nodes }
    const zOrder = [...doc.zOrder]
    const newIds: string[] = []
    for (const id of selectedIds) {
      const n = nodes[id]
      if (!n || parentOf(id, doc)) continue
      const nid = nextId(n.type)
      const clone = structuredClone(n) as VecNode
      clone.id = nid
      clone.name = `${n.name} copy`
      nodes[nid] = translateNode(clone, 16, 16)
      if (n.type === 'group') {
        const childMap: string[] = []
        for (const cid of n.children) {
          const child = nodes[cid]
          if (!child) continue
          const ccid = nextId(child.type)
          const cclone = translateNode(structuredClone(child) as VecNode, 16, 16)
          cclone.id = ccid
          nodes[ccid] = cclone
          childMap.push(ccid)
        }
        const g = nodes[nid]
        if (g.type === 'group') nodes[nid] = { ...g, children: childMap }
      }
      zOrder.push(nid)
      newIds.push(nid)
    }
    set((s) => ({ doc: { ...s.doc, nodes, zOrder }, selectedIds: newIds }))
  },

  copySelected: () => {
    const { selectedIds, doc } = get()
    if (selectedIds.length === 0) return
    const nodes: Record<string, VecNode> = {}
    const zOrder: string[] = []
    for (const id of selectedIds) {
      const n = doc.nodes[id]
      if (!n || parentOf(id, doc)) continue
      nodes[id] = structuredClone(n)
      zOrder.push(id)
      if (n.type === 'group') {
        for (const cid of n.children) {
          const c = doc.nodes[cid]
          if (c) nodes[cid] = structuredClone(c)
        }
      }
    }
    clipboard = { nodes, zOrder }
  },

  pasteClipboard: () => {
    if (!clipboard || clipboard.zOrder.length === 0) return
    get().pushHistory()
    const { doc } = get()
    const nodes = { ...doc.nodes }
    const zOrder = [...doc.zOrder]
    const idMap = new Map<string, string>()
    const newTopIds: string[] = []

    // Map every copied id (top-level + group children) to fresh ids
    for (const oldId of Object.keys(clipboard.nodes)) {
      const src = clipboard.nodes[oldId]
      idMap.set(oldId, nextId(src.type))
    }

    for (const [oldId, newId] of idMap) {
      const src = structuredClone(clipboard.nodes[oldId]) as VecNode
      src.id = newId
      let clone = translateNode(src, 24, 24)
      if (clone.type === 'group') {
        clone = {
          ...clone,
          children: clone.children.map((c) => idMap.get(c)!).filter(Boolean),
        }
      }
      nodes[newId] = clone
    }

    for (const oldId of clipboard.zOrder) {
      const nid = idMap.get(oldId)
      if (nid) {
        zOrder.push(nid)
        newTopIds.push(nid)
      }
    }

    set((s) => ({ doc: { ...s.doc, nodes, zOrder }, selectedIds: newTopIds }))
  },

  pathfinderSelected: (op) => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = pathfinder(doc, selectedIds, op)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: result.resultIds,
    }))
  },

  joinSelectedPaths: () => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = joinPathsOp(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: [result.resultId],
    }))
  },

  scissorsAt: (pathId, x, y) => {
    const doc = bakeAllPendingMoves(get().doc)
    const result = scissorsSplit(doc, pathId, x, y)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: result.resultIds,
    }))
  },

  outlineStrokeSelected: () => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = outlineStrokeOp(doc, selectedIds)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: [result.resultId],
    }))
  },

  offsetPathSelected: (distance) => {
    const { selectedIds } = get()
    const doc = bakeAllPendingMoves(get().doc)
    const result = offsetSelected(doc, selectedIds, distance)
    if (!result) return
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, nodes: result.nodes, zOrder: result.zOrder },
      selectedIds: [result.resultId],
    }))
  },

  shearSelected: (axis, amount) => {
    const { selectedIds } = get()
    if (selectedIds.length === 0) return
    get().pushHistory()
    // shearNodes mutates the group node and its children independently
    // (see ops/shear.ts) — bake any deferred move first so it doesn't
    // double up with the shear.
    const doc = bakeAllPendingMoves(get().doc)
    const nodes = shearNodes(doc, selectedIds, axis, amount)
    set((s) => ({ doc: { ...s.doc, nodes } }))
  },

  addManualGuide: (guide) => {
    get().pushHistory()
    set((s) => ({
      doc: { ...s.doc, manualGuides: [...s.doc.manualGuides, guide] },
    }))
  },

  removeManualGuide: (index) => {
    get().pushHistory()
    set((s) => ({
      doc: {
        ...s.doc,
        manualGuides: s.doc.manualGuides.filter((_, i) => i !== index),
      },
    }))
  },

  clearManualGuides: () => {
    if (get().doc.manualGuides.length === 0) return
    get().pushHistory()
    set((s) => ({ doc: { ...s.doc, manualGuides: [] } }))
  },

  updatePathD: (id, d, recordHistory = false) => {
    if (recordHistory) get().pushHistory()
    set((s) => {
      const n = s.doc.nodes[id]
      if (!n || n.type !== 'path') return s
      return {
        doc: {
          ...s.doc,
          nodes: { ...s.doc.nodes, [id]: { ...n, d } },
        },
      }
    })
  },

  movePathAnchor: (id, anchorIndex, x, y) => {
    get().flushGroupMoves()
    const n = get().doc.nodes[id]
    if (!n || n.type !== 'path') return
    get().updatePathD(id, moveAnchor(n.d, anchorIndex, x, y))
  },

  deletePathAnchor: (id, anchorIndex) => {
    get().flushGroupMoves()
    const n = get().doc.nodes[id]
    if (!n || n.type !== 'path') return
    get().pushHistory()
    get().updatePathD(id, deleteAnchor(n.d, anchorIndex))
  },

  addPathAnchor: (id, afterIndex, x, y) => {
    get().flushGroupMoves()
    const n = get().doc.nodes[id]
    if (!n || n.type !== 'path') return
    get().pushHistory()
    get().updatePathD(id, addAnchorAfter(n.d, afterIndex, x, y))
  },

  convertPathAnchor: (id, anchorIndex) => {
    get().flushGroupMoves()
    const n = get().doc.nodes[id]
    if (!n || n.type !== 'path') return
    get().pushHistory()
    get().updatePathD(id, convertAnchor(n.d, anchorIndex))
  },

  flushGroupMoves: () => {
    set((s) => ({ doc: bakeAllPendingMoves(s.doc) }))
  },

  beginPen: () => set({ penDraft: { points: [] }, tool: 'pen' }),

  addPenPoint: (x, y, control) => {
    const { doc, penDraft } = get()
    const pt = snapPoint(x, y, doc.settings, doc.artboards)
    const point = control
      ? { ...pt, cx: control.cx, cy: control.cy }
      : pt
    set({
      penDraft: { points: [...(penDraft?.points ?? []), point] },
    })
  },

  finishPen: (opts) => {
    const { penDraft } = get()
    if (!penDraft || penDraft.points.length < 2) {
      set({ penDraft: { points: [] } })
      return
    }
    const close = !!opts?.close && penDraft.points.length >= 2
    let d = pointsToPath(penDraft.points)
    if (close) d += ' Z'
    const node: VecNode = {
      id: nextId('path'),
      type: 'path',
      name: close ? 'Shape' : 'Path',
      visible: true,
      locked: false,
      rotation: 0,
      style: close ? defaultStyle() : { ...defaultStyle(), fill: paintNone() },
      d,
    }
    get().addNode(node)
    set({ penDraft: { points: [] } })
  },

  cancelPen: () => set({ penDraft: { points: [] } }),

  addSwatch: (color) => {
    get().addSwatches([color])
  },

  addSwatches: (colors) => {
    const normalized = colors
      .map((c) => normalizeSwatchColor(c))
      .filter((c): c is string => Boolean(c))
    if (normalized.length === 0) return
    set((s) => {
      const existing = new Set(s.doc.swatches.map((x) => x.toLowerCase()))
      const next = [...s.doc.swatches]
      let added = false
      for (const c of normalized) {
        if (existing.has(c)) continue
        existing.add(c)
        next.push(c)
        added = true
      }
      if (!added) return s
      return { doc: { ...s.doc, swatches: next } }
    })
  },

  removeSwatch: (color) => {
    const c = color.trim().toLowerCase()
    set((s) => ({
      doc: {
        ...s.doc,
        swatches: s.doc.swatches.filter((x) => x.toLowerCase() !== c),
      },
    }))
  },

  applySwatch: (color, target) => {
    const paint = paintSolid(color)
    if (target === 'fill') get().applyStyleToSelected({ fill: paint })
    else get().applyStyleToSelected({ stroke: paint })
  },

  loadDocument: (doc) =>
    set({
      doc: syncArtboardFromActive({
        ...createEmptyDocument(),
        ...doc,
        version: 1,
        nodes: { ...doc.nodes },
        zOrder: [...doc.zOrder],
        artboard: { ...doc.artboard },
        artboards: doc.artboards?.length
          ? doc.artboards.map((a) => ({ ...a }))
          : createEmptyDocument().artboards,
        activeArtboardId: doc.activeArtboardId || createEmptyDocument().activeArtboardId,
        settings: { ...doc.settings },
        swatches: doc.swatches ? [...doc.swatches] : createEmptyDocument().swatches,
      }),
      selectedIds: [],
      guides: [],
      draftNode: null,
      penDraft: null,
      past: [],
      future: [],
      tool: 'select',
      editingTextId: null,
      svgTraceNodeId: null,
    }),

  getDocument: () => get().doc,
}))

// DEV: let browser automation / console hit the live store (Vite HMR forks duplicates on raw import).
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __penStore?: typeof useDocStore }).__penStore = useDocStore
}

function normalizeSwatchColor(color: string): string | null {
  const raw = color.trim().toLowerCase()
  if (!raw) return null
  if (/^#[0-9a-f]{6}$/.test(raw)) return raw
  if (/^#[0-9a-f]{3}$/.test(raw)) {
    const r = raw[1]
    const g = raw[2]
    const b = raw[3]
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return raw
}

export { nextId, defaultStyle, defaultTextStyle, snapPoint }
