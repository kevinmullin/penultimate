import { memo } from 'react'
import type { VecNode, VectorDocument } from '../types'
import { paintNeedsDef, type Paint } from '../style/paint'

function GradientElement({ id, paint }: { id: string; paint: Paint }) {
  if (paint.type === 'linear') {
    return (
      <linearGradient
        id={id}
        gradientUnits="objectBoundingBox"
        x1={paint.x1}
        y1={paint.y1}
        x2={paint.x2}
        y2={paint.y2}
      >
        {paint.stops.map((s, i) => (
          <stop key={i} offset={s.offset} stopColor={s.color} />
        ))}
      </linearGradient>
    )
  }
  if (paint.type === 'radial') {
    return (
      <radialGradient
        id={id}
        gradientUnits="objectBoundingBox"
        cx={paint.cx}
        cy={paint.cy}
        r={paint.r}
      >
        {paint.stops.map((s, i) => (
          <stop key={i} offset={s.offset} stopColor={s.color} />
        ))}
      </radialGradient>
    )
  }
  return null
}

function collectFromNode(node: VecNode, out: Array<{ id: string; paint: Paint }>) {
  if (paintNeedsDef(node.style.fill)) {
    out.push({ id: `fill-${node.id}`, paint: node.style.fill })
  }
  if (paintNeedsDef(node.style.stroke)) {
    out.push({ id: `stroke-${node.id}`, paint: node.style.stroke })
  }
  if (node.type === 'group') {
    // children are also in doc.nodes; defs are collected from all nodes below
  }
}

export const GradientDefs = memo(function GradientDefs({
  doc,
  extra,
}: {
  doc: VectorDocument
  extra?: Array<{ id: string; paint: Paint }>
}) {
  const defs: Array<{ id: string; paint: Paint }> = []
  for (const node of Object.values(doc.nodes)) {
    collectFromNode(node, defs)
  }
  if (extra) defs.push(...extra)

  if (defs.length === 0) return null
  return (
    <defs>
      {defs.map((d) => (
        <GradientElement key={d.id} id={d.id} paint={d.paint} />
      ))}
    </defs>
  )
})
