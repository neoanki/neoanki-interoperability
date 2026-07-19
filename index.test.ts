import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelActiveAnkiImport, importAnkiInWorker } from './index'

class PendingWorker {
  static instances: PendingWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  terminated = false
  constructor() { PendingWorker.instances.push(this) }
  postMessage() {}
  terminate() { this.terminated = true }
}

describe('Anki import worker lifecycle', () => {
  afterEach(() => { cancelActiveAnkiImport(); PendingWorker.instances = []; vi.unstubAllGlobals() })

  it('rejects promptly when a running import is cancelled', async () => {
    vi.stubGlobal('Worker', PendingWorker)
    const progress = vi.fn()
    const pending = importAnkiInWorker(new File([new Uint8Array([1, 2, 3])], 'collection.apkg'), progress)
    const worker = PendingWorker.instances[0]
    expect(worker).toBeDefined()
    worker?.onmessage?.({ data: { type: 'progress', message: 'Extracting…' } } as MessageEvent)
    expect(progress).toHaveBeenCalledWith('Extracting…')
    expect(worker?.terminated).toBe(false)
    cancelActiveAnkiImport()
    await expect(pending).rejects.toThrow('Import canceled')
    expect(worker?.terminated).toBe(true)
  })

  it('cancels the previous worker when a replacement import starts', async () => {
    vi.stubGlobal('Worker', PendingWorker)
    const first = importAnkiInWorker(new File([new Uint8Array([1])], 'first.apkg'))
    const second = importAnkiInWorker(new File([new Uint8Array([2])], 'second.apkg'))
    await expect(first).rejects.toThrow('Import canceled')
    expect(PendingWorker.instances[0]?.terminated).toBe(true)
    cancelActiveAnkiImport()
    await expect(second).rejects.toThrow('Import canceled')
  })
})
