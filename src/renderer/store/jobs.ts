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

import type { IpcErrorCode, JobSummary } from '@shared/ipc-contract'
import { isTerminalRunState, type ProgressEvent } from '@shared/progress'

import { bridge } from '../bridge.ts'

export interface JobsStore {
  /** Newest first, as `jobs.list` returns them (spec section 4.6). */
  readonly jobs: readonly JobSummary[]
  /** The latest progress event seen for each job ID. */
  readonly progressByJobId: Readonly<Record<string, ProgressEvent>>
  /** The job whose run has not reached a terminal state yet, if any. */
  readonly activeJobId: string | null
  readonly refreshing: boolean
  readonly listErrorCode: IpcErrorCode | null

  /** Re-reads the recent jobs list. */
  refresh: () => Promise<void>
  /** Records one progress event, ignoring one that arrived late. */
  applyProgress: (event: ProgressEvent) => void
  /** Subscribes to `jobs.onProgress`; the return value unsubscribes. */
  subscribeToProgress: () => () => void
  reset: () => void
}

interface JobsData {
  jobs: readonly JobSummary[]
  progressByJobId: Readonly<Record<string, ProgressEvent>>
  activeJobId: string | null
  refreshing: boolean
  listErrorCode: IpcErrorCode | null
}

function initialData(): JobsData {
  return {
    jobs: [],
    progressByJobId: {},
    activeJobId: null,
    refreshing: false,
    listErrorCode: null
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

    reset: (): void => {
      set(initialData())
    }
  }))
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
