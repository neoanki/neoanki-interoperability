import type { NeoAnkiExtension } from '../sdk'
import { importAnkiPackage } from './anki'
import { exportCsv, importCsvText } from './csv'

export const interoperabilityExtension: NeoAnkiExtension = {
  manifest: {
    id: 'neo-anki.interoperability',
    name: 'Anki & CSV Interoperability',
    version: '1.0.0',
    sdkVersion: 1,
    publisher: 'Neo Anki contributors',
    permissions: ['imports:files', 'exports:files'],
  },
  importers: [
    { id: 'anki-package', label: 'Anki package', extensions: ['.apkg', '.colpkg'], import: async (file) => importAnkiPackage(await file.arrayBuffer()) },
    { id: 'csv', label: 'CSV', extensions: ['.csv'], import: async (file) => importCsvText(await file.text()) },
  ],
  exporters: [{ id: 'csv', label: 'CSV', filename: 'neo-anki.csv', mimeType: 'text/csv;charset=utf-8', export: (data) => exportCsv(data.items, data.cards) }],
}
