import { createSandboxedUiClient } from '@neo-anki/extension-sdk'
import { onPrimaryColor } from './appearance.js'

const css = `
  :root { color-scheme: light dark; font: var(--neo-font-size, 16px) / var(--neo-line-height, 1.5) var(--neo-font-family, Inter, ui-sans-serif, system-ui, sans-serif); }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--neo-text, #282622); background: transparent; }
  .panel { display: grid; gap: 14px; padding: 16px; border: 1px solid var(--neo-border, #d7d2c8); border-radius: var(--neo-radius-lg, 12px); background: var(--neo-surface, #fbfaf7); }
  .hint { max-width: 66ch; margin: 0; color: var(--neo-text-soft, #69655d); }
  button, input { font: inherit; color: inherit; }
  button { min-height: 44px; padding: 9px 14px; border: 1px solid var(--neo-border-strong, #aaa49a); border-radius: var(--neo-radius-md, 9px); background: var(--neo-surface-strong, #fff); font-weight: 700; cursor: pointer; }
  button:hover { border-color: var(--neo-primary, #6246a5); }
  button.primary { border-color: var(--neo-primary, #6246a5); background: var(--neo-primary, #6246a5); color: ${onPrimaryColor}; }
  button.primary:hover { background: var(--neo-primary-hover, #52388f); }
  input[type=file] { width: 100%; min-height: 44px; padding: 8px; border: 1px solid var(--neo-border-strong, #aaa49a); border-radius: var(--neo-radius-md, 9px); background: var(--neo-surface-strong, #fff); }
  input[type=file]::file-selector-button { min-height: 36px; margin-right: 10px; padding: 6px 10px; border: 1px solid var(--neo-border-strong, #aaa49a); border-radius: var(--neo-radius-sm, 6px); background: var(--neo-surface-muted, #f0ede6); color: var(--neo-text, #282622); font: inherit; font-weight: 700; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 3px solid var(--neo-focus, #7866b2); outline-offset: 2px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .report { padding: 12px; border: 1px solid var(--neo-border, #d7d2c8); border-radius: var(--neo-radius-md, 9px); background: var(--neo-surface-muted, #f0ede6); white-space: pre-wrap; }
  .activity { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--neo-border, #d7d2c8); border-radius: var(--neo-radius-md, 9px); background: var(--neo-surface-muted, #f0ede6); }
  .activity[hidden] { display: none; }
  .activity progress { width: 100%; accent-color: var(--neo-primary, #6246a5); }
  .activity small { color: var(--neo-text-soft, #69655d); font-variant-numeric: tabular-nums; }
  .status { min-height: 24px; margin: 0; color: var(--neo-text-soft, #69655d); }
  .status[role=alert] { color: var(--neo-danger, #a84343); }
  button:disabled, input:disabled { cursor: not-allowed; opacity: .55; }
  @media (max-width: 520px) { .actions { align-items: stretch; flex-direction: column; } .actions button { width: 100%; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; } }
`

void createSandboxedUiClient().then((client) => {
  document.documentElement.dataset.theme = client.init.theme
  const initial = client.init.dto as { mode?: string; dailyMinutes?: number }
  const root = document.getElementById('root')!
  const style = document.createElement('style')
  style.textContent = css
  document.head.append(style)

  const panel = document.createElement('section')
  panel.className = 'panel'
  const copy = document.createElement('p')
  copy.className = 'hint'
  copy.textContent = 'Choose a file to preview its contents and compatibility details. Neo Anki creates a rollback checkpoint before importing.'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.apkg,.colpkg,.csv'
  input.setAttribute('aria-label', 'Choose Anki or CSV file')
  const report = document.createElement('div')
  report.className = 'report'
  report.hidden = true
  const activity = document.createElement('div')
  activity.className = 'activity'
  activity.hidden = true
  activity.setAttribute('aria-label', 'Import activity')
  const activityProgress = document.createElement('progress')
  const activityDetail = document.createElement('small')
  activity.append(activityProgress, activityDetail)
  const status = document.createElement('p')
  status.className = 'status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const setStatus = (message: string, error = false) => {
    status.setAttribute('role', error ? 'alert' : 'status')
    status.textContent = message
  }
  let token = ''
  let previewInventory: Record<string, number> = {}
  let activityTimer = 0
  const actionButtons: HTMLButtonElement[] = []
  const formatBytes = (bytes: number) => new Intl.NumberFormat(undefined, { style: 'unit', unit: bytes >= 1024 ** 3 ? 'gigabyte' : 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 }).format(bytes / (bytes >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2))
  const formatElapsed = (milliseconds: number) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s elapsed` : `${seconds}s elapsed`
  }
  const setBusy = (busy: boolean) => {
    input.disabled = busy
    commit.disabled = busy
    actionButtons.forEach((button) => { button.disabled = busy })
  }
  const startActivity = (detail: string) => {
    window.clearInterval(activityTimer)
    const startedAt = Date.now()
    activity.hidden = false
    activityProgress.removeAttribute('value')
    activityDetail.textContent = `${detail} · ${formatElapsed(0)}`
    activityTimer = window.setInterval(() => { activityDetail.textContent = `${detail} · ${formatElapsed(Date.now() - startedAt)}` }, 1_000)
    setBusy(true)
  }
  const stopActivity = () => {
    window.clearInterval(activityTimer)
    activity.hidden = true
    setBusy(false)
  }

  const commit = document.createElement('button')
  commit.type = 'button'
  commit.className = 'primary'
  commit.textContent = 'Import this file'
  commit.hidden = true
  commit.onclick = async () => {
    if (!token) return
    const counts = [previewInventory.notes ? `${previewInventory.notes.toLocaleString()} notes` : '', previewInventory.cards ? `${previewInventory.cards.toLocaleString()} cards` : '', previewInventory.media ? `${previewInventory.media.toLocaleString()} media files` : ''].filter(Boolean).join(', ')
    setStatus('Creating a rollback checkpoint, verifying media, and saving the imported collection. Large imports can take several minutes…')
    startActivity(`Importing${counts ? ` ${counts}` : ' the inspected collection'}. Keep Neo Anki open`)
    try {
      await client.call('command', { commandId: 'interop.commit', payload: { token, onboarding: initial.mode === 'onboarding', dailyMinutes: initial.dailyMinutes } })
      setStatus('Import complete. Review your collection before deleting any original files.')
      commit.hidden = true
    } catch (error) {
      token = ''
      commit.hidden = true
      input.value = ''
      setStatus(`${error instanceof Error ? error.message : 'Import failed.'} Choose the file again to retry; the previous workspace remains available.`, true)
    } finally {
      stopActivity()
    }
  }

  input.onchange = async () => {
    const file = input.files?.[0]
    if (!file) return
    token = ''
    previewInventory = {}
    setStatus(`Reading and checking ${file.name} (${formatBytes(file.size)}). Large packages can take several minutes…`)
    startActivity('Reading, validating, and unpacking locally')
    report.hidden = true
    commit.hidden = true
    try {
      const result = await client.call<{ token: string; filename: string; preflight: { inventory?: Record<string, number>; warnings?: string[]; fidelity?: Array<{ path?: string; status?: string; detail?: string }> } }>('command', { commandId: 'interop.inspect', payload: file })
      token = result.token
      previewInventory = result.preflight.inventory || {}
      const counts = Object.entries(result.preflight.inventory || {}).map(([name, count]) => `${count} ${name}`).join(', ')
      const fidelity = (result.preflight.fidelity || []).map((entry) => [entry.path, entry.status, entry.detail].filter(Boolean).join(' — ')).join('\n')
      report.textContent = `${result.filename}: ${counts}.${fidelity ? `\n\nCompatibility details:\n${fidelity}` : ''}${result.preflight.warnings?.length ? `\n\nWarnings:\n${result.preflight.warnings.join('\n')}` : ''}`
      report.hidden = false
      commit.hidden = false
      setStatus('Preview ready. Review the details, then import when you are satisfied.')
    } catch (error) {
      input.value = ''
      setStatus(`${error instanceof Error ? error.message : 'Could not read this file.'} Choose the file again to retry.`, true)
    } finally {
      stopActivity()
    }
  }

  const actions = document.createElement('div')
  actions.className = 'actions'
  for (const [kind, label] of [['apkg', 'Export .apkg'], ['colpkg', 'Export .colpkg'], ['csv', 'Export CSV']] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    actionButtons.push(button)
    button.onclick = async () => {
      setStatus(`Preparing ${label}…`)
      try {
        const value = await client.call<{ filename: string; mimeType: string; text?: string; bytes?: Uint8Array }>('command', { commandId: 'interop.export', payload: kind })
        const saved = await client.call<{ canceled: boolean }>('files.save', value)
        setStatus(saved.canceled ? 'Export canceled.' : `${value.filename} was saved.`)
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Export failed.', true)
      }
    }
    actions.append(button)
  }

  panel.append(copy, input, activity, report, commit, actions, status)
  root.append(panel)
  client.reportHeight()
})
