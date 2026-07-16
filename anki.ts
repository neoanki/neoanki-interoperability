import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url'
import { unzipSync } from 'fflate'
import { decompress } from 'fzstd'
import type { ImportSummary, KnowledgeItem, MediaAsset, PracticeCard, PromptVariant } from '../../types'
import { makeEmptyFSRSCard } from '../../lib/fsrs'
import { createAssetFromBytes } from '../../lib/media'

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
  while (index < bytes.length && shift < 35) {
    const byte = bytes[index]
    index += 1
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return { value, index }
    shift += 7
  }
  throw new Error('Invalid Anki media metadata.')
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

export const importAnkiPackage = async (buffer: ArrayBuffer, locateWasm: () => string = () => wasmUrl): Promise<ImportSummary> => {
  const archive = unzipSync(new Uint8Array(buffer))
  const modernEntry = archive['collection.anki21b']
  const databaseEntry = modernEntry ? decompress(modernEntry) : archive['collection.anki21'] || archive['collection.anki2']
  if (!databaseEntry) {
    throw new Error('No supported Anki collection database was found in this package.')
  }
  const SQL = await initSqlJs({ locateFile: locateWasm })
  const database = new SQL.Database(databaseEntry)
  try {
    const normalizedSchema = tableRows(database, "SELECT name FROM sqlite_master WHERE type='table' AND name='decks'").length > 0
    const col = normalizedSchema ? undefined : tableRows(database, 'SELECT decks, models FROM col LIMIT 1')[0]
    const decks = normalizedSchema
      ? Object.fromEntries(tableRows(database, 'SELECT id, name FROM decks').map((deck) => [fieldText(deck.id), { name: fieldText(deck.name) }]))
      : JSON.parse(fieldText(col?.decks) || '{}') as Record<string, { name?: string }>
    const models = normalizedSchema ? {} : JSON.parse(fieldText(col?.models) || '{}') as Record<string, { tmpls?: Array<{ ord?: number; name?: string; qfmt?: string }> }>
    const rawNotes = tableRows(database, 'SELECT id, guid, mid, tags, flds FROM notes')
    const rawCards = tableRows(database, 'SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps FROM cards')
    const mediaMap: Record<string, string> = archive.media
      ? modernEntry
        ? Object.fromEntries(decodeModernMediaNames(decompress(archive.media)).map((name, index) => [String(index), name]))
        : JSON.parse(decode(archive.media)) as Record<string, string>
      : {}
    const assets: MediaAsset[] = []
    const assetByFilename = new Map<string, string>()
    for (const [entry, filename] of Object.entries(mediaMap)) {
      const bytes = archive[entry]
      if (!bytes) continue
      const asset = await createAssetFromBytes(filename, modernEntry ? decompress(bytes) : bytes)
      assets.push(asset)
      assetByFilename.set(filename, asset.id)
    }
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
      return [{ id: `anki-card-${fieldText(legacy.id)}`, itemId: item.id, variant, suspended: Number(legacy.queue) < 0, fsrs, estimatedSeconds: variant === 'typed' ? 20 : 14, createdAt: now, updatedAt: now }]
    })
    warnings.unshift('Imported content, decks, tags, prompt direction, suspension, and media. Neo Anki will schedule future reviews with FSRS; legacy interval history is not copied losslessly.')
    return { source: 'anki', items, cards, assets, warnings }
  } finally { database.close() }
}
