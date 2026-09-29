/**
 * The Generate button (plan Task 5.5, spec sections 5.1 and 5.2).
 *
 * Generate is the one action in the whole builder that runs Codex (spec section
 * 5.1). What it sends is the builder state plus the checksum of the prompt the
 * preview showed, which main rebuilds and compares before it will materialize
 * anything (spec section 10).
 *
 * When the button is enabled, plan decision Q24: the state is valid, no
 * reference has gone missing, and no run is in flight. It deliberately does not
 * wait for `status === 'ready'`, because that would also wait out the 800 ms
 * autosave window after every keystroke — the save is not what makes a job
 * runnable. A request already in flight counts as a run in flight, so the
 * button cannot be pressed twice into the same job.
 *
 * The draft is flushed first, so what is on disk matches the job that was
 * started (spec section 4.6).
 */
import { useState, type JSX } from 'react'

import { sha256Hex } from '@shared/prompt-builder'

import { ipcErrorText, vi } from '../i18n/vi.ts'
import {
  selectCanGenerate,
  selectMissingRequiredFields,
  selectMissingRoles,
  toBuilderStateInput,
  useBuilderStore
} from '../store/builder.ts'
import { selectIsRunning, useJobsStore } from '../store/jobs.ts'

import { RunProgress } from './RunProgress.tsx'

export function GenerateBar(): JSX.Element {
  const canGenerate = useBuilderStore(selectCanGenerate)
  const flushAutosave = useBuilderStore((store) => store.flushAutosave)

  const running = useJobsStore(selectIsRunning)
  const starting = useJobsStore((store) => store.starting)
  const generateErrorCode = useJobsStore((store) => store.generateErrorCode)

  const [localError, setLocalError] = useState<string | null>(null)

  async function start(): Promise<void> {
    setLocalError(null)

    // The draft the user has been typing into is what the job is made of, so
    // it is written out before the job directory is materialized.
    await flushAutosave()

    const builder = useBuilderStore.getState()
    const prompt = builder.prompt

    if (prompt === null) {
      setLocalError(vi.preview.failed)

      return
    }

    // `promptSha256` is normally already in the store; it is computed here for
    // the window between an edit and its digest landing, so that Q24's three
    // conditions really are the only thing the button waits for.
    let digest = builder.promptSha256

    if (digest === null) {
      try {
        digest = await sha256Hex(prompt.markdown)
      } catch {
        setLocalError(vi.generate.checksumFailed)

        return
      }
    }

    await useJobsStore.getState().generate(toBuilderStateInput(builder.state), digest)
  }

  const blocked = !canGenerate || running || starting

  return (
    <div className="generate">
      <button
        type="button"
        disabled={blocked}
        onClick={(): void => {
          void start()
        }}
      >
        {starting ? vi.generate.starting : vi.generate.button}
      </button>

      {blocked && !starting ? <p className="generate__hint">{blockedReason()}</p> : null}

      {generateErrorCode === null ? null : (
        <p className="generate__error" role="alert">
          {vi.generate.failed} {ipcErrorText(generateErrorCode)}
        </p>
      )}

      {localError === null ? null : (
        <p className="generate__error" role="alert">
          {localError}
        </p>
      )}

      <RunProgress />
    </div>
  )

  /** Why the button is off, in the order the user can act on. */
  function blockedReason(): string {
    if (running) {
      return vi.generate.blockedRunning
    }

    const store = useBuilderStore.getState()

    if (selectMissingRoles(store).length > 0) {
      return vi.reference.missingBlocksGenerate
    }

    const missing = selectMissingRequiredFields(store)

    // Naming the empty fields beats "something required is missing" on a form
    // this long. `blockedInvalid` still covers the rest, which the dropdowns
    // make unreachable from the UI but the store API can still produce.
    return missing.length > 0
      ? `${vi.generate.blockedMissing} ${missing.map((field) => vi.form[field]).join(', ')}.`
      : vi.generate.blockedInvalid
  }
}
