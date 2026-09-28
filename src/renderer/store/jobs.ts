/**
 * The jobs store (plan Task 5.1 and decision Q9, spec sections 4.6, 5.5, 12).
 *
 * It holds the recent-jobs list and the latest `ProgressEvent` per job. The run
 * state is never derived here: spec section 5.5 makes the main process the only
 * thing that sets it, and `activity` is display text that must never be used to
 * branch logic (spec section 12).
 *
 * Events can arrive out of order, so `applyProgress` keeps the highest `seq`
 * per job and drops anything older. `seq` counts within one run, and a run owns
 * its job ID, so comparing per job is the whole rule.
 *
 * There is no application-wide `loading` boolean (spec section 12); `refreshing`
 * belongs to this list and to nothing else.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'

import type { BuilderStateInput, IpcErrorCode, JobSummary } from '@shared/ipc-contract'
import { isTerminalRunState, type ProgressEvent, type RunState } from '@shared/progress'
import { dedupeReferenceRoles } from '@shared/reference-roles'
import {
  SCHEMA_VERSION,
  type BuilderReference,
  type BuilderState,
  type JobPacket
} from '@shared/schemas'

import { bridge } from '../bridge.ts'

/**
 * The states a cancel is accepted in (spec section 5.5, plan decision Q20).
 *
 * The same list as `CANCELLABLE_STATES` in `src/main/jobs.ts`, which is the
 * side that enforces it; this one only decides whether the button is enabled.
 */
export const CANCELLABLE_RUN_STATES: readonly RunState[] = ['queued', 'preflight', 'running']

export interface JobsStore {
  /** Newest first, as `jobs.list` returns them (spec section 4.6). */
  readonly jobs: readonly JobSummary[]
  /** The latest progress event seen for each job ID. */
  readonly progressByJobId: Readonly<Record<string, ProgressEvent>>
  /** The job whose run has not reached a terminal state yet, if any. */
  readonly activeJobId: string | null
  /** The job the last progress event was about, running or finished. */
  readonly lastJobId: string | null
  readonly refreshing: boolean
  /** A `jobs.generate` is in flight and has not answered yet. */
  readonly starting: boolean
  readonly listErrorCode: IpcErrorCode | null
  readonly generateErrorCode: IpcErrorCode | null
  /** Cancel, open folder and duplicate report here. */
  readonly actionErrorCode: IpcErrorCode | null

  /** Re-reads the recent jobs list. */
  refresh: () => Promise<void>
  /** Records one progress event, ignoring one that arrived late. */
  applyProgress: (event: ProgressEvent) => void
  /** Subscribes to `jobs.onProgress`; the return value unsubscribes. */
  subscribeToProgress: () => () => void
  /** Materializes and runs a job (spec section 5.2). Answers the job ID. */
  generate: (state: BuilderStateInput, promptSha256: string) => Promise<string | null>
  /** Ends a run (spec section 5.5, plan decision Q20). */
  cancel: (jobId: string) => Promise<boolean>
  /** Reveals the job directory (spec section 4.6). */
  openFolder: (jobId: string) => Promise<boolean>
  /** Reads a finished job back as a new builder state (spec section 10). */
  duplicate: (jobId: string) => Promise<BuilderState | null>
  reset: () => void
}

interface JobsData {
  jobs: readonly JobSummary[]
  progressByJobId: Readonly<Record<string, ProgressEvent>>
  activeJobId: string | null
  lastJobId: string | null
  refreshing: boolean
  starting: boolean
  listErrorCode: IpcErrorCode | null
  generateErrorCode: IpcErrorCode | null
  actionErrorCode: IpcErrorCode | null
}

function initialData(): JobsData {
  return {
    jobs: [],
    progressByJobId: {},
    activeJobId: null,
    lastJobId: null,
    refreshing: false,
    starting: false,
    listErrorCode: null,
    generateErrorCode: null,
    actionErrorCode: null
  }
}

export function createJobsStore(): UseBoundStore<StoreApi<JobsStore>> {
  return create<JobsStore>((set, get) => ({
    ...initialData(),

    refresh: async (): Promise<void> => {
      set({ refreshing: true })

      const answer = await bridge()['jobs.list']()

      if (!answer.ok) {
        set({ refreshing: false, listErrorCode: answer.code })

        return
      }

      set({ refreshing: false, listErrorCode: null, jobs: answer.data.jobs })
    },

    applyProgress: (event: ProgressEvent): void => {
      const previous = get().progressByJobId[event.jobId]

      if (previous !== undefined && event.seq <= previous.seq) {
        return
      }

      const terminal = isTerminalRunState(event.state)

      set((store) => ({
        progressByJobId: { ...store.progressByJobId, [event.jobId]: event },
        lastJobId: event.jobId,
        activeJobId: terminal
          ? store.activeJobId === event.jobId
            ? null
            : store.activeJobId
          : event.jobId
      }))
    },

    subscribeToProgress: (): (() => void) => {
      return bridge()['jobs.onProgress']((event) => {
        const before = get().progressByJobId[event.jobId]

        get().applyProgress(event)

        // A run that just ended changed `result.json`, so the row in the
        // recent-jobs list is stale (spec section 12 reads state from there).
        if (isTerminalRunState(event.state) && (before === undefined || event.seq > before.seq)) {
          void get().refresh()
        }
      })
    },

    /**
     * Starts a run (spec sections 5.1 and 5.2).
     *
     * The job is marked active as soon as this answers, before any progress
     * event has arrived, because Cancel has to work from `queued` and
     * `preflight` and preflight alone can take twenty seconds (spec section
     * 5.5, plan decision Q20).
     *
     * A run that is already over by the time the answer lands keeps its
     * terminal state: the progress stream and this reply race, and the stream
     * is the authority on what state a run is in (spec section 5.5).
     */
    generate: async (state: BuilderStateInput, promptSha256: string): Promise<string | null> => {
      set({ starting: true, generateErrorCode: null })

      const answer = await bridge()['jobs.generate']({ state, promptSha256 })

      if (!answer.ok) {
        set({ starting: false, generateErrorCode: answer.code })

        return null
      }

      const jobId = answer.data.jobId

      set((store) => {
        const seen = store.progressByJobId[jobId]

        return {
          starting: false,
          generateErrorCode: null,
          ...(seen !== undefined && isTerminalRunState(seen.state) ? {} : { activeJobId: jobId })
        }
      })

      await get().refresh()

      return jobId
    },

    cancel: async (jobId: string): Promise<boolean> => {
      const answer = await bridge()['jobs.cancel']({ jobId })

      if (!answer.ok) {
        set({ actionErrorCode: answer.code })

        return false
      }

      set({ actionErrorCode: null })

      // The run writes its own `cancelled` result.json and reports the
      // terminal state through `jobs.onProgress` (spec section 5.5), so
      // nothing here changes `activeJobId`.
      return answer.data.cancelled
    },

    openFolder: async (jobId: string): Promise<boolean> => {
      const answer = await bridge()['jobs.openFolder']({ jobId })

      if (!answer.ok) {
        set({ actionErrorCode: answer.code })

        return false
      }

      set({ actionErrorCode: null })

      return answer.data.opened
    },

    duplicate: async (jobId: string): Promise<BuilderState | null> => {
      const answer = await bridge()['jobs.get']({ jobId })

      if (!answer.ok) {
        set({ actionErrorCode: answer.code })

        return null
      }

      set({ actionErrorCode: null })

      return builderStateFromJob(answer.data.job, answer.data.references)
    },

    reset: (): void => {
      set(initialData())
    }
  }))
}

/**
 * A finished job as a new builder state (spec section 10, plan Task 5.5).
 *
 * A job that has run is immutable, so duplicating it means starting a fresh
 * draft from its packet. The references are the handles main minted for the
 * files in that job's `inputs/`; the renderer never learns where they are
 * (spec section 11, plan decision Q3), and `job.json` already carries each
 * one's role and note.
 *
 * `negativeConstraints` comes straight from the packet: spec section 6.2 makes
 * it a field of `job.json` precisely so duplicating a job does not drop it.
 */
export function builderStateFromJob(
  job: JobPacket,
  references: readonly BuilderReference[]
): BuilderState {
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: job.subject,
    references: dedupeReferenceRoles(references),
    output: job.output,
    negativeConstraints: [...job.negativeConstraints],
    source: job.source
  }
}

/** The store the app uses. Tests call `reset()` between cases. */
export const useJobsStore = createJobsStore()

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The progress of the run in flight, or `null` when nothing is running. */
export function selectActiveProgress(store: JobsStore): ProgressEvent | null {
  return store.activeJobId === null ? null : (store.progressByJobId[store.activeJobId] ?? null)
}

/** Whether a run is in flight. Plan Task 5.5 uses this to lock Generate. */
export function selectIsRunning(store: JobsStore): boolean {
  return store.activeJobId !== null
}

/**
 * The progress the run panel shows: the active run, or the last one this
 * session saw, so its outcome stays on screen after it ends.
 *
 * It returns the stored event rather than a derived object, so subscribing to
 * it is safe (zustand compares snapshots by identity).
 */
export function selectDisplayProgress(store: JobsStore): ProgressEvent | null {
  const jobId = store.activeJobId ?? store.lastJobId

  return jobId === null ? null : (store.progressByJobId[jobId] ?? null)
}

/**
 * Whether Cancel is allowed right now (spec section 5.5, plan decision Q20).
 *
 * `queued`, `preflight` and `running` may be cancelled; `verifying` may not,
 * because the run has already finished, and neither may a terminal state. A
 * job that is active with no event yet is the window between `jobs.generate`
 * answering and the first `queued` arriving, and Cancel works there too.
 */
export function selectCanCancel(store: JobsStore): boolean {
  if (store.activeJobId === null) {
    return false
  }

  const progress = store.progressByJobId[store.activeJobId]

  return progress === undefined || CANCELLABLE_RUN_STATES.includes(progress.state)
}
