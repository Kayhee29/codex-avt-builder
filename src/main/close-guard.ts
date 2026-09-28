/**
 * Closing the app while Codex is running (plan Task 5.6, spec section 10).
 *
 * Spec section 10: "the window closing must not silently start a new run; the
 * app has to say so if a process is still active". So a close with a run in
 * flight is stopped, the user is asked, and only their answer decides. Choosing
 * to quit cancels every run, and each of those writes its own `result.json`
 * with `CANCELLED` (spec section 7.4) — this module never writes one, because
 * the job state machine is the sole author of that file (spec section 7).
 *
 * Electron is not imported here. The message box, the quit and the job service
 * all arrive as the structural types below, which is what lets
 * `tests/unit/close-guard.test.ts` drive the whole flow — including the choice
 * the user makes — without a window, a dialog or a Codex.
 *
 * The two Vietnamese strings live here rather than in `src/renderer/i18n/vi.ts`
 * (plan decision Q10): this text is drawn by the operating system from the main
 * process, which cannot reach the renderer's module graph. It is the only
 * user-facing text outside that file.
 */

/** The part of `JobService` this guard uses. */
export interface CloseGuardJobs {
  /** The job IDs running right now. */
  readonly running: readonly string[]
  /** Cancels every run and returns the ones that accepted it. */
  cancelAll(): readonly string[]
  /** Resolves once no run is in flight, i.e. every result.json is written. */
  whenIdle(): Promise<void>
}

/** The part of an Electron event this guard uses. */
export interface CancellableEvent {
  preventDefault(): void
}

/** The options `dialog.showMessageBox` is given, narrowed to what is used. */
export interface CloseMessageBoxOptions {
  readonly type: 'question'
  readonly buttons: readonly string[]
  readonly defaultId: number
  readonly cancelId: number
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly noLink: boolean
}

/** `dialog.showMessageBox`, injected so the tests need no Electron. */
export type ShowMessageBox = (
  options: CloseMessageBoxOptions
) => Promise<{ readonly response: number }>

export interface CloseGuardOptions {
  readonly jobs: CloseGuardJobs
  readonly showMessageBox: ShowMessageBox
  /** Called once the user chose to quit and every run has finished. */
  readonly quit: () => void
  /**
   * How long to wait for the cancelled runs to write their `result.json`.
   *
   * A cancel kills the process tree (plan decision Q12) and the run then writes
   * its result, which takes milliseconds. The cap is there so a run that never
   * settles cannot leave the user unable to close the app; the job is reported
   * as `INTERRUPTED` on the next start instead (plan decision Q13).
   */
  readonly settleTimeoutMs?: number
}

/** The buttons, in the order they are shown. Index 0 is the default. */
export const CLOSE_GUARD_BUTTONS = ['Tiếp tục chạy', 'Hủy job và thoát'] as const

export const STAY_BUTTON_INDEX = 0
export const QUIT_BUTTON_INDEX = 1

export const CLOSE_GUARD_TITLE = 'Còn job đang chạy'
export const CLOSE_GUARD_MESSAGE = 'Đang có job Codex chạy. Thoát bây giờ sẽ hủy job đó.'
export const CLOSE_GUARD_DETAIL =
  'Job bị hủy vẫn giữ nguyên thư mục và log, và được ghi kết quả là "cancelled".'

/** Two seconds is far more than a cancelled run needs to write its result. */
const DEFAULT_SETTLE_TIMEOUT_MS = 2000

/**
 * Guards the app against closing on top of a running Codex.
 *
 * One instance per app session. {@link handleBeforeQuit} is attached to both
 * the window's `close` and the app's `before-quit`, because either can be what
 * ends the session and both have to ask the same question.
 */
export class CloseGuard {
  readonly #jobs: CloseGuardJobs
  readonly #showMessageBox: ShowMessageBox
  readonly #quit: () => void
  readonly #settleTimeoutMs: number
  /** The user chose to quit, so the next close must not be stopped again. */
  #quitting = false
  /** A dialog is already open; a second close must not open another. */
  #asking = false

  constructor(options: CloseGuardOptions) {
    this.#jobs = options.jobs
    this.#showMessageBox = options.showMessageBox
    this.#quit = options.quit
    this.#settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  }

  /** Whether the user has already agreed to quit. */
  get quitting(): boolean {
    return this.#quitting
  }

  /**
   * Stops a close that would kill a running Codex, and asks.
   *
   * With nothing running it does nothing at all, so the ordinary close stays
   * ordinary. The answer arrives asynchronously, which is why this cannot let
   * the close through and then ask: the event is already over by then, so the
   * close is refused now and a fresh quit is issued later if that is the
   * answer.
   */
  handleBeforeQuit(event: CancellableEvent): void {
    if (this.#quitting || this.#jobs.running.length === 0) {
      return
    }

    event.preventDefault()

    if (this.#asking) {
      return
    }

    this.#asking = true
    void this.#ask()
  }

  async #ask(): Promise<void> {
    try {
      const answer = await this.#showMessageBox({
        type: 'question',
        buttons: [...CLOSE_GUARD_BUTTONS],
        defaultId: STAY_BUTTON_INDEX,
        cancelId: STAY_BUTTON_INDEX,
        title: CLOSE_GUARD_TITLE,
        message: CLOSE_GUARD_MESSAGE,
        detail: CLOSE_GUARD_DETAIL,
        noLink: true
      })

      if (answer.response !== QUIT_BUTTON_INDEX) {
        return
      }

      // Each cancelled run writes its own `result.json` with `CANCELLED`
      // (spec section 7.4); waiting is what makes sure they got to.
      this.#jobs.cancelAll()
      await withTimeout(this.#jobs.whenIdle(), this.#settleTimeoutMs)

      this.#quitting = true
      this.#quit()
    } finally {
      this.#asking = false
    }
  }
}

/** Resolves with `promise`, or after `timeoutMs`, whichever comes first. */
async function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}
