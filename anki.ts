import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { strToU8, Unzip, UnzipInflate, zipSync } from 'fflate'
import { decompress } from 'fzstd'
import type { ImportSummary, KnowledgeItem, MediaAsset, PracticeCard, PromptVariant } from '../../types'
import {
  createWorkspaceDocumentV4,
  type CardTemplate,
  type Deck,
  type DeckPreset,
  type ExportCompatibilityReport,
  type FieldDefinition,
  type MigrationFidelityRecord,
  type NoteType,
  type SourceEnvelope,
  type WorkspaceDocumentV4,
} from '../../../packages/compatibility-domain/src/index'
import { makeEmptyFSRSCard } from '../../lib/fsrs'
import { createAssetFromBytes } from '../../lib/media'
import { workspaceDocumentV4ToAppData } from '../../lib/workspace-v4'

export const MAX_ANKI_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024
const MAX_ENTRY_BYTES = 128 * 1024 * 1024
const MAX_DATABASE_BYTES = 128 * 1024 * 1024
const MAX_ENTRIES = 25_000
const MAX_COMPRESSION_RATIO = 200
const IMPORT_STREAM_CHUNK_BYTES = 1024 * 1024

const uint16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8)
const uint32 = (bytes: Uint8Array, offset: number) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0

const validateArchiveEntryName = (name: string) => {
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some((part) => part === '..')) throw new Error(`Unsafe archive entry: ${name || '(empty)'}.`)
}

export const validateAnkiArchiveBounds = (bytes: Uint8Array) => {
  if (bytes.byteLength > MAX_ANKI_ARCHIVE_BYTES) throw new Error('Anki packages are limited to 64 MB compressed by the in-memory importer. Split larger collections before migration.')
  let eocd = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (uint32(bytes, index) === 0x06054b50) { eocd = index; break }
  }
  if (eocd < 0) throw new Error('This file is not a complete ZIP package.')
  const entries = uint16(bytes, eocd + 10)
  const centralOffset = uint32(bytes, eocd + 16)
  if (entries === 0xffff || centralOffset === 0xffffffff) throw new Error('ZIP64 Anki packages are not supported by this bounded importer.')
  if (entries > MAX_ENTRIES) throw new Error(`Anki packages may contain at most ${MAX_ENTRIES.toLocaleString()} entries.`)
  let offset = centralOffset
  let expanded = 0
  for (let index = 0; index < entries; index += 1) {
    if (uint32(bytes, offset) !== 0x02014b50) throw new Error('The Anki ZIP directory is malformed.')
    const flags = uint16(bytes, offset + 8)
    const compressed = uint32(bytes, offset + 20)
    const uncompressed = uint32(bytes, offset + 24)
    const nameLength = uint16(bytes, offset + 28)
    const extraLength = uint16(bytes, offset + 30)
    const commentLength = uint16(bytes, offset + 32)
    if ((flags & 1) !== 0) throw new Error('Encrypted ZIP entries are not supported.')
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error('ZIP64 entries are not supported by this bounded importer.')
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    validateArchiveEntryName(name)
    if (uncompressed > MAX_ENTRY_BYTES) throw new Error(`Archive entry ${name} exceeds 128 MB.`)
    if (compressed > 0 && uncompressed / compressed > MAX_COMPRESSION_RATIO) throw new Error(`Archive entry ${name} exceeds the 200:1 compression-ratio limit.`)
    expanded += uncompressed
    if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED_BYTES) throw new Error('The expanded Anki package exceeds 256 MB. Split the collection before migration.')
    offset += 46 + nameLength + extraLength + commentLength
    if (offset > bytes.length) throw new Error('The Anki ZIP directory is truncated.')
  }
  return { entries, expandedBytes: expanded }
}

const unzipAnkiArchive = (bytes: Uint8Array): Promise<Record<string, Uint8Array>> => new Promise((resolve, reject) => {
  const archive: Record<string, Uint8Array> = {}
  let active = 0
  let discovered = 0
  let expanded = 0
  let inputComplete = false
  let settled = false
  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    reject(error instanceof Error ? error : new Error('The Anki ZIP stream could not be decoded.'))
  }
  const finish = () => {
    if (settled || !inputComplete || active !== 0) return
    settled = true
    resolve(archive)
  }
  const unzipper = new Unzip((file) => {
    if (settled) { file.terminate(); return }
    try {
      validateArchiveEntryName(file.name)
      discovered += 1
      if (discovered > MAX_ENTRIES) throw new Error(`Anki packages may contain at most ${MAX_ENTRIES.toLocaleString()} entries.`)
      if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY_BYTES) throw new Error(`Archive entry ${file.name} exceeds 128 MB.`)
      active += 1
      const chunks: Uint8Array[] = []
      let entryBytes = 0
      file.ondata = (error, chunk, final) => {
        if (settled) return
        if (error) { fail(error); return }
        entryBytes += chunk.byteLength
        expanded += chunk.byteLength
        if (entryBytes > MAX_ENTRY_BYTES) { file.terminate(); fail(new Error(`Archive entry ${file.name} exceeds 128 MB.`)); return }
        if (!Number.isSafeInteger(expanded) || expanded > MAX_EXPANDED_BYTES) { file.terminate(); fail(new Error('The expanded Anki package exceeds 256 MB. Split the collection before migration.')); return }
        if (chunk.byteLength) chunks.push(chunk.slice())
        if (!final) return
        const entry = new Uint8Array(entryBytes)
        let offset = 0
        for (const value of chunks) { entry.set(value, offset); offset += value.byteLength }
        archive[file.name] = entry
        active -= 1
        finish()
      }
      file.start()
    } catch (error) { file.terminate(); fail(error) }
  })
  unzipper.register(UnzipInflate)
  try {
    for (let offset = 0; offset < bytes.byteLength && !settled; offset += IMPORT_STREAM_CHUNK_BYTES) unzipper.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + IMPORT_STREAM_CHUNK_BYTES)), offset + IMPORT_STREAM_CHUNK_BYTES >= bytes.byteLength)
    inputComplete = true
    finish()
  } catch (error) { fail(error) }
})

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const fieldText = (value: SqlValue | undefined) => String(value ?? '')
const htmlToText = (value: string) => value
  .replace(/<br\s*\/?\s*>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replaceAll('&nbsp;', ' ')
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

const tableRows = (database: Database, query: string): Record<string, SqlValue>[] => {
  const result = database.exec(query)[0]
  if (!result) return []
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])))
}

const mediaReferences = (fields: string) => [...fields.matchAll(/(?:src|href)=["']([^"']+)["']|\[sound:([^\]]+)\]/gi)].map((match) => match[1] || match[2])

const readVarint = (bytes: Uint8Array, start: number) => {
  let value = 0
  let shift = 0
  let index = start
  // Protobuf permits ten-byte uint64 varints. Some current Anki field/template
  // identifiers use the full width even though this importer only consumes
  // small enum/length values from those messages.
  while (index < bytes.length && shift < 70) {
    const byte = bytes[index]
    index += 1
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return { value, index }
    shift += 7
  }
  throw new Error('Invalid Anki media metadata.')
}

const base64Bytes = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

type ProtoValue = number | Uint8Array
interface ProtoField { field: number; wire: number; value: ProtoValue }
const protoFields = (bytes: Uint8Array): ProtoField[] => {
  const fields: ProtoField[] = []
  let index = 0
  while (index < bytes.length) {
    const tag = readVarint(bytes, index); index = tag.index
    const field = tag.value >>> 3; const wire = tag.value & 7
    if (wire === 0) { const value = readVarint(bytes, index); index = value.index; fields.push({ field, wire, value: value.value }) }
    else if (wire === 1) { if (index + 8 > bytes.length) throw new Error('Truncated protobuf field.'); fields.push({ field, wire, value: bytes.slice(index, index + 8) }); index += 8 }
    else if (wire === 2) { const length = readVarint(bytes, index); index = length.index; if (index + length.value > bytes.length) throw new Error('Truncated protobuf field.'); fields.push({ field, wire, value: bytes.slice(index, index + length.value) }); index += length.value }
    else if (wire === 5) { if (index + 4 > bytes.length) throw new Error('Truncated protobuf field.'); fields.push({ field, wire, value: bytes.slice(index, index + 4) }); index += 4 }
    else throw new Error(`Unsupported protobuf wire type ${wire}.`)
  }
  return fields
}
const protoNumber = (fields: ProtoField[], field: number, fallback = 0) => fields.find((value) => value.field === field && typeof value.value === 'number')?.value as number | undefined ?? fallback
const protoBytes = (fields: ProtoField[], field: number) => fields.find((value) => value.field === field && value.value instanceof Uint8Array)?.value as Uint8Array | undefined
const protoString = (fields: ProtoField[], field: number, fallback = '') => { const value = protoBytes(fields, field); return value ? decode(value) : fallback }
/** Normalized Anki schemas store deck hierarchy with U+001F internally. */
const ankiDeckName = (value: string) => value.replaceAll('\u001f', '::')
const protoFloats = (fields: ProtoField[], field: number) => fields.filter((value) => value.field === field).flatMap((value) => {
  if (!(value.value instanceof Uint8Array)) return []
  const bytes = value.value
  if (value.wire === 5) return [new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true)]
  if (value.wire === 2 && bytes.byteLength % 4 === 0) return Array.from({ length: bytes.byteLength / 4 }, (_, index) => new DataView(bytes.buffer, bytes.byteOffset + index * 4, 4).getFloat32(0, true))
  return []
})

const opaqueSqlValue = (value: SqlValue) => value instanceof Uint8Array ? { base64: base64Bytes(value) } : value
const opaqueRow = (row: Record<string, SqlValue>) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, opaqueSqlValue(value)]))
const safeAnkiOpaque = (value: Record<string, unknown>) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw new Error('An Anki source record exceeds the 1 MiB inert-metadata safety limit and cannot be preserved losslessly.')
  return value
}

const skipField = (bytes: Uint8Array, index: number, wire: number) => {
  if (wire === 0) return readVarint(bytes, index).index
  if (wire === 1) return index + 8
  if (wire === 2) { const length = readVarint(bytes, index); return length.index + length.value }
  if (wire === 5) return index + 4
  throw new Error('Unsupported Anki media metadata field.')
}

const mediaEntryName = (bytes: Uint8Array) => {
  let index = 0
  while (index < bytes.length) {
    const tag = readVarint(bytes, index); index = tag.index
    const field = tag.value >>> 3
    const wire = tag.value & 7
    if (field === 1 && wire === 2) {
      const length = readVarint(bytes, index)
      return decode(bytes.subarray(length.index, length.index + length.value))
    }
    index = skipField(bytes, index, wire)
  }
  throw new Error('An Anki media entry has no filename.')
}

export const decodeModernMediaNames = (bytes: Uint8Array) => {
  const names: string[] = []
  let index = 0
  while (index < bytes.length) {
    const tag = readVarint(bytes, index); index = tag.index
    const field = tag.value >>> 3
    const wire = tag.value & 7
    if (field === 1 && wire === 2) {
      const length = readVarint(bytes, index)
      names.push(mediaEntryName(bytes.subarray(length.index, length.index + length.value)))
      index = length.index + length.value
    } else index = skipField(bytes, index, wire)
  }
  return names
}

const extractAnkiMedia = async (archive: Record<string, Uint8Array>, modernEntry?: Uint8Array) => {
  const mediaMap: Record<string, string> = archive.media
    ? modernEntry
      ? Object.fromEntries(decodeModernMediaNames(decompress(archive.media)).map((name, index) => [String(index), name]))
      : JSON.parse(decode(archive.media)) as Record<string, string>
    : {}
  const assets: MediaAsset[] = []
  for (const [entry, filename] of Object.entries(mediaMap)) {
    const bytes = archive[entry]
    if (!bytes) continue
    assets.push(await createAssetFromBytes(filename, modernEntry ? decompress(bytes) : bytes))
  }
  return assets
}

export const importAnkiPackage = async (buffer: ArrayBuffer, locateWasm: () => string = () => wasmUrl): Promise<ImportSummary> => {
  const packageBytes = new Uint8Array(buffer)
  validateAnkiArchiveBounds(packageBytes)
  const archive = await unzipAnkiArchive(packageBytes)
  const modernEntry = archive['collection.anki21b']
  const databaseEntry = modernEntry ? decompress(modernEntry) : archive['collection.anki21'] || archive['collection.anki2']
  if (!databaseEntry) {
    throw new Error('No supported Anki collection database was found in this package.')
  }
  if (databaseEntry.byteLength > MAX_DATABASE_BYTES) throw new Error('The expanded Anki database exceeds 128 MB. Split the collection before migration.')
  const SQL = await initSqlJs({ locateFile: locateWasm })
  const database = new SQL.Database(databaseEntry)
  try {
    const normalizedSchema = tableRows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='decks'").length > 0
    const col = normalizedSchema ? undefined : tableRows(database, 'SELECT decks, models FROM col LIMIT 1')[0]
    const decks = normalizedSchema
      ? Object.fromEntries(tableRows(database, 'SELECT id, name FROM decks').map((deck) => [fieldText(deck.id), { name: ankiDeckName(fieldText(deck.name)) }]))
      : JSON.parse(fieldText(col?.decks) || '{}') as Record<string, { name?: string }>
    const models = normalizedSchema ? {} : JSON.parse(fieldText(col?.models) || '{}') as Record<string, { tmpls?: Array<{ ord?: number; name?: string; qfmt?: string }> }>
    const rawNotes = tableRows(database, 'SELECT id, guid, mid, tags, flds FROM notes')
    const rawCards = tableRows(database, 'SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps FROM cards')
    const hasRevlog = tableRows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='revlog'").length > 0
    const reviewCount = hasRevlog ? tableRows(database, 'SELECT COUNT(*) AS count FROM revlog')[0]?.count : 0
    const assets = await extractAnkiMedia(archive, modernEntry)
    const assetByFilename = new Map(assets.map((asset) => [asset.filename, asset.id]))
    const now = new Date().toISOString()
    const items: KnowledgeItem[] = rawNotes.map((note) => {
      const fields = fieldText(note.flds).split('\u001f')
      const raw = fields.join(' ')
      return {
        id: `anki-note-${fieldText(note.guid) || fieldText(note.id)}`,
        prompt: htmlToText(fields[0] || ''), answer: htmlToText(fields[1] || fields[0] || ''),
        context: htmlToText(fields.slice(2).join('\n')), collection: 'Imported from Anki',
        tags: fieldText(note.tags).trim().split(/\s+/).filter(Boolean), citations: [],
        mediaIds: mediaReferences(raw).map((name) => assetByFilename.get(name)).filter((id): id is string => Boolean(id)),
        occlusions: [], createdAt: now, updatedAt: now,
      }
    })
    const itemByLegacyId = new Map(rawNotes.map((note, index) => [fieldText(note.id), items[index]]))
    const warnings: string[] = []
    const cards: PracticeCard[] = rawCards.flatMap((legacy): PracticeCard[] => {
      const item = itemByLegacyId.get(fieldText(legacy.nid))
      if (!item) return []
      const deck = decks[fieldText(legacy.did)]?.name
      if (deck) item.collection = deck.replaceAll('::', ' / ')
      const template = models[fieldText(rawNotes.find((note) => fieldText(note.id) === fieldText(legacy.nid))?.mid)]?.tmpls?.find((candidate) => candidate.ord === Number(legacy.ord))
      const qfmt = template?.qfmt || ''
      const variant: PromptVariant = item.prompt.includes('{{c') ? 'cloze' : /type:/i.test(qfmt) ? 'typed' : Number(legacy.ord) > 0 ? 'reverse' : 'forward'
      const fsrs = makeEmptyFSRSCard(new Date(now))
      if (Number(legacy.queue) < 0) warnings.push(`Card ${fieldText(legacy.id)} was suspended in Anki and remains suspended.`)
      return [{ id: `anki-card-${fieldText(legacy.id)}`, itemId: item.id, variant, promptData: variant === 'cloze' ? { clozeOrdinal: Number(legacy.ord) + 1 } : undefined, suspended: Number(legacy.queue) < 0, fsrs, estimatedSeconds: variant === 'typed' ? 20 : 14, createdAt: now, updatedAt: now }]
    })
    warnings.unshift('Imported content, decks, tags, prompt direction, suspension, and media. Neo Anki will schedule future reviews with FSRS; legacy interval history is not copied losslessly.')
    const preserved = (path: string, count: number, detail: string) => ({ path, disposition: 'preserved' as const, count, detail, requiresAcceptance: false })
    const reset = (path: string, count: number, detail: string) => ({ path, disposition: 'reset' as const, count, detail, requiresAcceptance: true })
    const unsupported = (path: string, count: number, detail: string) => ({ path, disposition: 'unsupported' as const, count, detail, requiresAcceptance: true })
    return {
      source: 'anki', items, cards, assets, warnings,
      preflight: {
        operation: 'additive',
        inventory: { notes: rawNotes.length, cards: rawCards.length, media: assets.length, reviews: Number(reviewCount || 0) },
        fidelity: [
          preserved('notes.basicFields', rawNotes.length, 'The first fields are transformed into Neo prompt, answer, and context text.'),
          preserved('decks', Object.keys(decks).length, 'Card deck names become Neo collections.'),
          preserved('tags', rawNotes.length, 'Note tags are copied.'),
          preserved('media', assets.length, 'Referenced media is copied and content-hashed.'),
          reset('cards.scheduling', rawCards.length, 'Due dates, intervals, ease, learning steps, and FSRS memory state reset.'),
          reset('reviews', Number(reviewCount || 0), 'Review history is not imported into Workspace v3.'),
          unsupported('noteTypes.templatesCss', Object.keys(models).length, 'Named fields, templates, CSS, and multi-card semantics are not represented losslessly.'),
          unsupported('cards.states', rawCards.length, 'Flags, bury state, filtered-deck membership, and preset ownership are not preserved.'),
        ],
        canCommit: true,
      },
    }
  } finally { database.close() }
}

export interface AnkiWorkspaceV4Import {
  document: WorkspaceDocumentV4
  projection: ImportSummary
  mediaAssets: MediaAsset[]
  sourceArchive: Uint8Array
  sourceSha256: string
  sourceFormat: 'anki-apkg' | 'anki-colpkg'
}

const isoFromSeconds = (value: number, fallback: string) => Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : fallback
const ankiDueAt = (queue: number, due: number, collectionCreatedSeconds: number, now: string) => {
  if (queue === 1 || queue === 3 || queue === 4) return isoFromSeconds(due, now)
  if (queue === 2 || queue < 0) {
    const day = new Date(collectionCreatedSeconds * 1000)
    day.setDate(day.getDate() + Math.max(0, due))
    return day.toISOString()
  }
  return now
}
const nextLocalStudyDay = (now: string) => {
  const value = new Date(now)
  value.setHours(24, 0, 0, 0)
  return value.toISOString()
}
const ankiQueue = (type: number): 'new' | 'learn' | 'review' | 'relearn' | 'preview' => type === 0 ? 'new' : type === 1 ? 'learn' : type === 2 ? 'review' : type === 3 ? 'relearn' : 'preview'

const templateCompatibilityFidelity = (templates: CardTemplate[]): MigrationFidelityRecord[] => {
  const affected = (predicate: (source: string) => boolean) => templates.filter((template) => predicate(`${template.questionFormat}\n${template.answerFormat}`))
  const tokenFilters = (source: string) => [...source.matchAll(/{{([^{}]+)}}/g)].flatMap((match) => {
    const token = match[1].trim()
    if (!token || /^[#^/]/.test(token) || token === 'FrontSide' || !token.includes(':')) return []
    const segments = token.split(':')
    if (segments.length !== 2) return [segments.slice(0, -1).join(':').toLowerCase()]
    return [segments[0].trim().toLowerCase()]
  })
  const supportedFilters = new Set(['type', 'cloze', 'cloze-only', 'text', 'hint'])
  const unsupportedFilters = affected((source) => tokenFilters(source).some((filter) => !supportedFilters.has(filter)))
  const composedFilters = affected((source) => tokenFilters(source).some((filter) => filter.includes(':')))
  const latex = affected((source) => /\[(?:latex|\$\$|\$)]|\\\((?:latex|\$\$|\$)\)/i.test(source))
  const ankiTts = affected((source) => /{{\s*tts(?:-voices)?(?:\s|:)/i.test(source))
  const scripts = affected((source) => /<script\b/i.test(source))
  const ankiBridge = affected((source) => /\b(?:pycmd|bridgeCommand|ankiPlatform|AnkiDroidJS|window\.anki)\b/i.test(source))
  const network = affected((source) => /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|<(?:img|audio|video|source|link|script)\b[^>]+(?:src|href)=["']https?:/i.test(source))
  const record = (path: string, values: CardTemplate[], disposition: 'transformed' | 'unsupported', detail: string): MigrationFidelityRecord | undefined => values.length ? { path, disposition, count: new Set(values.map((value) => value.id)).size, detail, requiresAcceptance: true } : undefined
  return [
    record('templates.unsupportedFilters', unsupportedFilters, 'unsupported', 'These templates use field filters Neo Anki does not implement. Their source remains available and exportable, but study rendering falls back to the unfiltered field value.'),
    record('templates.composedFilters', composedFilters, 'unsupported', 'These templates compose multiple field filters. Neo Anki preserves the template but cannot guarantee the same rendered result.'),
    record('templates.latex', latex, 'unsupported', 'Anki LaTeX generation is not available in Neo Anki. Source markup is preserved, but generated images will only work when already present as media.'),
    record('templates.ankiTts', ankiTts, 'unsupported', 'Anki template TTS directives are preserved but are not executed. Configure NeoAnki TTS after migration instead.'),
    record('templates.sandboxedScripts', scripts, 'unsupported', 'Template JavaScript is preserved as source but blocked during study. Neo Anki does not execute imported scripts or expose application, filesystem, secret, or network access.'),
    record('templates.ankiBridgeApis', ankiBridge, 'unsupported', 'These templates call an Anki or AnkiDroid JavaScript bridge that Neo Anki does not expose.'),
    record('templates.blockedNetwork', network, 'unsupported', 'Template network requests and remote resources are blocked by the card sandbox. Package required assets as collection media.'),
  ].filter((value): value is MigrationFidelityRecord => Boolean(value))
}

/** Lossless compatibility import. Known fields are mapped and every raw source row/config is retained inertly for round-trip export. */
export const importAnkiWorkspaceV4 = async (buffer: ArrayBuffer, filename = 'collection.apkg', locateWasm: () => string = () => wasmUrl): Promise<AnkiWorkspaceV4Import> => {
  const packageBytes = new Uint8Array(buffer)
  validateAnkiArchiveBounds(packageBytes)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', packageBytes))
  const sourceSha256 = [...digest].map((value) => value.toString(16).padStart(2, '0')).join('')
  const sourceFormat = /\.colpkg$/i.test(filename) ? 'anki-colpkg' as const : 'anki-apkg' as const
  const archive = await unzipAnkiArchive(packageBytes)
  const modernEntry = archive['collection.anki21b']
  const databaseEntry = modernEntry ? decompress(modernEntry) : archive['collection.anki21'] || archive['collection.anki2']
  if (!databaseEntry) throw new Error('No supported Anki collection database was found in this package.')
  const SQL = await initSqlJs({ locateFile: locateWasm })
  const database = new SQL.Database(databaseEntry)
  try {
    const now = new Date().toISOString()
    const hasTable = (name: string) => tableRows(database, `SELECT name FROM sqlite_master WHERE type='table' AND name='${name.replaceAll("'", "''")}'`).length > 0
    const col = hasTable('col') ? tableRows(database, 'SELECT * FROM col LIMIT 1')[0] : undefined
    const createdSeconds = Number(col?.crt || Math.floor(Date.now() / 1000))
    const collectionIdentity = Number.isFinite(Number(col?.crt)) && Number(col?.crt) > 0 ? `crt:${Number(col!.crt)}` : `package:${sourceSha256}`
    const identityDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`neoanki:anki-collection:${collectionIdentity}`)))
    const prefix = `anki:${[...identityDigest].map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 20)}`
    const profileId = `${prefix}:profile`
    const sourceId = (kind: string, id: string | number) => `${prefix}:source:${kind}:${id}`
    const entityId = (kind: string, id: string | number) => `${prefix}:${kind}:${id}`
    const normalized = hasTable('notetypes') && hasTable('fields') && hasTable('templates')
    const envelopes: SourceEnvelope[] = [{ id: sourceId('package', 'root'), revision: 1, createdAt: now, updatedAt: now, profileId, format: sourceFormat, sourceId: collectionIdentity, schemaVersion: modernEntry ? 'latest-zstd' : archive['collection.anki21'] ? 'anki21' : 'anki2', sha256: sourceSha256, opaque: safeAnkiOpaque({ filename, collection: col ? opaqueRow(col) : {}, archiveEntries: Object.keys(archive).sort() }) }]
    const addEnvelope = (kind: string, id: string | number, raw: Record<string, unknown>) => {
      const envelope: SourceEnvelope = { id: sourceId(kind, id), revision: 1, createdAt: now, updatedAt: now, profileId, format: sourceFormat, sourceId: String(id), schemaVersion: normalized ? '15+' : 'legacy-json', opaque: safeAnkiOpaque(raw) }
      envelopes.push(envelope); return envelope.id
    }

    const rawNotes = tableRows(database, 'SELECT * FROM notes')
    const rawCards = tableRows(database, 'SELECT * FROM cards')
    const rawReviews = hasTable('revlog') ? tableRows(database, 'SELECT * FROM revlog') : []
    const notesByModel = new Map<string, Record<string, SqlValue>[]>()
    for (const note of rawNotes) { const key = fieldText(note.mid); notesByModel.set(key, [...(notesByModel.get(key) || []), note]) }
    const cardsByModel = new Map<string, Record<string, SqlValue>[]>()
    const noteModel = new Map(rawNotes.map((note) => [fieldText(note.id), fieldText(note.mid)]))
    for (const card of rawCards) { const key = noteModel.get(fieldText(card.nid)) || ''; cardsByModel.set(key, [...(cardsByModel.get(key) || []), card]) }

    const noteTypes: NoteType[] = []
    const fields: FieldDefinition[] = []
    const templates: CardTemplate[] = []
    const legacyModels = !normalized ? JSON.parse(fieldText(col?.models) || '{}') as Record<string, Record<string, unknown>> : {}
    const normalizedTypes = normalized ? tableRows(database, 'SELECT * FROM notetypes') : []
    const modelRows = normalized ? normalizedTypes : Object.entries(legacyModels).map(([id, model]) => ({ id, name: String(model.name || `Note Type ${id}`), legacy: model } as unknown as Record<string, SqlValue>))
    const modelIds = new Set([...modelRows.map((row) => fieldText(row.id)), ...notesByModel.keys()])
    for (const modelId of modelIds) {
      const row = modelRows.find((value) => fieldText(value.id) === modelId)
      const legacy = legacyModels[modelId]
      const configBytes = row?.config instanceof Uint8Array ? row.config : new Uint8Array()
      const config = configBytes.length ? protoFields(configBytes) : []
      const normalizedFields = normalized ? tableRows(database, `SELECT * FROM fields WHERE ntid = ${Number(modelId) || 0} ORDER BY ord`) : []
      const legacyFields = Array.isArray(legacy?.flds) ? legacy.flds as Array<Record<string, unknown>> : []
      const inferredFieldCount = Math.max(1, ...((notesByModel.get(modelId) || []).map((note) => fieldText(note.flds).split('\u001f').length)))
      const sourceFields = normalizedFields.length ? normalizedFields : legacyFields.length ? legacyFields.map((value, index) => ({ ...value, ord: Number(value.ord ?? index), name: String(value.name || `Field ${index + 1}`) } as unknown as Record<string, SqlValue>)) : Array.from({ length: inferredFieldCount }, (_, index) => ({ ord: index, name: `Field ${index + 1}` } as Record<string, SqlValue>))
      const fieldIds = sourceFields.map((value) => entityId('field', `${modelId}:${Number(value.ord)}`))
      for (const [index, value] of sourceFields.entries()) {
        const fieldConfigBytes = value.config instanceof Uint8Array ? value.config : new Uint8Array()
        const fieldConfig = fieldConfigBytes.length ? protoFields(fieldConfigBytes) : []
        fields.push({ id: fieldIds[index], revision: 1, createdAt: now, updatedAt: now, noteTypeId: entityId('notetype', modelId), name: fieldText(value.name) || `Field ${index + 1}`, ordinal: Number(value.ord ?? index), rtl: fieldConfigBytes.length ? Boolean(protoNumber(fieldConfig, 2)) : Boolean((value as unknown as Record<string, unknown>).rtl), sticky: fieldConfigBytes.length ? Boolean(protoNumber(fieldConfig, 1)) : Boolean((value as unknown as Record<string, unknown>).sticky), font: fieldConfigBytes.length ? protoString(fieldConfig, 3) || undefined : String((value as unknown as Record<string, unknown>).font || '') || undefined, fontSize: fieldConfigBytes.length ? protoNumber(fieldConfig, 4) || undefined : Number((value as unknown as Record<string, unknown>).size) || undefined })
      }
      const normalizedTemplates = normalized ? tableRows(database, `SELECT * FROM templates WHERE ntid = ${Number(modelId) || 0} ORDER BY ord`) : []
      const legacyTemplates = Array.isArray(legacy?.tmpls) ? legacy.tmpls as Array<Record<string, unknown>> : []
      const inferredTemplateOrds = [...new Set((cardsByModel.get(modelId) || []).map((card) => Number(card.ord)))].sort((a, b) => a - b)
      const sourceTemplates = normalizedTemplates.length ? normalizedTemplates : legacyTemplates.length ? legacyTemplates.map((value, index) => ({ ...value, ord: Number(value.ord ?? index), name: String(value.name || `Card ${index + 1}`) } as unknown as Record<string, SqlValue>)) : (inferredTemplateOrds.length ? inferredTemplateOrds : [0]).map((ord) => ({ ord, name: `Card ${ord + 1}` } as Record<string, SqlValue>))
      const templateIds = sourceTemplates.map((value) => entityId('template', `${modelId}:${Number(value.ord)}`))
      for (const [index, value] of sourceTemplates.entries()) {
        const templateConfigBytes = value.config instanceof Uint8Array ? value.config : new Uint8Array()
        const templateConfig = templateConfigBytes.length ? protoFields(templateConfigBytes) : []
        const raw = value as unknown as Record<string, unknown>
        templates.push({ id: templateIds[index], revision: 1, createdAt: now, updatedAt: now, noteTypeId: entityId('notetype', modelId), name: fieldText(value.name) || `Card ${index + 1}`, ordinal: Number(value.ord ?? index), questionFormat: templateConfigBytes.length ? protoString(templateConfig, 1, '{{Field 1}}') : String(raw.qfmt || '{{Field 1}}'), answerFormat: templateConfigBytes.length ? protoString(templateConfig, 2, '{{FrontSide}}<hr>{{Field 2}}') : String(raw.afmt || '{{FrontSide}}<hr>{{Field 2}}'), browserQuestionFormat: templateConfigBytes.length ? protoString(templateConfig, 3) || undefined : String(raw.bqfmt || '') || undefined, browserAnswerFormat: templateConfigBytes.length ? protoString(templateConfig, 4) || undefined : String(raw.bafmt || '') || undefined, deckOverrideId: (templateConfigBytes.length ? protoNumber(templateConfig, 5) : Number(raw.did)) ? entityId('deck', templateConfigBytes.length ? protoNumber(templateConfig, 5) : Number(raw.did)) : undefined })
      }
      const name = fieldText(row?.name) || String(legacy?.name || `Note Type ${modelId}`)
      const kind = (configBytes.length ? protoNumber(config, 1) : Number(legacy?.type)) === 1 ? 'cloze' as const : 'standard' as const
      const css = configBytes.length ? protoString(config, 3) : String(legacy?.css || '.card { font-family: Arial; font-size: 20px; }')
      const envelopeId = addEnvelope('notetype', modelId, { row: row ? opaqueRow(row) : {}, legacy: legacy || {}, fields: sourceFields.map(opaqueRow), templates: sourceTemplates.map(opaqueRow) })
      noteTypes.push({ id: entityId('notetype', modelId), revision: 1, createdAt: now, updatedAt: now, profileId, name, fieldIds, templateIds, css, kind, sourceEnvelopeId: envelopeId })
    }

    const normalizedDeckRows = hasTable('decks') ? tableRows(database, 'SELECT * FROM decks') : []
    const legacyDecks = !normalizedDeckRows.length ? JSON.parse(fieldText(col?.decks) || '{}') as Record<string, Record<string, unknown>> : {}
    const deckRows = normalizedDeckRows.length ? normalizedDeckRows : Object.entries(legacyDecks).map(([id, value]) => ({ id, name: String(value.name || `Deck ${id}`), legacy: value } as unknown as Record<string, SqlValue>))
    const normalizedPresetRows = hasTable('deck_config') ? tableRows(database, 'SELECT * FROM deck_config') : []
    const legacyPresets = !normalizedPresetRows.length ? JSON.parse(fieldText(col?.dconf) || '{}') as Record<string, Record<string, unknown>> : {}
    const presetRows = normalizedPresetRows.length ? normalizedPresetRows : Object.entries(legacyPresets).map(([id, value]) => ({ id, name: String(value.name || `Preset ${id}`), legacy: value } as unknown as Record<string, SqlValue>))
    const presets: DeckPreset[] = []
    for (const row of presetRows.length ? presetRows : [{ id: 1, name: 'Default' } as unknown as Record<string, SqlValue>]) {
      const id = fieldText(row.id)
      const legacy = legacyPresets[id]
      const configBytes = row.config instanceof Uint8Array ? row.config : new Uint8Array()
      const config = configBytes.length ? protoFields(configBytes) : []
      const raw = legacy || {}
      const rawNew = raw.new as Record<string, unknown> | undefined
      const rawReview = raw.rev as Record<string, unknown> | undefined
      const rawLapse = raw.lapse as Record<string, unknown> | undefined
      const learn = configBytes.length ? protoFloats(config, 1) : (rawNew?.delays as number[] | undefined) || [1, 10]
      const relearn = configBytes.length ? protoFloats(config, 2) : (rawLapse?.delays as number[] | undefined) || [10]
      const envelopeId = addEnvelope('preset', id, { row: opaqueRow(row), legacy: raw })
      presets.push({ id: entityId('preset', id), revision: 1, createdAt: now, updatedAt: now, profileId, name: fieldText(row.name) || String(raw.name || `Preset ${id}`), scheduler: 'anki', desiredRetention: configBytes.length ? protoFloats(config, 37)[0] || .9 : Number(raw.desiredRetention || .9), maximumIntervalDays: configBytes.length ? protoNumber(config, 16, 36500) : Number(rawReview?.maxIvl || 36500), learningStepsMinutes: learn.map(Number), relearningStepsMinutes: relearn.map(Number), newCardsPerDay: configBytes.length ? protoNumber(config, 9, 20) : Number(rawNew?.perDay || 20), reviewsPerDay: configBytes.length ? protoNumber(config, 10, 200) : Number(rawReview?.perDay || 200), buryNewSiblings: configBytes.length ? Boolean(protoNumber(config, 27)) : rawNew?.bury !== false, buryReviewSiblings: configBytes.length ? Boolean(protoNumber(config, 28)) : rawReview?.bury !== false, leechThreshold: configBytes.length ? protoNumber(config, 22, 8) : Number(rawLapse?.leechFails || 8), leechAction: (configBytes.length ? protoNumber(config, 21) === 0 : Number(rawLapse?.leechAction || 0) === 0) ? 'suspend' : 'flag', sourceEnvelopeId: envelopeId })
    }
    const defaultPreset = presets[0]
    const decks: Deck[] = deckRows.map((row) => {
      const id = fieldText(row.id); const legacy = legacyDecks[id]
      const kindBytes = row.kind instanceof Uint8Array ? row.kind : new Uint8Array()
      const kindFields = kindBytes.length ? protoFields(kindBytes) : []
      const normal = protoBytes(kindFields, 1); const filtered = protoBytes(kindFields, 2)
      const presetSource = normal ? String(protoNumber(protoFields(normal), 1, Number(legacy?.conf || 1))) : String(legacy?.conf || 1)
      const name = ankiDeckName(fieldText(row.name) || String(legacy?.name || `Deck ${id}`))
      const parentName = name.includes('::') ? name.slice(0, name.lastIndexOf('::')) : ''
      const parent = deckRows.find((value) => ankiDeckName(fieldText(value.name) || String(legacyDecks[fieldText(value.id)]?.name || '')) === parentName)
      const filteredConfig = filtered ? protoFields(filtered) : []
      const isFiltered = Boolean(filtered || legacy?.dyn)
      const reschedule = filtered ? Boolean(protoNumber(filteredConfig, 1)) : legacy?.resched !== false
      const envelopeId = addEnvelope('deck', id, { row: opaqueRow(row), legacy: legacy || {}, filtered: isFiltered, reschedule: isFiltered ? reschedule : undefined })
      return { id: entityId('deck', id), revision: 1, createdAt: now, updatedAt: now, profileId, name, parentDeckId: parent ? entityId('deck', fieldText(parent.id)) : undefined, presetId: presets.find((value) => value.id === entityId('preset', presetSource))?.id || defaultPreset.id, sourceEnvelopeId: envelopeId }
    })
    if (!decks.length) decks.push({ id: entityId('deck', 1), revision: 1, createdAt: now, updatedAt: now, profileId, name: 'Default', presetId: defaultPreset.id })
    const deckByLegacyId = new Map(deckRows.map((row, index) => [fieldText(row.id), decks[index]]))
    const noteTypeByLegacyId = new Map(noteTypes.map((value) => [value.id.split(':').at(-1)!, value]))

    const notes = rawNotes.map((row) => {
      const id = fieldText(row.id); const modelId = fieldText(row.mid); const type = noteTypeByLegacyId.get(modelId) || noteTypes[0]
      if (!type) throw new Error(`Anki note ${id} references missing note type ${modelId}.`)
      const values = fieldText(row.flds).split('\u001f')
      const mapped = Object.fromEntries(type.fieldIds.map((fieldId, index) => [fieldId, values[index] || '']))
      const tags = fieldText(row.tags).trim().split(/\s+/).filter(Boolean)
      const envelopeId = addEnvelope('note', id, { row: opaqueRow(row) })
      return { id: entityId('note', id), revision: 1, createdAt: isoFromSeconds(Number(row.id) / 1000, now), updatedAt: isoFromSeconds(Number(row.mod), now), profileId, noteTypeId: type.id, fields: mapped, tags, marked: tags.some((tag) => tag.toLowerCase() === 'marked'), sourceEnvelopeId: envelopeId }
    })
    const noteByLegacyId = new Map(rawNotes.map((row, index) => [fieldText(row.id), notes[index]]))
    const latestReviewByCard = new Map<string, number>()
    for (const row of rawReviews) {
      const cardId = fieldText(row.cid)
      const reviewedSeconds = Number(row.id) / 1000
      if (Number.isFinite(reviewedSeconds) && reviewedSeconds > (latestReviewByCard.get(cardId) || 0)) latestReviewByCard.set(cardId, reviewedSeconds)
    }
    const cards = rawCards.map((row) => {
      const id = fieldText(row.id); const note = noteByLegacyId.get(fieldText(row.nid)); if (!note) throw new Error(`Anki card ${id} references missing note ${fieldText(row.nid)}.`)
      const type = noteTypes.find((value) => value.id === note.noteTypeId)!
      const ordinal = Number(row.ord); const template = templates.find((value) => value.noteTypeId === type.id && value.ordinal === ordinal) || templates.find((value) => value.noteTypeId === type.id)!
      const did = fieldText(row.did); const odid = fieldText(row.odid); const deck = deckByLegacyId.get(did) || decks[0]
      const queue = Number(row.queue) || 0; const cardType = Number(row.type) || 0; const due = Number(row.due) || 0
      const envelopeId = addEnvelope('card', id, { row: opaqueRow(row) })
      let cardData: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(fieldText(row.data) || '{}') as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cardData = parsed as Record<string, unknown>
      } catch { /* malformed card metadata remains inert in the source envelope */ }
      const stability = Number(cardData.s)
      const difficulty = Number(cardData.d)
      const desiredRetention = Number(cardData.dr)
      const decay = Number(cardData.decay)
      const lastReviewSeconds = Number(cardData.lrt) || latestReviewByCard.get(id)
      const filteredEnvelope = envelopeByDeck(decks, envelopes, deck.id)
      const filtered = Number(row.odid) ? { deckId: deck.id, originalDeckId: deckByLegacyId.get(odid)?.id || entityId('deck', odid), originalDue: Number(row.odue), reschedule: filteredEnvelope?.opaque.reschedule !== false } : undefined
      const effectiveQueue = queue < 0 ? cardType : queue
      return { id: entityId('card', id), revision: 1, createdAt: isoFromSeconds(Number(row.id) / 1000, now), updatedAt: isoFromSeconds(Number(row.mod), now), profileId, noteId: note.id, templateId: template.id, deckId: deck.id, presetId: deck.presetId, ordinal, clozeOrdinal: type.kind === 'cloze' ? ordinal + 1 : undefined, flags: Math.max(0, Math.min(7, (Number(row.flags) || 0) & 7)) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7, suspended: queue === -1, leech: note.tags.some((tag) => tag.toLocaleLowerCase() === 'leech'), buriedUntil: queue === -2 || queue === -3 ? nextLocalStudyDay(now) : undefined, buriedBy: queue === -3 ? 'user' as const : queue === -2 ? 'scheduler' as const : undefined, filteredDeck: filtered, scheduling: { strategy: 'anki' as const, queue: ankiQueue(cardType), due, dueAt: ankiDueAt(effectiveQueue, due, createdSeconds, now), intervalDays: Number(row.ivl) || 0, easeFactor: Number(row.factor) || 0, repetitions: Number(row.reps) || 0, lapses: Number(row.lapses) || 0, remainingSteps: Number(row.left) || 0, originalDue: Number(row.odue) || undefined, originalDeckId: Number(row.odid) ? entityId('deck', odid) : undefined, mod: Number(row.mod) || 0, stability: Number.isFinite(stability) && stability > 0 ? stability : undefined, difficulty: Number.isFinite(difficulty) && difficulty >= 0 && difficulty <= 10 ? difficulty : undefined, desiredRetention: Number.isFinite(desiredRetention) && desiredRetention > 0 && desiredRetention <= 1 ? desiredRetention : undefined, decay: Number.isFinite(decay) && decay > 0 ? decay : undefined, lastReviewAt: lastReviewSeconds ? isoFromSeconds(lastReviewSeconds, now) : undefined }, sourceEnvelopeId: envelopeId }
    })
    const cardByLegacyId = new Map(rawCards.map((row, index) => [fieldText(row.id), cards[index]]))
    const reviews = rawReviews.flatMap((row) => {
      const card = cardByLegacyId.get(fieldText(row.cid)); if (!card) return []
      const id = fieldText(row.id); const intervalAfter = Number(row.ivl); const intervalBefore = Number(row.lastIvl ?? row.lastivl)
      return [{ id: entityId('review', id), revision: 1, createdAt: isoFromSeconds(Number(row.id) / 1000, now), updatedAt: isoFromSeconds(Number(row.id) / 1000, now), profileId, cardId: card.id, kind: 'review' as const, rating: Math.max(1, Math.min(4, Number(row.ease))) as 1 | 2 | 3 | 4, reviewedAt: isoFromSeconds(Number(row.id) / 1000, now), durationMilliseconds: Math.max(0, Number(row.time)), intervalBefore, intervalAfter, easeFactor: Number(row.factor), scheduler: 'anki' as const, sourceEnvelopeId: addEnvelope('review', id, { row: opaqueRow(row) }) }]
    })
    const extractedMedia = await extractAnkiMedia(archive, modernEntry)
    const media = extractedMedia.map((asset) => ({ id: entityId('media', asset.id), revision: 1, createdAt: asset.createdAt, updatedAt: asset.updatedAt, profileId, filename: asset.filename, mimeType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.hash, storageKey: asset.hash, sourceEnvelopeId: addEnvelope('media', asset.id, { filename: asset.filename, originalAssetId: asset.id }) }))
    const mediaAssets = extractedMedia.map((asset, index) => ({ ...asset, id: media[index].id }))
    const workspace = {
      version: 4 as const, workspaceId: `${prefix}:workspace`, revision: 1, deviceId: crypto.randomUUID(), createdAt: now, updatedAt: now,
      profiles: [{ id: profileId, revision: 1, createdAt: now, updatedAt: now, name: filename.replace(/\.(?:apkg|colpkg)$/i, '') || 'Anki collection', active: true, sourceEnvelopeId: sourceId('package', 'root') }],
      noteTypes, fields, templates, decks, presets, notes, cards, reviews, media, extensionRecords: [], sourceEnvelopes: envelopes,
    }
    const settings = { dailyMinutes: 30, retention: defaultPreset.desiredRetention, theme: 'light', onboardingComplete: false, recoveryStrategy: 'balanced', burySiblings: defaultPreset.buryReviewSiblings, leechThreshold: defaultPreset.leechThreshold, leechAction: defaultPreset.leechAction }
    const document = createWorkspaceDocumentV4(workspace, { settings, goals: [], views: [], packs: [], packConflicts: [], trash: [] })
    const appData = workspaceDocumentV4ToAppData(document)
    const templateCompatibility = templateCompatibilityFidelity(templates)
    const projectedDueNow = cards.filter((card) => !card.suspended && !card.buriedUntil && new Date(card.scheduling.dueAt).getTime() <= Date.now()).length
    const preflightWarnings = templateCompatibility.map((record) => `${record.path}: ${record.detail}`)
    const projection: ImportSummary = {
      source: 'anki',
      items: appData.items,
      cards: appData.cards,
      assets: mediaAssets,
      warnings: preflightWarnings.length ? preflightWarnings : ['Anki content and source metadata passed the Workspace v4 compatibility preflight.'],
      preflight: {
      operation: sourceFormat === 'anki-colpkg' ? 'replace-profile' : 'additive',
      sourceSha256,
      inventory: { notes: notes.length, cards: cards.length, media: media.length, reviews: reviews.length, noteTypes: noteTypes.length, decks: decks.length, presets: presets.length },
      fidelity: [
        { path: 'notes.namedFields', disposition: 'preserved', count: notes.length, detail: 'Named fields, order, HTML, tags, and note-type ownership are preserved.', requiresAcceptance: false },
        { path: 'noteTypes.templatesCss.source', disposition: 'preserved', count: noteTypes.length, detail: 'Template and CSS source is stored losslessly. Runtime compatibility is reported separately below.', requiresAcceptance: false },
        { path: 'cards.scheduling', disposition: 'preserved', count: cards.length, detail: 'Queue, due value and exact eligibility, interval, ease, repetitions, lapses, steps, flags, suspension, burying, and filtered-deck origin are preserved.', requiresAcceptance: false },
        { path: 'reviews', disposition: 'preserved', count: reviews.length, detail: 'Immutable revlog rows and their source scheduler values are preserved.', requiresAcceptance: false },
        { path: 'decks.presets', disposition: 'preserved', count: decks.length + presets.length, detail: 'Deck hierarchy, preset ownership, learning/relearning steps, limits, burying, retention, and leech behavior are preserved.', requiresAcceptance: false },
        { path: 'media', disposition: 'preserved', count: media.length, detail: 'Media bytes, filenames, hashes, and source identities are preserved.', requiresAcceptance: false },
        { path: 'source.unknownMetadata.bytes', disposition: 'preserved', count: envelopes.length, detail: 'Bounded unknown/add-on metadata remains inert for rollback and round-trip export; add-on behavior is never executed or implied.', requiresAcceptance: false },
        ...templateCompatibility,
      ],
      projectedDueNow,
      warnings: preflightWarnings,
      canCommit: true,
      },
    }
    return { document, projection, mediaAssets, sourceArchive: packageBytes.slice(), sourceSha256, sourceFormat }
  } finally { database.close() }
}

const envelopeByDeck = (decks: Array<{ id: string; sourceEnvelopeId?: string }>, envelopes: SourceEnvelope[], id: string) => {
  const deck = decks.find((value) => value.id === id)
  return deck?.sourceEnvelopeId ? envelopes.find((value) => value.id === deck.sourceEnvelopeId) : undefined
}

const numericSourceId = (document: WorkspaceDocumentV4, envelopeId: string | undefined) => {
  const source = envelopeId ? document.workspace.sourceEnvelopes.find((value) => value.id === envelopeId) : undefined
  const value = Number(source?.sourceId)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}
const unixSeconds = (value: string) => Math.max(0, Math.floor(new Date(value).getTime() / 1000))
const uniqueNumericIds = <T extends { id: string; sourceEnvelopeId?: string }>(document: WorkspaceDocumentV4, values: T[], start: number) => {
  const used = new Set<number>()
  const result = new Map<string, number>()
  let generated = start
  for (const value of [...values].sort((left, right) => left.id.localeCompare(right.id))) {
    let id = numericSourceId(document, value.sourceEnvelopeId)
    if (!id || used.has(id)) { while (used.has(generated)) generated += 1; id = generated++ }
    used.add(id); result.set(value.id, id)
  }
  return result
}
const sourceRow = (document: WorkspaceDocumentV4, envelopeId?: string) => {
  const row = envelopeId ? document.workspace.sourceEnvelopes.find((value) => value.id === envelopeId)?.opaque.row : undefined
  return row && typeof row === 'object' ? row as Record<string, unknown> : {}
}
const sha1Checksum = async (text: string) => {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(htmlToText(text))))
  return Number.parseInt([...bytes.slice(0, 4)].map((value) => value.toString(16).padStart(2, '0')).join(''), 16)
}

export interface AnkiExportV4Result { bytes: Uint8Array; report: ExportCompatibilityReport & { counts: Record<string, number>; warnings: string[] } }

const exportFidelity = (document: WorkspaceDocumentV4, target: 'apkg' | 'colpkg'): MigrationFidelityRecord[] => {
  const workspace = document.workspace
  const records: MigrationFidelityRecord[] = [
    { path: 'notes.fieldsTemplatesCss', disposition: 'preserved', count: workspace.notes.length, detail: 'Named fields, note types, templates, CSS, tags, and card ordinals are written into the Anki package.', requiresAcceptance: false },
    { path: 'cards.scheduling', disposition: 'preserved', count: workspace.cards.length, detail: 'Current queue, due value, interval, ease/FSRS memory, repetitions, lapses, suspension, bury state, flags, and deck ownership are written.', requiresAcceptance: false },
    { path: 'reviews.effectiveHistory', disposition: 'preserved', count: workspace.reviews.filter((value) => value.kind !== 'reversal' && value.kind !== 'preview').length, detail: 'Effective scheduled review history is written; preview practice and reviews canceled by an append-only reversal are omitted.', requiresAcceptance: false },
    { path: 'media', disposition: 'preserved', count: workspace.media.length, detail: 'Every referenced media blob is hash-verified before package creation.', requiresAcceptance: false },
  ]
  const add = (path: string, disposition: 'transformed' | 'unsupported' | 'refused', count: number, detail: string, requiresAcceptance = true) => {
    if (count) records.push({ path, disposition, count, detail, requiresAcceptance })
  }
  add('profiles', 'transformed', Math.max(0, workspace.profiles.length - 1), `${target.toUpperCase()} has one collection namespace. Multiple Neo profiles are combined while their deck and entity identities remain distinct.`)
  add('cards.filteredDeckMembership', 'transformed', workspace.cards.filter((value) => value.filteredDeck).length, 'Filtered-deck membership is temporary Anki state. Cards retain current scheduling and original-deck metadata, but exact filtered-deck search/order behavior is not recreated.')
  add('reviews.reversals', 'transformed', workspace.reviews.filter((value) => value.kind === 'reversal').length, 'Neo append-only reversal events become an effective Anki revlog with the canceled review removed.')
  add('extensions.records', 'unsupported', workspace.extensionRecords.length, 'Neo extension metadata has no Anki representation and remains in the Neo backup/checkpoint.')
  add('client.goals', 'unsupported', document.clientState.goals.length, 'Neo learning goals have no Anki package representation.')
  add('client.savedViews', 'unsupported', document.clientState.views.length, 'Neo saved Library views are not Anki browser saved searches.')
  add('client.packs', 'unsupported', document.clientState.packs.length + document.clientState.packConflicts.length, 'Neo pack provenance and conflict state have no Anki representation.')
  add('client.trash', 'unsupported', document.clientState.trash.length, 'Neo Trash recovery metadata is not included; only the live collection graph is exported.')
  add('source.opaqueMetadata', 'unsupported', workspace.sourceEnvelopes.length, 'Opaque source/add-on metadata remains inert in Neo checkpoints; only fields understood by the Anki schema are written into the interoperable package.')
  return records
}

const decodeMediaPayload = (payload: MediaAsset) => {
  const match = /^data:[^,]*,(.*)$/s.exec(payload.dataUrl || '')
  if (!match) return undefined
  try { return payload.dataUrl?.includes(';base64,') ? Uint8Array.from(atob(match[1]), (value) => value.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(match[1])) }
  catch { return undefined }
}

const prepareAnkiExport = async (input: WorkspaceDocumentV4, mediaPayloads: MediaAsset[], target: 'apkg' | 'colpkg') => {
  const document = createWorkspaceDocumentV4(input.workspace, input.clientState)
  const fidelity = exportFidelity(document, target)
  const payloadById = new Map(mediaPayloads.map((value) => [value.id, value]))
  const decodedMedia = new Map<string, Uint8Array>()
  const refused: string[] = []
  for (const asset of document.workspace.media) {
    const payload = payloadById.get(asset.id)
    const bytes = payload && decodeMediaPayload(payload)
    if (!bytes) { refused.push(`${asset.filename}: media bytes are unavailable or malformed`); continue }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('')
    if (digest !== asset.sha256) { refused.push(`${asset.filename}: expected ${asset.sha256}, received ${digest}`); continue }
    decodedMedia.set(asset.id, bytes)
  }
  if (refused.length) fidelity.push({ path: 'media.integrity', disposition: 'refused', count: refused.length, detail: `Export stopped because media would be lost or corrupted: ${refused.join('; ')}`, requiresAcceptance: false })
  const report: ExportCompatibilityReport & { counts: Record<string, number>; warnings: string[] } = {
    target,
    targetAnkiVersion: '25.9.4',
    fidelity,
    canExport: refused.length === 0,
    counts: {
      profiles: document.workspace.profiles.length,
      noteTypes: document.workspace.noteTypes.length,
      notes: document.workspace.notes.length,
      cards: document.workspace.cards.length,
      reviews: document.workspace.reviews.filter((review) => review.kind !== 'reversal' && review.kind !== 'preview' && !document.workspace.reviews.some((candidate) => candidate.kind === 'reversal' && candidate.reversesReviewId === review.id)).length,
      media: decodedMedia.size,
    },
    warnings: fidelity.filter((record) => record.requiresAcceptance).map((record) => `${record.path}: ${record.detail}`),
  }
  return { document, decodedMedia, report }
}

export const buildAnkiExportCompatibilityReport = async (input: WorkspaceDocumentV4, mediaPayloads: MediaAsset[], target: 'apkg' | 'colpkg') => (await prepareAnkiExport(input, mediaPayloads, target)).report

/** Export a Workspace v4 graph as a conservative schema-11 package accepted by current and legacy Anki. */
export const exportAnkiWorkspaceV4 = async (input: WorkspaceDocumentV4, mediaPayloads: MediaAsset[], target: 'apkg' | 'colpkg', locateWasm: () => string = () => wasmUrl): Promise<AnkiExportV4Result> => {
  const prepared = await prepareAnkiExport(input, mediaPayloads, target)
  if (!prepared.report.canExport) throw new Error(prepared.report.fidelity.find((record) => record.disposition === 'refused')?.detail || 'Anki export failed compatibility preflight.')
  const { document, decodedMedia, report } = prepared
  const workspace = document.workspace
  const SQL = await initSqlJs({ locateFile: locateWasm })
  const database = new SQL.Database()
  database.run(`CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL, dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL, dconf text NOT NULL, tags text NOT NULL);
    CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL, reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL, ivl integer NOT NULL, lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
    CREATE TABLE graves (usn integer NOT NULL, oid integer NOT NULL, type integer NOT NULL);
    CREATE INDEX ix_notes_usn ON notes (usn); CREATE INDEX ix_cards_usn ON cards (usn); CREATE INDEX ix_revlog_usn ON revlog (usn); CREATE INDEX ix_cards_nid ON cards (nid); CREATE INDEX ix_cards_sched ON cards (did, queue, due); CREATE INDEX ix_revlog_cid ON revlog (cid); CREATE INDEX ix_notes_csum ON notes (csum);`)
  const noteTypeIds = uniqueNumericIds(document, workspace.noteTypes, 1_700_000_000_000)
  const deckIds = uniqueNumericIds(document, workspace.decks, 1_710_000_000_000)
  const presetIds = uniqueNumericIds(document, workspace.presets, 1_720_000_000_000)
  const noteIds = uniqueNumericIds(document, workspace.notes, 1_730_000_000_000)
  const cardIds = uniqueNumericIds(document, workspace.cards, 1_740_000_000_000)
  const reversedReviewIds = new Set(workspace.reviews.filter((value) => value.kind === 'reversal' && value.reversesReviewId).map((value) => value.reversesReviewId!))
  const effectiveReviews = workspace.reviews.filter((value) => value.kind !== 'reversal' && value.kind !== 'preview' && !reversedReviewIds.has(value.id))
  const reviewIds = uniqueNumericIds(document, effectiveReviews, 1_750_000_000_000)
  const fieldsByType = new Map(workspace.noteTypes.map((type) => [type.id, type.fieldIds.map((id) => workspace.fields.find((field) => field.id === id)!).filter(Boolean).sort((a, b) => a.ordinal - b.ordinal)]))
  const templatesByType = new Map(workspace.noteTypes.map((type) => [type.id, type.templateIds.map((id) => workspace.templates.find((template) => template.id === id)!).filter(Boolean).sort((a, b) => a.ordinal - b.ordinal)]))
  const models = Object.fromEntries(workspace.noteTypes.map((type) => {
    const id = noteTypeIds.get(type.id)!
    const legacy = (document.workspace.sourceEnvelopes.find((value) => value.id === type.sourceEnvelopeId)?.opaque.legacy || {}) as Record<string, unknown>
    return [String(id), { ...legacy, id, name: type.name, type: type.kind === 'cloze' ? 1 : 0, mod: unixSeconds(type.updatedAt), usn: -1, sortf: 0, did: null, tmpls: (templatesByType.get(type.id) || []).map((template) => ({ name: template.name, ord: template.ordinal, qfmt: template.questionFormat, afmt: template.answerFormat, bqfmt: template.browserQuestionFormat || '', bafmt: template.browserAnswerFormat || '', did: template.deckOverrideId ? deckIds.get(template.deckOverrideId) || null : null, bfont: '', bsize: 0 })), flds: (fieldsByType.get(type.id) || []).map((field) => ({ name: field.name, ord: field.ordinal, sticky: field.sticky, rtl: field.rtl, font: field.font || 'Arial', size: field.fontSize || 20, media: [] })), css: type.css, latexPre: '', latexPost: '', latexsvg: false, req: [] }]
  }))
  const dconf = Object.fromEntries(workspace.presets.map((preset) => {
    const id = presetIds.get(preset.id)!
    return [String(id), { id, name: preset.name, mod: unixSeconds(preset.updatedAt), usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true, new: { delays: preset.learningStepsMinutes, ints: [1, 4], initialFactor: 2500, order: 1, perDay: preset.newCardsPerDay, bury: preset.buryNewSiblings }, lapse: { delays: preset.relearningStepsMinutes, mult: 0, minInt: 1, leechFails: preset.leechThreshold, leechAction: preset.leechAction === 'suspend' ? 0 : 1 }, rev: { perDay: preset.reviewsPerDay, ease4: 1.3, fuzz: .05, ivlFct: 1, maxIvl: preset.maximumIntervalDays, hardFactor: 1.2, bury: preset.buryReviewSiblings }, dyn: false, desiredRetention: preset.desiredRetention }]
  }))
  const decks = Object.fromEntries(workspace.decks.map((deck) => {
    const id = deckIds.get(deck.id)!
    return [String(id), { id, name: deck.name, mod: unixSeconds(deck.updatedAt), usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], desc: '', dyn: 0, collapsed: false, browserCollapsed: false, conf: presetIds.get(deck.presetId) || Number(Object.keys(dconf)[0]) || 1, extendNew: 0, extendRev: 0, reviewLimit: null, newLimit: null, reviewLimitToday: null, newLimitToday: null, desiredRetention: null }]
  }))
  const collectionCreated = Math.floor(new Date(workspace.createdAt).setUTCHours(0, 0, 0, 0) / 1000)
  const nowSeconds = Math.floor(Date.now() / 1000)
  database.run('INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [1, collectionCreated, nowSeconds * 1000, nowSeconds * 1000, 11, 0, -1, 0, JSON.stringify({ schedVer: 2, activeDecks: [1], curDeck: 1 }), JSON.stringify(models), JSON.stringify(decks), JSON.stringify(dconf), '{}'])
  for (const note of workspace.notes) {
    const typeFields = fieldsByType.get(note.noteTypeId) || []
    const values = typeFields.map((field) => note.fields[field.id] || '')
    const row = sourceRow(document, note.sourceEnvelopeId)
    database.run('INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [noteIds.get(note.id)!, String(row.guid || `neo${noteIds.get(note.id)!.toString(36)}`), noteTypeIds.get(note.noteTypeId)!, unixSeconds(note.updatedAt), Number(row.usn ?? -1), ` ${note.tags.join(' ')} `, values.join('\u001f'), values[0] || '', await sha1Checksum(values[0] || ''), Number(row.flags || 0), String(row.data || '')])
  }
  const noteById = new Map(workspace.notes.map((value) => [value.id, value]))
  const warnings: string[] = []
  for (const card of workspace.cards) {
    const row = sourceRow(document, card.sourceEnvelopeId)
    let type = 0; let queue = 0; let due = 0; let interval = 0; let factor = 0; let reps = 0; let lapses = 0; let left = 0
    if (card.scheduling.strategy === 'anki') {
      const schedule = card.scheduling; type = schedule.queue === 'new' ? 0 : schedule.queue === 'learn' ? 1 : schedule.queue === 'review' ? 2 : schedule.queue === 'relearn' ? 3 : 4
      queue = card.suspended ? -1 : card.buriedUntil ? card.buriedBy === 'user' ? -3 : -2 : type === 3 ? 3 : type === 4 ? 4 : type
      due = schedule.due; interval = schedule.intervalDays; factor = schedule.easeFactor; reps = schedule.repetitions; lapses = schedule.lapses; left = schedule.remainingSteps
    } else {
      const schedule = card.scheduling; type = schedule.reps ? 2 : 0; queue = card.suspended ? -1 : card.buriedUntil ? card.buriedBy === 'user' ? -3 : -2 : type
      due = type === 2 ? Math.max(0, Math.floor((new Date(schedule.dueAt).getTime() / 1000 - collectionCreated) / 86400)) : Number(cardIds.get(card.id)! % 1_000_000_000)
      interval = schedule.scheduledDays; factor = Math.round(2500 + (5 - schedule.difficulty) * 100); reps = schedule.reps; lapses = schedule.lapses
    }
    const note = noteById.get(card.noteId)!
    const odid = card.filteredDeck ? deckIds.get(card.filteredDeck.originalDeckId) || 0 : card.scheduling.strategy === 'anki' && card.scheduling.originalDeckId ? deckIds.get(card.scheduling.originalDeckId) || 0 : 0
    const odue = card.filteredDeck?.originalDue || (card.scheduling.strategy === 'anki' ? card.scheduling.originalDue || 0 : 0)
    let cardData: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(String(row.data || '{}')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cardData = parsed as Record<string, unknown>
    } catch { warnings.push(`Card ${card.id} contained malformed inert source metadata; known scheduling state was exported without that malformed value.`) }
    const schedule = card.scheduling
    if (schedule.strategy === 'anki') {
      if (schedule.stability !== undefined) cardData.s = schedule.stability
      if (schedule.difficulty !== undefined) cardData.d = schedule.difficulty
      if (schedule.desiredRetention !== undefined) cardData.dr = schedule.desiredRetention
      if (schedule.decay !== undefined) cardData.decay = schedule.decay
      if (schedule.lastReviewAt) cardData.lrt = unixSeconds(schedule.lastReviewAt)
    } else {
      cardData.s = schedule.stability
      cardData.d = schedule.difficulty
      cardData.dr = workspace.presets.find((value) => value.id === card.presetId)?.desiredRetention || .9
      if (schedule.lastReviewAt) cardData.lrt = unixSeconds(schedule.lastReviewAt)
    }
    database.run('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [cardIds.get(card.id)!, noteIds.get(note.id)!, deckIds.get(card.deckId)!, card.ordinal, unixSeconds(card.updatedAt), Number(row.usn ?? -1), type, queue, due, interval, factor, reps, lapses, left, odue, odid, card.flags, JSON.stringify(cardData)])
  }
  for (const review of effectiveReviews) {
    const row = sourceRow(document, review.sourceEnvelopeId)
    database.run('INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [reviewIds.get(review.id)!, cardIds.get(review.cardId)!, Number(row.usn ?? -1), review.rating, review.intervalAfter, review.intervalBefore, review.easeFactor || Number(row.factor || 0), review.durationMilliseconds, Number(row.type || 1)])
  }
  const collection = database.export(); database.close()
  const zipEntries: Record<string, Uint8Array> = { 'collection.anki2': collection }
  const mediaMap: Record<string, string> = {}
  workspace.media.forEach((asset, index) => {
    zipEntries[String(index)] = decodedMedia.get(asset.id)!
    mediaMap[String(index)] = asset.filename
  })
  zipEntries.media = strToU8(JSON.stringify(mediaMap))
  return { bytes: zipSync(zipEntries, { level: 6 }), report: { ...report, warnings: [...report.warnings, ...warnings] } }
}
