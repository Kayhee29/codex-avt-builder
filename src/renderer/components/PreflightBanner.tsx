/**
 * The preflight banner (plan Task 5.5, spec section 5.3).
 *
 * The version and login checks run once when the window opens and their result
 * is cached for the session by the main process, so this asks for it rather
 * than repeating it; `Kiểm tra lại` is the `force` of plan decision Q7.
 *
 * Preflight never runs `codex exec` and never spends a generation (spec section
 * 5.3), so showing it on startup costs nothing and answers the question every
 * failure mode of spec section 7.4 otherwise raises only at Generate time.
 *
 * The executable field is the single exception to "the renderer never sends a
 * path" (spec sections 8 and 11, plan decision Q7): it is the user's own
 * override for the resolved Codex binary. Main still resolves it, and on
 * Windows still refuses anything that is not a real `.exe`.
 *
 * The state is local. There is nothing else in the app that reads a preflight
 * result, and spec section 12 forbids a shared loading flag.
 */
import { useEffect, useState, type ChangeEvent, type JSX } from 'react'

import type { IpcErrorCode, IpcResult, PreflightResult } from '@shared/ipc-contract'

import { bridge } from '../bridge.ts'
import { ipcErrorText, vi } from '../i18n/vi.ts'

export function PreflightBanner(): JSX.Element {
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  const [executable, setExecutable] = useState('')
  // The first check starts with the component, so it starts busy.
  const [busy, setBusy] = useState(true)
  const [errorCode, setErrorCode] = useState<IpcErrorCode | null>(null)

  /**
   * Records what a `system.preflight` answer said.
   *
   * It is only ever called from a promise callback, never straight out of an
   * effect body: an effect may subscribe to something outside React and set
   * state when that answers, and this app's bridge is exactly such a thing.
   */
  function applyPreflight(answer: IpcResult<{ preflight: PreflightResult }>): void {
    setBusy(false)

    if (!answer.ok) {
      setErrorCode(answer.code)

      return
    }

    setErrorCode(null)
    setPreflight(answer.data.preflight)
  }

  useEffect(() => {
    void bridge()
      ['system.preflight']({})
      .then((answer) => {
        setBusy(false)

        if (answer.ok) {
          setPreflight(answer.data.preflight)
        } else {
          setErrorCode(answer.code)
        }
      })
  }, [])

  useEffect(() => {
    void bridge()
      ['system.getSettings']()
      .then((answer) => {
        if (answer.ok) {
          setExecutable(answer.data.settings.codexExecutable ?? '')
        }
      })
  }, [])

  async function saveExecutable(): Promise<void> {
    const trimmed = executable.trim()
    const answer = await bridge()['system.setSettings']({
      patch: { codexExecutable: trimmed === '' ? null : trimmed }
    })

    setBusy(false)

    if (!answer.ok) {
      setErrorCode(answer.code)

      return
    }

    // The cached result was built from the previous path (plan decision Q7).
    applyPreflight(await bridge()['system.preflight']({ force: true }))
  }

  const ok = preflight?.ok === true

  return (
    <section className={ok ? 'preflight preflight--ok' : 'preflight'} aria-label={vi.layout.codex}>
      <p className="preflight__line">
        {preflight === null
          ? busy
            ? vi.preflight.checking
            : errorCode === null
              ? vi.preflight.failed
              : ipcErrorText(errorCode)
          : preflight.ok
            ? `${vi.preflight.ok} ${vi.preflight.version} ${preflight.version}`
            : `${ipcErrorText(preflight.code)} ${preflight.message}`}
      </p>

      {preflight?.ok === true ? (
        <p className="preflight__path">
          {vi.preflight.executable}: {preflight.executable}
        </p>
      ) : null}

      {errorCode === null || preflight === null ? null : (
        <p className="preflight__line" role="alert">
          {vi.preflight.saveFailed} {ipcErrorText(errorCode)}
        </p>
      )}

      <div className="preflight__settings">
        <div className="field">
          <label className="field__label" htmlFor="codex-executable">
            {vi.preflight.executableLabel}
          </label>
          <input
            id="codex-executable"
            type="text"
            value={executable}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setExecutable(event.target.value)
            }}
          />
          <span className="field__hint">{vi.preflight.executableHint}</span>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={(): void => {
            setBusy(true)
            void saveExecutable()
          }}
        >
          {vi.preflight.save}
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={(): void => {
            setBusy(true)
            void bridge()['system.preflight']({ force: true }).then(applyPreflight)
          }}
        >
          {vi.preflight.recheck}
        </button>
      </div>
    </section>
  )
}
