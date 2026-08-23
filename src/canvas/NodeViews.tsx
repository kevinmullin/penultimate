import { memo, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type CSSProperties } from 'react'
import { paintAttrValue } from '../style/paint'
import { effectiveStrokeAlign } from '../style/strokeAlign'
import { nodeBBox } from '../geometry'
import type { Tool, VecNode, VectorDocument } from '../types'
import { cssCursorForTool } from './toolCursors'

/** Tools that draw a new object from a drag/click on the artboard. */
export function isCreateTool(tool: Tool): boolean {
  return (
    tool === 'rect' ||
    tool === 'rounded-rect' ||
    tool === 'ellipse' ||
    tool === 'polygon' ||
    tool === 'star' ||
    tool === 'line' ||
    tool === 'area-text' ||
    tool === 'pencil' ||
    tool === 'pen'
  )
}

type PaintSlice = {
  fill: string
  stroke: string
  strokeWidth: number
  fillOpacity?: number
  paintOrder?: string
  clipPath?: string
  strokeLinecap?: string
  strokeLinejoin?: string
  strokeDasharray?: string
  markerEnd?: string
}

function strokeExtras(node: VecNode): Partial<PaintSlice> {
  const s = node.style
  return {
    strokeLinecap: s.strokeLinecap,
    strokeLinejoin: s.strokeLinejoin,
    strokeDasharray: s.strokeDasharray || undefined,
    markerEnd: s.strokeArrow ? `url(#arrow-${node.id})` : undefined,
  }
}

function rotationProps(node: VecNode, cx: number, cy: number) {
  if (!node.rotation) return undefined
  return `rotate(${node.rotation} ${cx} ${cy})`
}

function geometry(
  node: VecNode,
  paint: PaintSlice,
  extras?: {
    children?: ReactNode
    pointerEvents?: 'none' | 'auto' | 'all' | 'visiblePainted'
    onPointerDown?: (e: ReactPointerEvent) => void
    onDoubleClick?: (e: ReactMouseEvent) => void
    cursor?: string
  },
) {
  const shared = {
    fill: paint.fill,
    stroke: paint.stroke,
    strokeWidth: paint.strokeWidth,
    fillOpacity: paint.fillOpacity,
    paintOrder: paint.paintOrder,
    clipPath: paint.clipPath,
    strokeLinecap: paint.strokeLinecap as 'butt' | 'round' | 'square' | undefined,
    strokeLinejoin: paint.strokeLinejoin as 'miter' | 'round' | 'bevel' | undefined,
    strokeDasharray: paint.strokeDasharray,
    markerEnd: paint.markerEnd,
    pointerEvents: extras?.pointerEvents,
    onPointerDown: extras?.onPointerDown,
    onDoubleClick: extras?.onDoubleClick,
    style: extras?.onPointerDown || extras?.cursor
      ? ({ cursor: extras.cursor ?? (extras?.onPointerDown ? 'pointer' : undefined) } as const)
      : undefined,
  }

  switch (node.type) {
    case 'rect':
      return (
        <rect
          {...shared}
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          rx={node.rx || undefined}
          transform={rotationProps(
            node,
            node.x + node.width / 2,
            node.y + node.height / 2,
          )}
        />
      )
    case 'ellipse':
      return (
        <ellipse
          {...shared}
          cx={node.cx}
          cy={node.cy}
          rx={node.rx}
          ry={node.ry}
          transform={rotationProps(node, node.cx, node.cy)}
        />
      )
    case 'line':
      return (
        <line
          {...shared}
          x1={node.x1}
          y1={node.y1}
          x2={node.x2}
          y2={node.y2}
          transform={rotationProps(
            node,
            (node.x1 + node.x2) / 2,
            (node.y1 + node.y2) / 2,
          )}
        />
      )
    case 'text':
      if (node.width && node.height && node.width > 0 && node.height > 0) {
        return (
          <g transform={rotationProps(node, node.x + node.width / 2, node.y + node.height / 2)}>
            <rect
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              fill="none"
              stroke={paint.stroke === 'none' ? 'transparent' : paint.stroke}
              strokeWidth={paint.strokeWidth}
              pointerEvents={extras?.pointerEvents}
              onPointerDown={extras?.onPointerDown}
              onDoubleClick={extras?.onDoubleClick}
            />
            <foreignObject
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              pointerEvents={extras?.pointerEvents ?? 'none'}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  overflow: 'hidden',
                  color: paint.fill === 'none' ? '#111' : paint.fill,
                  fontSize: node.fontSize,
                  fontFamily: node.fontFamily,
                  fontWeight: node.fontWeight,
                  fontStyle: node.fontStyle,
                  lineHeight: 1.25,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  userSelect: 'none',
                  padding: 2,
                  boxSizing: 'border-box',
                }}
              >
                {extras?.children ?? node.text}
              </div>
            </foreignObject>
          </g>
        )
      }
      return (
        <text
          {...shared}
          x={node.x}
          y={node.y}
          fontSize={node.fontSize}
          fontFamily={node.fontFamily}
          fontWeight={node.fontWeight}
          fontStyle={node.fontStyle}
          dominantBaseline="alphabetic"
          transform={rotationProps(node, node.x, node.y)}
        >
          {extras?.children ?? node.text}
        </text>
      )
    case 'path':
      return <path {...shared} d={node.d} fillRule="evenodd" />
    case 'image':
      return (
        <image
          href={node.href}
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          opacity={undefined}
          preserveAspectRatio="xMidYMid meet"
          transform={rotationProps(
            node,
            node.x + node.width / 2,
            node.y + node.height / 2,
          )}
          pointerEvents={extras?.pointerEvents}
          onPointerDown={extras?.onPointerDown}
          style={extras?.onPointerDown ? ({ cursor: extras.cursor ?? 'pointer' } as const) : undefined}
        />
      )
    case 'group':
      return null
  }
}

type PaintedShapeProps = {
  node: Exclude<VecNode, { type: 'group' }>
  doc: VectorDocument
  outlineMode: boolean
  tool: Tool
  onPointerDown: (id: string, e: ReactPointerEvent) => void
  onDoubleClick?: (id: string, e: ReactMouseEvent) => void
  editingTextId?: string | null
  liveEditText?: string | null
}

function paintedShapePropsEqual(prev: PaintedShapeProps, next: PaintedShapeProps): boolean {
  return (
    prev.node === next.node &&
    prev.doc === next.doc &&
    prev.outlineMode === next.outlineMode &&
    prev.tool === next.tool &&
    prev.onPointerDown === next.onPointerDown &&
    prev.onDoubleClick === next.onDoubleClick &&
    prev.editingTextId === next.editingTextId &&
    prev.liveEditText === next.liveEditText
  )
}

const PaintedShape = memo(function PaintedShape({
  node,
  doc,
  outlineMode,
  tool,
  onPointerDown,
  onDoubleClick,
  editingTextId,
  liveEditText,
}: PaintedShapeProps) {
  const toolCursor = cssCursorForTool(tool)
  const fill = paintAttrValue(node.style.fill, `fill-${node.id}`)
  const stroke = paintAttrValue(node.style.stroke, `stroke-${node.id}`)
  const width = node.style.strokeWidth
  const hasFill = node.style.fill.type !== 'none'
  const hasStroke = node.style.stroke.type !== 'none' && width > 0
  const alignRaw = effectiveStrokeAlign(node)
  const align = alignRaw === 'outside' && !hasFill ? 'center' : alignRaw
  const clipId = `clip-${node.id}`
  // Keep SVG glyphs visible while editing (overlay is caret-only) so exit never jumps baseline.
  const editingLabel =
    node.type === 'text' && editingTextId === node.id && liveEditText != null
      ? liveEditText
      : undefined
  const textChildProps =
    editingLabel !== undefined ? { children: editingLabel } : {}

  const handleDown = (e: ReactPointerEvent) => {
    e.stopPropagation()
    onPointerDown(node.id, e)
  }

  const handleDbl = (e: ReactMouseEvent) => {
    e.stopPropagation()
    onDoubleClick?.(node.id, e)
  }

  if (node.type === 'image') {
    if (outlineMode) {
      return (
        <g opacity={node.style.opacity}>
          <rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            onPointerDown={handleDown}
            onDoubleClick={handleDbl}
            style={{ cursor: toolCursor }}
          />
        </g>
      )
    }
    return (
      <g opacity={node.style.opacity}>
        <image
          href={node.href}
          x={node.x}
          y={node.y}
          width={node.width}
          height={node.height}
          preserveAspectRatio="xMidYMid meet"
          transform={rotationProps(
            node,
            node.x + node.width / 2,
            node.y + node.height / 2,
          )}
          onPointerDown={handleDown}
          onDoubleClick={handleDbl}
          style={{ cursor: toolCursor }}
        />
      </g>
    )
  }

  if (outlineMode) {
    return (
      <g opacity={1}>
        {geometry(
          node,
          {
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1,
          },
          {
            onPointerDown: handleDown,
            onDoubleClick: handleDbl,
            cursor: toolCursor,
            ...textChildProps,
          },
        )}
      </g>
    )
  }

  // Invisible fill used as a hit target. SVG groups with only
  // pointer-events:none children are not selectable.
  // Point text only paints glyphs — use the layout bbox so Type-tool clicks work.
  let hitTarget: ReactNode
  if (node.type === 'text') {
    const box = nodeBBox(node, doc)
    hitTarget = (
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        fill="#ffffff"
        fillOpacity={0}
        stroke="none"
        pointerEvents="all"
        style={{ cursor: toolCursor }}
        onPointerDown={handleDown}
        onDoubleClick={handleDbl}
      />
    )
  } else {
    hitTarget = geometry(
      node,
      {
        fill: '#ffffff',
        fillOpacity: 0,
        stroke: 'none',
        strokeWidth: 0,
      },
      {
        onPointerDown: handleDown,
        onDoubleClick: handleDbl,
        pointerEvents: 'all',
        cursor: toolCursor,
      },
    )
  }

  // Center (default): explicit paint-order so stroke is always drawn after fill.
  if (!hasStroke || align === 'center') {
    return (
      <EffectGroup node={node}>
        <g opacity={node.style.opacity}>
          {node.style.strokeArrow && (
            <defs>
              <marker
                id={`arrow-${node.id}`}
                markerWidth="8"
                markerHeight="8"
                refX="6"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L6,3 L0,6 Z" fill={stroke === 'none' ? '#000' : stroke} />
              </marker>
            </defs>
          )}
          {geometry(
            node,
            {
              fill: hasFill ? fill : 'none',
              stroke: hasStroke ? stroke : 'none',
              strokeWidth: width,
              paintOrder: 'fill stroke',
              ...strokeExtras(node),
            },
            {
              onPointerDown: handleDown,
              onDoubleClick: handleDbl,
              cursor: toolCursor,
              ...textChildProps,
            },
          )}
          {/* Point type only paints glyphs — add an invisible hit box so Type-tool
              clicks on/near the letters reliably enter edit. */}
          {node.type === 'text' && hitTarget}
        </g>
      </EffectGroup>
    )
  }

  // Outside: double-width stroke under a fill-only top layer (outer half remains).
  if (align === 'outside') {
    return (
      <EffectGroup node={node}>
        <g opacity={node.style.opacity}>
          {hasStroke &&
            geometry(
              node,
              {
                fill: 'none',
                stroke,
                strokeWidth: width * 2,
                ...strokeExtras(node),
              },
              { pointerEvents: 'none' },
            )}
          {geometry(
            node,
            {
              fill: hasFill ? fill : 'none',
              stroke: 'none',
              strokeWidth: 0,
            },
            { pointerEvents: 'none' },
          )}
          {hitTarget}
        </g>
      </EffectGroup>
    )
  }

  // Inside: double-width stroke clipped to the shape (inner half remains), drawn after fill.
  return (
    <EffectGroup node={node}>
      <g opacity={node.style.opacity}>
        <defs>
          <clipPath id={clipId}>
            {geometry(node, { fill: '#000', stroke: 'none', strokeWidth: 0 })}
          </clipPath>
        </defs>
        {hasFill &&
          geometry(
            node,
            {
              fill,
              stroke: 'none',
              strokeWidth: 0,
            },
            { pointerEvents: 'none' },
          )}
        {hasStroke && (
          <g clipPath={`url(#${clipId})`} pointerEvents="none">
            {geometry(node, {
              fill: 'none',
              stroke,
              strokeWidth: width * 2,
              ...strokeExtras(node),
            })}
          </g>
        )}
        {hitTarget}
      </g>
    </EffectGroup>
  )
}, paintedShapePropsEqual)

function EffectGroup({
  node,
  children,
}: {
  node: VecNode
  children: ReactNode
}) {
  const blend = node.style.blendMode
  const shadow = node.style.shadow
  const filterId = `drop-shadow-${node.id}`
  return (
    <g
      style={
        blend && blend !== 'normal'
          ? ({ mixBlendMode: blend } as CSSProperties)
          : undefined
      }
      filter={shadow?.enabled ? `url(#${filterId})` : undefined}
    >
      {shadow?.enabled && (
        <defs>
          <filter
            id={filterId}
            x="-50%"
            y="-50%"
            width="200%"
            height="200%"
            colorInterpolationFilters="sRGB"
          >
            <feDropShadow
              dx={shadow.dx}
              dy={shadow.dy}
              stdDeviation={Math.max(0, shadow.blur / 2)}
              floodColor={shadow.color}
              floodOpacity={shadow.opacity}
            />
          </filter>
        </defs>
      )}
      {children}
    </g>
  )
}

type NodeViewProps = {
  node: VecNode
  doc: VectorDocument
  outlineMode: boolean
  tool: Tool
  onPointerDown: (id: string, e: ReactPointerEvent) => void
  onDoubleClick?: (id: string, e: ReactMouseEvent) => void
  editingTextId?: string | null
  /** Live draft string while this text node is being edited in the overlay. */
  liveEditText?: string | null
}

function nodeViewPropsEqual(prev: NodeViewProps, next: NodeViewProps): boolean {
  return (
    prev.node === next.node &&
    prev.doc === next.doc &&
    prev.outlineMode === next.outlineMode &&
    prev.tool === next.tool &&
    prev.onPointerDown === next.onPointerDown &&
    prev.onDoubleClick === next.onDoubleClick &&
    prev.editingTextId === next.editingTextId &&
    prev.liveEditText === next.liveEditText
  )
}

export const NodeView = memo(function NodeView({
  node,
  doc,
  outlineMode,
  tool,
  onPointerDown,
  onDoubleClick,
  editingTextId,
  liveEditText,
}: NodeViewProps) {
  const toolCursor = cssCursorForTool(tool)
  if (!node.visible) return null

  if (node.type === 'group') {
    const children = node.children
      .map((id) => doc.nodes[id])
      .filter(Boolean)
    const cursor = node.locked ? 'default' : toolCursor

    if (node.clipped && children.length >= 1) {
      const [mask, ...content] = children
      const clipId = `user-clip-${node.id}`
      return (
        <g
          transform={rotationProps(node, node.x, node.y)}
          onPointerDown={(e) => {
            e.stopPropagation()
            onPointerDown(node.id, e)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            onDoubleClick?.(node.id, e)
          }}
          style={{ cursor }}
        >
          <defs>
            <clipPath id={clipId}>
              {mask.type !== 'group' &&
                geometry(mask, { fill: '#000', stroke: 'none', strokeWidth: 0 })}
            </clipPath>
          </defs>
          <NodeView
            node={mask}
            doc={doc}
            outlineMode={outlineMode}
            tool={tool}
            onPointerDown={onPointerDown}
            onDoubleClick={onDoubleClick}
            editingTextId={editingTextId}
            liveEditText={liveEditText}
          />
          <g clipPath={`url(#${clipId})`}>
            {content.map((child) => (
              <NodeView
                key={child.id}
                node={child}
                doc={doc}
                outlineMode={outlineMode}
                tool={tool}
                onPointerDown={onPointerDown}
                onDoubleClick={onDoubleClick}
                editingTextId={editingTextId}
                liveEditText={liveEditText}
              />
            ))}
          </g>
        </g>
      )
    }

    return (
      <g
        transform={rotationProps(node, node.x, node.y)}
        onPointerDown={(e) => {
          e.stopPropagation()
          onPointerDown(node.id, e)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          onDoubleClick?.(node.id, e)
        }}
        style={{ cursor }}
      >
        {node.children.map((id) => {
          const child = doc.nodes[id]
          if (!child) return null
          return (
            <NodeView
              key={id}
              node={child}
              doc={doc}
              outlineMode={outlineMode}
              tool={tool}
              onPointerDown={onPointerDown}
              onDoubleClick={onDoubleClick}
              editingTextId={editingTextId}
              liveEditText={liveEditText}
            />
          )
        })}
      </g>
    )
  }

  return (
    <PaintedShape
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
}, nodeViewPropsEqual)
