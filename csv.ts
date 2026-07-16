import type { ImportSummary, KnowledgeItem, PracticeCard, PromptVariant } from '../../types'
import { makeEmptyFSRSCard } from '../../lib/fsrs'

const parseRows = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1 } else quoted = !quoted
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1
      row.push(cell); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell)
  if (row.some(Boolean)) rows.push(row)
  return rows
}

const escapeCell = (value: string) => /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value

export const importCsvText = (text: string): ImportSummary => {
  const rows = parseRows(text)
  if (!rows.length) throw new Error('The CSV file is empty.')
  const headers = rows[0].map((header) => header.trim().toLowerCase())
  const required = ['prompt', 'answer']
  if (required.some((name) => !headers.includes(name))) throw new Error('CSV requires prompt and answer columns.')
  const now = new Date().toISOString()
  const items: KnowledgeItem[] = []
  const cards: PracticeCard[] = []
  const warnings: string[] = []
  for (const [offset, values] of rows.slice(1).entries()) {
    const record = Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() || '']))
    if (!record.prompt || !record.answer) { warnings.push(`Skipped row ${offset + 2}: prompt or answer is empty.`); continue }
    const itemId = crypto.randomUUID()
    const variants = (record.variants || 'forward').split('|').map((variant) => variant.trim()).filter(Boolean)
    items.push({
      id: itemId, prompt: record.prompt, answer: record.answer, context: record.context || '', collection: record.collection || 'Imported',
      tags: (record.tags || '').split('|').map((tag) => tag.trim()).filter(Boolean),
      citations: record.source ? [{ id: crypto.randomUUID(), title: record.source, url: record.source }] : [],
      mediaIds: [], occlusions: [], createdAt: now, updatedAt: now,
    })
    for (const variant of variants.length ? variants : ['forward'] as PromptVariant[]) cards.push({
      id: crypto.randomUUID(), itemId, variant, suspended: false, fsrs: makeEmptyFSRSCard(new Date(now)),
      estimatedSeconds: variant === 'typed' ? 20 : 14, createdAt: now, updatedAt: now,
    })
  }
  return { source: 'csv', items, cards, assets: [], warnings }
}

export const exportCsv = (items: KnowledgeItem[], cards: PracticeCard[]) => {
  const headers = ['prompt', 'answer', 'context', 'collection', 'tags', 'source', 'variants']
  const rows = items.map((item) => [
    item.prompt, item.answer, item.context, item.collection, item.tags.join('|'), item.citations[0]?.url || item.citations[0]?.title || '',
    cards.filter((card) => card.itemId === item.id).map((card) => card.variant).join('|'),
  ])
  return [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n')
}
