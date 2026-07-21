import { describe, expect, it } from 'vitest'
import { exportCsvWorkspace, importCsvWorkspace } from './csv-v4.js'

describe('CSV interoperability', () => {
  it('imports quoted cells into a v4 workspace and exports them reproducibly', () => {
    const document = importCsvWorkspace('prompt,answer,tags\n"Why, exactly?","Because ""retrieval"" works",science|memory', 'research.csv')

    expect(document.workspace.profiles[0].name).toBe('research')
    expect(document.workspace.notes).toHaveLength(1)
    expect(document.workspace.cards).toHaveLength(1)
    expect(document.workspace.notes[0].tags).toEqual(['science', 'memory'])
    expect(exportCsvWorkspace(document)).toContain('"Why, exactly?","Because ""retrieval"" works"')
  })

  it('rejects a CSV without the required columns', () => {
    expect(() => importCsvWorkspace('term,definition\nA,B', 'bad.csv')).toThrow('prompt and answer')
  })
})
