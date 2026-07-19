import type { NeoAnkiCoreModule } from '../core-module'
import type { importAnkiPackage } from './anki'
import { exportCsv, importCsvText } from './csv'
import { appDataToWorkspaceDocumentV4 } from '../../lib/workspace-v4'
import { parseWorkspaceDocumentV4 } from '../../../packages/compatibility-domain/src/index'

interface ActiveAnkiImport { worker: Worker; timeout: number; reject(error: Error): void }
let activeImport: ActiveAnkiImport | null = null
export const cancelActiveAnkiImport = () => {
  const active = activeImport
  if (!active) return
  activeImport = null; window.clearTimeout(active.timeout); active.worker.terminate()
  active.reject(new Error('Import canceled. The workspace was not changed.'))
}

export const importAnkiInWorker = (file: File, reportProgress?: (message: string) => void) => new Promise<Awaited<ReturnType<typeof importAnkiPackage>>>((resolve, reject) => {
  cancelActiveAnkiImport()
  const worker = new Worker(new URL('./anki-import.worker.ts', import.meta.url), { type: 'module' })
  const active: ActiveAnkiImport = { worker, timeout: 0, reject }
  activeImport = active
  const finish = (complete: () => void) => {
    if (activeImport !== active) return
    activeImport = null; window.clearTimeout(active.timeout); worker.terminate(); complete()
  }
  active.timeout = window.setTimeout(() => finish(() => reject(new Error('Anki import exceeded the two-minute execution limit.'))), 120_000)
  worker.onmessage = (event) => {
    if (event.data?.type === 'progress') { if (typeof event.data.message === 'string') reportProgress?.(event.data.message); return }
    finish(() => event.data?.ok ? resolve(event.data.result) : reject(new Error(event.data?.error || 'Anki import failed.')))
  }
  worker.onerror = () => finish(() => reject(new Error('The isolated Anki import worker failed.')))
  worker.postMessage({ file })
})

const exportAnki = (target: 'apkg' | 'colpkg') => async (data: Parameters<typeof appDataToWorkspaceDocumentV4>[0]) => {
  const { exportAnkiWorkspaceV4 } = await import('./anki')
  const payload = window.neoAnkiDesktop ? await window.neoAnkiDesktop.loadWorkspaceV4ExportPayload() : { document: appDataToWorkspaceDocumentV4(data), media: data.assets }
  const result = await exportAnkiWorkspaceV4(parseWorkspaceDocumentV4(payload.document), payload.media, target)
  if (result.report.warnings.length && !window.confirm(`Export compatibility report for Anki ${result.report.targetAnkiVersion}:\n\n${result.report.warnings.map((value) => `• ${value}`).join('\n')}\n\nThe live notes, cards, schedules, effective review history, and hash-verified media are included. Download the package with these explicit metadata transformations?`)) throw new Error('Anki export canceled after compatibility review.')
  return result.bytes
}

export const interoperabilityExtension: NeoAnkiCoreModule = {
  manifest: {
    id: 'neo-anki.interoperability',
    name: 'Anki & CSV Interoperability',
    version: '1.1.0',
    runtime: 'core',
    publisher: 'Neo Anki',
    permissions: ['imports:files', 'exports:files'],
  },
  importers: [
    { id: 'anki-package', label: 'Lossless Anki package migration', extensions: ['.apkg', '.colpkg'], import: importAnkiInWorker },
    { id: 'csv', label: 'CSV', extensions: ['.csv'], import: async (file) => importCsvText(await file.text()) },
  ],
  exporters: [
    { id: 'anki-apkg', label: 'Anki deck package (.apkg)', filename: 'neo-anki.apkg', mimeType: 'application/zip', export: exportAnki('apkg') },
    { id: 'anki-colpkg', label: 'Anki collection package (.colpkg)', filename: 'neo-anki.colpkg', mimeType: 'application/zip', export: exportAnki('colpkg') },
    { id: 'csv', label: 'CSV', filename: 'neo-anki.csv', mimeType: 'text/csv;charset=utf-8', export: (data) => exportCsv(data.items, data.cards) },
  ],
}
