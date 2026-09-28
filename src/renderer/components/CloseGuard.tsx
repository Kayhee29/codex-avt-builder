/**
 * The window half of the close guard (plan Task 5.6, spec sections 4.6 and 10).
 *
 * The dialog that stops a close while Codex is running belongs to the main
 * process (`src/main/close-guard.ts`), because only it knows what is running
 * and only it can hold the close back. This component does the two things the
 * renderer owns:
 *
 * - it says, while a run is in flight, that closing now would cancel it, so
 *   the dialog is never the first the user hears of it (spec section 10);
 * - it writes the draft out when the window is going away, so the autosave
 *   window of spec section 4.6 cannot swallow the last few keystrokes.
 *
 * The flush is best effort. `beforeunload` cannot await anything, and a draft
 * that does not reach the disk is a lost autosave rather than a lost job.
 */
import { useEffect, type JSX } from 'react'

import { vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'
import { selectIsRunning, useJobsStore } from '../store/jobs.ts'

export function CloseGuard(): JSX.Element | null {
  const running = useJobsStore(selectIsRunning)
  const flushAutosave = useBuilderStore((store) => store.flushAutosave)

  useEffect(() => {
    const flush = (): void => {
      void flushAutosave()
    }

    window.addEventListener('beforeunload', flush)

    return (): void => {
      window.removeEventListener('beforeunload', flush)
    }
  }, [flushAutosave])

  if (!running) {
    return null
  }

  return (
    <p className="close-guard" role="status">
      {vi.closeGuard.running}
    </p>
  )
}
