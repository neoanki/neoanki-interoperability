/// <reference lib="webworker" />
import { importAnkiWorkspaceV4, MAX_ANKI_ARCHIVE_BYTES } from './anki'

self.onmessage = async (event: MessageEvent<{ file: File }>) => {
  try {
    if (event.data.file.size > MAX_ANKI_ARCHIVE_BYTES) throw new Error('Anki packages are limited to 64 MB compressed by the in-memory importer. Split larger collections before migration.')
    self.postMessage({ type: 'progress', message: 'Reading the package into the isolated import worker…' })
    const bytes = await event.data.file.arrayBuffer()
    self.postMessage({ type: 'progress', message: 'Extracting the bounded archive and decoding the Anki collection…' })
    const imported = await importAnkiWorkspaceV4(bytes, event.data.file.name)
    self.postMessage({ type: 'progress', message: 'Validating graph invariants and preparing the migration report…' })
    const result = { ...imported.projection, workspaceDocumentV4: imported.document, workspaceV4Media: imported.mediaAssets, workspaceV4SourceArchive: imported.sourceArchive }
    self.postMessage({ ok: true, result })
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Anki import failed.' })
  }
}
