/**
 * Recent jobs (plan Task 5.5, spec sections 4.6, 10 and 12).
 *
 * Every column spec section 4.6 asks for: the output thumbnail when there is
 * one, the job ID, the subject name, the state, the time, the preset and the
 * anchor the job came from, a button that opens the job folder and a button
 * that duplicates it into a new draft. The `warnings` the verifier recorded sit
 * under the thumbnail, which is where the size and format mismatches of spec
 * section 7.3 belong.
 *
 * State comes from `result.json` through `jobs.list` and is never recomputed
 * here (spec section 12). A job with no `result.json` that main is not running
 * is reported as `failed` with `INTERRUPTED`; it is shown as failed, and the
 * code is what explains it.
 *
 * Duplicating reads the job back with `jobs.get`. Its references arrive as
 * handles main minted for the files in that job's `inputs/` — the renderer sees
 * a role, a name and a thumbnail, and never a path (spec section 11, plan
 * decision Q3). A finished job is immutable, so this starts a new draft rather
 * than reopening the old one (spec section 4.6).
 */
import { useState, type JSX } from 'react'

import type { JobSummary } from '@shared/ipc-contract'

import { ipcErrorText, RUN_STATE_TEXT, vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'
import { useJobsStore } from '../store/jobs.ts'

export function RecentJobs(): JSX.Element {
  const jobs = useJobsStore((store) => store.jobs)
  const listErrorCode = useJobsStore((store) => store.listErrorCode)
  const actionErrorCode = useJobsStore((store) => store.actionErrorCode)
  const openFolder = useJobsStore((store) => store.openFolder)
  const duplicate = useJobsStore((store) => store.duplicate)

  const adoptState = useBuilderStore((store) => store.adoptState)
  const flushAutosave = useBuilderStore((store) => store.flushAutosave)

  const [duplicated, setDuplicated] = useState(false)

  async function duplicateInto(jobId: string): Promise<void> {
    const state = await duplicate(jobId)

    if (state === null) {
      return
    }

    adoptState(state)
    // `adoptState` reports the new draft as saved, so it is written out now.
    await flushAutosave()
    setDuplicated(true)
  }

  return (
    <div className="recent">
      {listErrorCode === null ? null : (
        <p className="recent__error" role="alert">
          {vi.jobs.listFailed} {ipcErrorText(listErrorCode)}
        </p>
      )}

      {actionErrorCode === null ? null : (
        <p className="recent__error" role="alert">
          {vi.jobs.actionFailed} {ipcErrorText(actionErrorCode)}
        </p>
      )}

      {duplicated ? <p className="recent__note">{vi.jobs.duplicated}</p> : null}

      {jobs.length === 0 ? (
        <p className="recent__empty">{vi.jobs.empty}</p>
      ) : (
        <table className="recent__table">
          <thead>
            <tr>
              <th scope="col">{vi.jobs.columnThumbnail}</th>
              <th scope="col">{vi.jobs.columnJob}</th>
              <th scope="col">{vi.jobs.columnSubject}</th>
              <th scope="col">{vi.jobs.columnState}</th>
              <th scope="col">{vi.jobs.columnTime}</th>
              <th scope="col">{vi.jobs.columnPreset}</th>
              <th scope="col">{vi.jobs.columnAnchor}</th>
              <th scope="col">{vi.jobs.columnActions}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.jobId}>
                <td>
                  <Thumbnail job={job} />
                </td>
                <th scope="row">{job.jobId}</th>
                <td>{job.subjectName}</td>
                <td>
                  {jobStateText(job)}
                  {job.errorCode === null ? null : (
                    <span className="recent__code"> {ipcErrorText(job.errorCode)}</span>
                  )}
                </td>
                <td>{formatTimestamp(job.completedAt ?? job.createdAt)}</td>
                <td>{job.preset ?? vi.jobs.none}</td>
                <td>{job.anchor ?? vi.jobs.none}</td>
                <td className="recent__actions">
                  <button
                    type="button"
                    onClick={(): void => {
                      void openFolder(job.jobId)
                    }}
                  >
                    {vi.jobs.openFolder}
                  </button>
                  <button
                    type="button"
                    onClick={(): void => {
                      void duplicateInto(job.jobId)
                    }}
                  >
                    {vi.jobs.duplicate}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** The first output, with the verifier's warnings underneath it (spec 7.3). */
function Thumbnail({ job }: { job: JobSummary }): JSX.Element {
  return (
    <>
      {job.thumbnailDataUrl === null ? (
        <span className="recent__thumbnail recent__thumbnail--empty">{vi.jobs.noThumbnail}</span>
      ) : (
        <img className="recent__thumbnail" src={job.thumbnailDataUrl} alt={job.jobId} />
      )}

      {job.warnings.length === 0 ? null : (
        <ul className="recent__warnings" aria-label={vi.jobs.warnings}>
          {job.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * The state word for one row (spec section 12).
 *
 * A job reported with `INTERRUPTED` is shown as failed whatever its stored
 * status says: the app restarted and found it unfinished, and that is a failure
 * with a reason, not a state of its own.
 */
export function jobStateText(job: JobSummary): string {
  return RUN_STATE_TEXT[job.errorCode === 'INTERRUPTED' ? 'failed' : job.state]
}

/**
 * An ISO timestamp as local `YYYY-MM-DD HH:mm`.
 *
 * Spelled out rather than left to `toLocaleString`, so the column is the same
 * width on every machine and a test can predict it.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return iso
  }

  const pad = (value: number): string => String(value).padStart(2, '0')

  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}
