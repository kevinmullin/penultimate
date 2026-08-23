import { Artboard } from './canvas/Artboard'
import { ArtboardsPanel } from './components/ArtboardsPanel'
import { ControlBar } from './components/ControlBar'
import { HelpModal } from './components/HelpModal'
import { LayersPanel } from './components/LayersPanel'
import { MenuBar } from './components/MenuBar'
import { PropertiesPanel } from './components/PropertiesPanel'
import { SettingsModal } from './components/SettingsModal'
import { ShapeDialog } from './components/ShapeDialog'
import { SvgTraceDialog } from './components/SvgTraceDialog'
import { SwatchesPanel } from './components/SwatchesPanel'
import { ToolsRail } from './components/ToolsRail'
import { TooltipHost } from './components/Tooltip'
import { useAutosave } from './hooks/useAutosave'
import { useEditorShortcuts } from './hooks/useEditorShortcuts'
import { useEffect } from 'react'
import { scheduleTextToolWarmup } from './io/fontCatalog'

export default function App() {
  useEditorShortcuts()
  useAutosave()

  useEffect(() => {
    scheduleTextToolWarmup()
  }, [])

  return (
    <div className="app">
      <MenuBar />
      <ControlBar />
      <div className="workspace">
        <ToolsRail />
        <main className="canvas-area">
          <Artboard />
        </main>
        <aside className="right-dock">
          <ArtboardsPanel />
          <LayersPanel />
          <PropertiesPanel />
          <SwatchesPanel />
        </aside>
      </div>
      <TooltipHost />
      <SettingsModal />
      <HelpModal />
      <ShapeDialog />
      <SvgTraceDialog />
    </div>
  )
}
