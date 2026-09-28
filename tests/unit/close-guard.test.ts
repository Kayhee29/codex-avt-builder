/**
 * Closing the app while Codex is running (plan Task 5.6, spec section 10).
 *
 * The guard is driven here exactly as Electron drives it — an event object
 * with `preventDefault`, a message box that answers, and a `quit` — so the
 * whole flow is under test without a window, a dialog or a Codex. What the
 * cancelled runs then do is `src/main/jobs.ts`'s job and is covered by
 * `tests/integration/jobs.test.ts`; here the guard's contract with them is:
 * cancel everything, wait for it, and only then quit.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  CloseGuard,
  CLOSE_GUARD_BUTTONS,
  QUIT_BUTTON_INDEX,
  STAY_BUTTON_INDEX,
  type CloseGuardJobs,
  type ShowMessageBox
} from '../../src/main/close-guard.ts'

const JOB_ID = '2026-09-28-nguyen-van-a-001'

/** An event shaped like the Electron one, remembering whether it was stopped. */
function closeEvent(): { preventDefault: () => void; prevented: boolean } {
  const event = {
    prevented: false,
    preventDefault: (): void => {
      event.prevented = true
    }
  }

  return event
}

interface FakeJobs extends CloseGuardJobs {
  running: string[]
  readonly cancelled: string[]
  /** Resolves the pending `whenIdle`, the way a finished run would. */
  settle: () => void
}

function fakeJobs(running: string[] = [JOB_ID]): FakeJobs {
  let release: (() => void) | null = null
  const cancelled: string[] = []

  return {
    running,
    cancelled,
    cancelAll(): readonly string[] {
      cancelled.push(...running)

      return [...running]
    },
    async whenIdle(): Promise<void> {
      if (cancelled.length === 0) {
        return
      }

      await new Promise<void>((resolve) => {
        release = resolve
      })
    },
    settle(): void {
      release?.()
      release = null
    }
  }
}

/** A message box that always answers with the same button. */
function answering(response: number): ShowMessageBox {
  return vi.fn(async () => ({ response }))
}

describe('nothing is running', () => {
  it('lets the close through untouched', () => {
    const showMessageBox = answering(QUIT_BUTTON_INDEX)
    const guard = new CloseGuard({ jobs: fakeJobs([]), showMessageBox, quit: vi.fn() })
    const event = closeEvent()

    guard.handleBeforeQuit(event)

    expect(event.prevented).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('a run is in flight (spec section 10)', () => {
  it('stops the close and asks', async () => {
    const showMessageBox = answering(STAY_BUTTON_INDEX)
    const quit = vi.fn()
    const guard = new CloseGuard({ jobs: fakeJobs(), showMessageBox, quit })
    const event = closeEvent()

    guard.handleBeforeQuit(event)

    expect(event.prevented).toBe(true)

    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledTimes(1)
    })

    const options = (showMessageBox as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      buttons: string[]
      defaultId: number
      cancelId: number
    }

    // Staying is the default and the Escape answer: closing on top of a run is
    // the destructive choice, so it is never the one a stray key press picks.
    expect(options.buttons).toEqual([...CLOSE_GUARD_BUTTONS])
    expect(options.defaultId).toBe(STAY_BUTTON_INDEX)
    expect(options.cancelId).toBe(STAY_BUTTON_INDEX)
  })

  it('keeps the app open when the user chooses to keep running', async () => {
    const quit = vi.fn()
    const jobs = fakeJobs()
    const guard = new CloseGuard({ jobs, showMessageBox: answering(STAY_BUTTON_INDEX), quit })

    guard.handleBeforeQuit(closeEvent())

    await vi.waitFor(() => {
      expect(quit).not.toHaveBeenCalled()
    })
    expect(jobs.cancelled).toEqual([])
    expect(guard.quitting).toBe(false)
  })

  it('cancels every run, waits for it, and only then quits', async () => {
    const quit = vi.fn()
    const jobs = fakeJobs([JOB_ID, '2026-09-28-nguyen-van-a-002'])
    const guard = new CloseGuard({ jobs, showMessageBox: answering(QUIT_BUTTON_INDEX), quit })

    guard.handleBeforeQuit(closeEvent())

    await vi.waitFor(() => {
      expect(jobs.cancelled).toEqual([JOB_ID, '2026-09-28-nguyen-van-a-002'])
    })

    // The runs are still writing their `result.json`, so the app stays.
    expect(quit).not.toHaveBeenCalled()

    jobs.settle()

    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1)
    })
    expect(guard.quitting).toBe(true)
  })

  it('lets the next close through once the user has agreed to quit', async () => {
    const jobs = fakeJobs()
    const guard = new CloseGuard({
      jobs,
      showMessageBox: answering(QUIT_BUTTON_INDEX),
      quit: vi.fn()
    })

    guard.handleBeforeQuit(closeEvent())
    await vi.waitFor(() => {
      expect(jobs.cancelled).toHaveLength(1)
    })
    jobs.settle()
    await vi.waitFor(() => {
      expect(guard.quitting).toBe(true)
    })

    // `quit()` makes Electron fire the close again; it must not be stopped a
    // second time, and the run is still listed because it has not been
    // removed from the fake.
    const second = closeEvent()

    guard.handleBeforeQuit(second)

    expect(second.prevented).toBe(false)
  })

  it('opens only one dialog however many closes arrive', async () => {
    const showMessageBox = answering(STAY_BUTTON_INDEX)
    const guard = new CloseGuard({ jobs: fakeJobs(), showMessageBox, quit: vi.fn() })

    guard.handleBeforeQuit(closeEvent())
    guard.handleBeforeQuit(closeEvent())
    guard.handleBeforeQuit(closeEvent())

    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledTimes(1)
    })
  })

  it('asks again after the user kept the app open', async () => {
    const showMessageBox = answering(STAY_BUTTON_INDEX)
    const guard = new CloseGuard({ jobs: fakeJobs(), showMessageBox, quit: vi.fn() })

    guard.handleBeforeQuit(closeEvent())
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledTimes(1)
    })

    guard.handleBeforeQuit(closeEvent())
    await vi.waitFor(() => {
      expect(showMessageBox).toHaveBeenCalledTimes(2)
    })
  })

  it('quits anyway when a cancelled run never settles', async () => {
    const quit = vi.fn()
    const jobs: CloseGuardJobs = {
      running: [JOB_ID],
      cancelAll: () => [JOB_ID],
      whenIdle: async () => new Promise<void>(() => undefined)
    }
    const guard = new CloseGuard({
      jobs,
      showMessageBox: answering(QUIT_BUTTON_INDEX),
      quit,
      settleTimeoutMs: 10
    })

    guard.handleBeforeQuit(closeEvent())

    // Plan decision Q13 covers the result that never got written: the job is
    // reported INTERRUPTED at the next start rather than trapping the user.
    await vi.waitFor(() => {
      expect(quit).toHaveBeenCalledTimes(1)
    })
  })
})
