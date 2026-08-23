import { useState, type ReactNode } from 'react'
import { PaintControl } from './PaintControl'
import { FontSelect } from './FontSelect'
import { Icon, IconButton } from './Icon'
import { PanelHeader } from './PanelHeader'
import { hasEditableGeometry, ShapeGeometryFields } from './ShapeGeometryFields'
import { useDocStore } from '../store/documentStore'
import type { Paint } from '../style/paint'
import { supportsStrokeAlign, type StrokeAlign } from '../style/strokeAlign'
import type { StrokeLinecap, StrokeLinejoin } from '../types'

function Section({
  title,
  children,
  defaultOpen = true,
  badge,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
  badge?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`props-sec${open ? '' : ' is-collapsed'}`}>
      <button
        type="button"
        className="props-sec__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="props-sec__title">
          {title}
          {badge ? <span className="props-sec__badge">{badge}</span> : null}
        </span>
        <span className="props-sec__chev" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? <div className="props-sec__body">{children}</div> : null}
    </section>
  )
}

export function PropertiesPanel() {
  const doc = useDocStore((s) => s.doc)
  const selectedIds = useDocStore((s) => s.selectedIds)
  const applyStyleToSelected = useDocStore((s) => s.applyStyleToSelected)
  const updateNode = useDocStore((s) => s.updateNode)
  const rotateSelected = useDocStore((s) => s.rotateSelected)
  const pushHistory = useDocStore((s) => s.pushHistory)
  const [folded, setFolded] = useState(false)

  const nodes = selectedIds.map((id) => doc.nodes[id]).filter(Boolean)
  if (nodes.length === 0) {
    return (
      <aside className={`props-panel${folded ? ' is-collapsed' : ''}`}>
        <PanelHeader
          title="Appearance"
          collapsed={folded}
          onToggle={() => setFolded((v) => !v)}
        />
        {!folded && (
          <div className="props-body props-body--compact">
            <p className="panel-empty">
              Select an object to edit shape, fill, stroke, and effects.
            </p>
          </div>
        )}
      </aside>
    )
  }

  const primary = nodes[0]
  const mixed = nodes.length > 1
  const strokeOn = primary.style.stroke.type !== 'none'

  const setFill = (fill: Paint, recordHistory = true) =>
    applyStyleToSelected({ fill }, recordHistory)
  const setStroke = (stroke: Paint, recordHistory = true) =>
    applyStyleToSelected({ stroke }, recordHistory)

  const strokeAlignIcons: Array<[StrokeAlign, string, string]> = [
    ['center', 'stroke-center', 'Stroke center'],
    ['inside', 'stroke-inside', 'Stroke inside'],
    ['outside', 'stroke-outside', 'Stroke outside'],
  ]
  const caps: Array<[StrokeLinecap, string, string]> = [
    ['butt', 'cap-butt', 'Cap butt'],
    ['round', 'cap-round', 'Cap round'],
    ['square', 'cap-square', 'Cap square'],
  ]
  const joins: Array<[StrokeLinejoin, string, string]> = [
    ['miter', 'join-miter', 'Join miter'],
    ['round', 'join-round', 'Join round'],
    ['bevel', 'join-bevel', 'Join bevel'],
  ]

  return (
    <aside className={`props-panel${folded ? ' is-collapsed' : ''}`}>
      <PanelHeader
        title={`Appearance${mixed ? ` (${nodes.length})` : ''}`}
        collapsed={folded}
        onToggle={() => setFolded((v) => !v)}
      />
      {!folded && (
        <div className="props-body props-body--compact">
          {!mixed && hasEditableGeometry(primary) && (
            <Section title="Shape">
              <ShapeGeometryFields mode="edit" node={primary} />
            </Section>
          )}

          <Section title="Paint">
            <PaintControl label="Fill" paint={primary.style.fill} onChange={setFill} />
            <PaintControl label="Stroke" paint={primary.style.stroke} onChange={setStroke} />
          </Section>

          {strokeOn && (
            <Section title="Stroke" badge={`${primary.style.strokeWidth}px`}>
              <div className="props-stroke">
                <div className="props-stroke__row">
                  <span className="props-stroke__label">Width</span>
                  <div className="props-stroke__controls">
                    <input
                      className="props-stroke__width"
                      type="number"
                      min={0}
                      step={0.5}
                      aria-label="Stroke width"
                      value={primary.style.strokeWidth}
                      onChange={(e) =>
                        applyStyleToSelected({
                          strokeWidth: Math.max(0, Number(e.target.value) || 0),
                        })
                      }
                    />
                    <IconButton
                      icon="dash"
                      label="Toggle dashed stroke"
                      active={Boolean(primary.style.strokeDasharray)}
                      onClick={() =>
                        applyStyleToSelected({
                          strokeDasharray: primary.style.strokeDasharray ? null : '6 4',
                        })
                      }
                    />
                    <IconButton
                      icon="arrow-end"
                      label="Toggle end arrow"
                      active={primary.style.strokeArrow}
                      onClick={() =>
                        applyStyleToSelected({ strokeArrow: !primary.style.strokeArrow })
                      }
                    />
                  </div>
                </div>
                <div className="props-stroke__row">
                  <span className="props-stroke__label">Cap</span>
                  <div className="props-stroke__controls">
                    {caps.map(([id, icon, label]) => (
                      <IconButton
                        key={id}
                        icon={icon}
                        label={label}
                        active={primary.style.strokeLinecap === id}
                        onClick={() => applyStyleToSelected({ strokeLinecap: id })}
                      />
                    ))}
                  </div>
                </div>
                <div className="props-stroke__row">
                  <span className="props-stroke__label">Join</span>
                  <div className="props-stroke__controls">
                    {joins.map(([id, icon, label]) => (
                      <IconButton
                        key={id}
                        icon={icon}
                        label={label}
                        active={primary.style.strokeLinejoin === id}
                        onClick={() => applyStyleToSelected({ strokeLinejoin: id })}
                      />
                    ))}
                  </div>
                </div>
                {supportsStrokeAlign(primary) && (
                  <div className="props-stroke__row">
                    <span className="props-stroke__label">Align</span>
                    <div className="props-stroke__controls">
                      {strokeAlignIcons.map(([id, icon, label]) => (
                        <IconButton
                          key={id}
                          icon={icon}
                          label={label}
                          active={(primary.style.strokeAlign ?? 'center') === id}
                          onClick={() => applyStyleToSelected({ strokeAlign: id })}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </Section>
          )}

          <Section title="Object">
            <div className="props-object">
              <label className="field-inline">
                <span>Opacity</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={primary.style.opacity}
                  onMouseDown={() => pushHistory()}
                  onChange={(e) => {
                    const nodesMap = { ...doc.nodes }
                    for (const id of selectedIds) {
                      const n = nodesMap[id]
                      if (!n || n.locked) continue
                      nodesMap[id] = {
                        ...n,
                        style: { ...n.style, opacity: Number(e.target.value) },
                      }
                    }
                    useDocStore.setState((s) => ({ doc: { ...s.doc, nodes: nodesMap } }))
                  }}
                />
                <em className="field-inline__val">
                  {Math.round(primary.style.opacity * 100)}%
                </em>
              </label>
              <div className="props-inline-grid props-inline-grid--object">
                <label className="field-inline">
                  <span>Blend</span>
                  <select
                    value={primary.style.blendMode ?? 'normal'}
                    onChange={(e) =>
                      applyStyleToSelected({
                        blendMode: e.target.value as typeof primary.style.blendMode,
                      })
                    }
                  >
                    {[
                      'normal',
                      'multiply',
                      'screen',
                      'overlay',
                      'darken',
                      'lighten',
                      'color-dodge',
                      'color-burn',
                      'hard-light',
                      'soft-light',
                      'difference',
                      'exclusion',
                    ].map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-inline field-inline--angle">
                  <span>Angle</span>
                  <input
                    type="number"
                    step={1}
                    value={Math.round(primary.rotation)}
                    onFocus={() => pushHistory()}
                    onChange={(e) => rotateSelected(Number(e.target.value) || 0)}
                    aria-label="Rotation angle"
                  />
                </label>
              </div>
            </div>

            <div className="props-tool-row props-tool-row--shadow">
              <IconButton
                icon="effect-shadow"
                label="Toggle drop shadow"
                active={Boolean(primary.style.shadow?.enabled)}
                onClick={() =>
                  applyStyleToSelected({
                    shadow: {
                      ...(primary.style.shadow ?? {
                        dx: 2,
                        dy: 2,
                        blur: 4,
                        color: '#000000',
                        opacity: 0.35,
                      }),
                      enabled: !primary.style.shadow?.enabled,
                    },
                  })
                }
              />
              <span className="props-tool-label">Shadow</span>
            </div>
            {primary.style.shadow?.enabled && (
              <div className="props-shadow-fields">
                <label className="field-inline field-inline--shadow">
                  <span>X</span>
                  <input
                    type="number"
                    value={primary.style.shadow.dx}
                    onChange={(e) =>
                      applyStyleToSelected({
                        shadow: {
                          ...primary.style.shadow,
                          dx: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
                </label>
                <label className="field-inline field-inline--shadow">
                  <span>Y</span>
                  <input
                    type="number"
                    value={primary.style.shadow.dy}
                    onChange={(e) =>
                      applyStyleToSelected({
                        shadow: {
                          ...primary.style.shadow,
                          dy: Number(e.target.value) || 0,
                        },
                      })
                    }
                  />
                </label>
                <label className="field-inline field-inline--shadow">
                  <span>Blur</span>
                  <input
                    type="number"
                    min={0}
                    value={primary.style.shadow.blur}
                    onChange={(e) =>
                      applyStyleToSelected({
                        shadow: {
                          ...primary.style.shadow,
                          blur: Math.max(0, Number(e.target.value) || 0),
                        },
                      })
                    }
                  />
                </label>
              </div>
            )}
          </Section>

          {primary.type === 'image' && !mixed && (
            <Section title="Image">
              <button
                type="button"
                className="ghost-btn svg-trace-trigger"
                onClick={() => useDocStore.getState().setSvgTraceNodeId(primary.id)}
              >
                <Icon name="convert-outlines" />
                Convert to SVG…
              </button>
            </Section>
          )}

          {primary.type === 'text' && !mixed && (
            <Section title="Type">
              <label className="field-inline field-inline--stack">
                <span>Text</span>
                <input
                  value={primary.text}
                  onChange={(e) => updateNode(primary.id, { text: e.target.value } as never)}
                  onBlur={(e) =>
                    updateNode(
                      primary.id,
                      { text: e.target.value, name: e.target.value.slice(0, 24) } as never,
                      true,
                    )
                  }
                />
              </label>
              <label className="field-inline field-inline--stack">
                <span>Font</span>
                <FontSelect
                  value={primary.fontFamily}
                  onChange={(fontFamily) =>
                    updateNode(primary.id, { fontFamily } as never, true)
                  }
                />
              </label>
              <div className="props-inline-grid props-inline-grid--2">
                <label className="field-inline">
                  <span>Size</span>
                  <input
                    type="number"
                    min={4}
                    value={primary.fontSize}
                    onChange={(e) =>
                      updateNode(
                        primary.id,
                        { fontSize: Math.max(4, Number(e.target.value) || 4) } as never,
                        true,
                      )
                    }
                  />
                </label>
                <div className="props-tool-row">
                  <IconButton
                    icon="bold"
                    label="Bold"
                    active={primary.fontWeight === 'bold'}
                    onClick={() =>
                      updateNode(
                        primary.id,
                        {
                          fontWeight: primary.fontWeight === 'bold' ? 'normal' : 'bold',
                        } as never,
                        true,
                      )
                    }
                  />
                  <IconButton
                    icon="italic"
                    label="Italic"
                    active={primary.fontStyle === 'italic'}
                    onClick={() =>
                      updateNode(
                        primary.id,
                        {
                          fontStyle: primary.fontStyle === 'italic' ? 'normal' : 'italic',
                        } as never,
                        true,
                      )
                    }
                  />
                </div>
              </div>
            </Section>
          )}

          {primary.type === 'path' && !mixed && !primary.primitive && (
            <p className="props-hint">
              Direct select (A): drag · dbl-click convert · right-click delete ·
              Shift+right-click add
            </p>
          )}
        </div>
      )}
    </aside>
  )
}
