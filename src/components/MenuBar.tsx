import { useEffect, useState } from 'react'
import { documentToPngBlob, downloadBlob } from '../io/exportPng'
import { documentToSvg, downloadText } from '../io/exportSvg'
import { importSvgIntoDocument, openSvgFile } from '../io/importSvg'
import { openProject, openRasterFile, saveProject } from '../io/projectFile'
import { bakeAllPendingMoves } from '../geometry'
import { useDocStore } from '../store/documentStore'
import { useUiTheme } from '../hooks/useUiTheme'
import { defaultStyle, nextId } from '../store/documentStore'
import { paintNone } from '../style/paint'
import { IconButton } from './Icon'
import { TaglineTicker } from './TaglineTicker'

function AutosaveHint() {
  const autosaveAt = useDocStore((s) => s.autosaveAt)
  if (!autosaveAt) return null
  const label = `Draft saved ${new Date(autosaveAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  return (
    <span className="autosave-hint" title="Soft-saved locally — recovers if this tab closes">
      {label}
    </span>
  )
}

export function MenuBar() {
  const doc = useDocStore((s) => s.doc)
  const setName = useDocStore((s) => s.setName)
  const undo = useDocStore((s) => s.undo)
  const redo = useDocStore((s) => s.redo)
  const past = useDocStore((s) => s.past)
  const future = useDocStore((s) => s.future)
  const loadDocument = useDocStore((s) => s.loadDocument)
  const pushHistory = useDocStore((s) => s.pushHistory)
  const setSettingsOpen = useDocStore((s) => s.setSettingsOpen)
  const setHelpOpen = useDocStore((s) => s.setHelpOpen)
  const [nameDraft, setNameDraft] = useState(doc.name)
  const { theme, setTheme, themes } = useUiTheme()

  useEffect(() => {
    setNameDraft(doc.name)
  }, [doc.name])

  return (
    <header className="menu-bar">
      <div className="menu-bar__brand" title="Penultimate">
        <span className="menu-bar__brand-name" aria-label="Penultimate">
          <span className="menu-bar__brand-p">P</span>
          <span className="menu-bar__brand-rest">ENULTIMATE</span>
        </span>
        <TaglineTicker />
      </div>
      <div className="menu-bar__file">
        <input
          className="project-name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => setName(nameDraft)}
          aria-label="Document name"
        />
        <IconButton
          icon="open"
          label="Open project"
          onClick={() => void openProject().then((d) => d && loadDocument(d))}
        />
        <IconButton
          icon="import-svg"
          label="Import SVG"
          onClick={() =>
            void openSvgFile().then((text) => {
              if (!text) return
              try {
                pushHistory()
                const next = importSvgIntoDocument(text, useDocStore.getState().doc)
                loadDocument(next)
              } catch (err) {
                console.error(err)
                window.alert(err instanceof Error ? err.message : 'SVG import failed')
              }
            })
          }
        />
        <IconButton
          icon="place-image"
          label="Place image"
          onClick={() =>
            void openRasterFile().then((img) => {
              if (!img) return
              const store = useDocStore.getState()
              const active =
                store.doc.artboards.find((a) => a.id === store.doc.activeArtboardId) ??
                store.doc.artboards[0]
              const w = img.width
              const h = img.height
              store.addNode({
                id: nextId('image'),
                type: 'image',
                name: 'Image',
                visible: true,
                locked: false,
                rotation: 0,
                style: { ...defaultStyle(), fill: paintNone(), stroke: paintNone() },
                x: (active?.x ?? 0) + 40,
                y: (active?.y ?? 0) + 40,
                width: w,
                height: h,
                href: img.href,
              })
            })
          }
        />
        <IconButton icon="save" label="Save" onClick={() => void saveProject(doc)} />
        <IconButton
          icon="export-svg"
          label="Export SVG"
          onClick={() => {
            const svg = documentToSvg(bakeAllPendingMoves(doc))
            const safe = (doc.name || 'artboard').replace(/[^\w\-]+/g, '_')
            downloadText(svg, `${safe}.svg`, 'image/svg+xml')
          }}
        />
        <IconButton
          icon="export-png"
          label="Export PNG"
          primary
          onClick={() =>
            void documentToPngBlob(bakeAllPendingMoves(doc)).then((blob) => {
              const safe = (doc.name || 'artboard').replace(/[^\w\-]+/g, '_')
              downloadBlob(blob, `${safe}.png`)
            })
          }
        />
      </div>
      <div className="menu-bar__edit">
        <label className="theme-select">
          <span className="theme-select__label">Theme</span>
          <select
            value={theme}
            aria-label="UI theme"
            onChange={(e) => setTheme(e.target.value as typeof theme)}
          >
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <IconButton icon="undo" label="Undo" disabled={!past.length} onClick={() => undo()} />
        <IconButton icon="redo" label="Redo" disabled={!future.length} onClick={() => redo()} />
        <AutosaveHint />
        <IconButton
          icon="settings"
          label="Preferences (Ctrl+,)"
          onClick={() => setSettingsOpen(true)}
        />
        <IconButton
          icon="help"
          label="Features & shortcuts (F1)"
          onClick={() => setHelpOpen(true)}
        />
      </div>
    </header>
  )
}
