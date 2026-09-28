/**
 * The live run panel (plan Task 5.5, spec sections 5.5 and 12).
 *
 * It shows the run state and the `activity` line that came with it, and nothing
 * else: the state is whatever the main process last said it was, never inferred
 * from an event name, and `activity` is display text that must never decide
 * anything (spec section 12).
 *
 * Cancel follows plan decision Q20 and spec section 5.5: allowed from `queued`,
 * `preflight` and `running`, refused from `verifying` — where the run has
 * already ended — and from every terminal state. A job that has just been
 * accepted but has not reported yet is cancellable too, because preflight alone
 * can take twenty seconds and that window belongs to the user.
 *
 * When no run is in flight the panel keeps showing the last one this session
 * saw, so its outcome does not vanish the moment it finishes.
 */
import type { JSX } from 'react'

import { ipcErrorText, RUN_STATE_TEXT, vi } from '../i18n/vi.ts'
import { selectCanCancel, selectDisplayProgress, useJobsStore } from '../store/jobs.ts'

export function RunProgress(): JSX.Element {
  const progress = useJobsStore(selectDisplayProgress)
  const activeJobId = useJobsStore((store) => store.activeJobId)
  const canCancel = useJobsStore(selectCanCancel)
  const actionErrorCode = useJobsStore((store) => store.actionErrorCode)
  const cancel = useJobsStore((store) => store.cancel)

  if (progress === null && activeJobId === null) {
    return <p className="run run--idle">{vi.generate.idle}</p>
  }

  const jobId = activeJobId ?? progress?.jobId ?? ''

  return (
    <section className="run" aria-label={vi.layout.generate} data-state={progress?.state ?? ''}>
      <p className="run__job">
        {vi.generate.jobLabel}: {jobId}
      </p>

      <p className="run__state">{progress === null ? '' : RUN_STATE_TEXT[progress.state]}</p>

      {progress?.activity === undefined ? null : (
        <p className="run__activity">
          {vi.generate.activity}: {progress.activity}
        </p>
      )}

      <button
        type="button"
        disabled={!canCancel}
        onClick={(): void => {
          if (activeJobId !== null) {
            void cancel(activeJobId)
          }
        }}
      >
        {vi.generate.cancel}
      </button>

      {actionErrorCode === null ? null : (
        <p className="run__error" role="alert">
          {vi.generate.cancelFailed} {ipcErrorText(actionErrorCode)}
        </p>
      )}
    </section>
  )
}
