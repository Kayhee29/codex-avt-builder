/**
 * The job state machine (plan Task 3.7, spec sections 5.5, 5.6 and 7).
 *
 * ```text
 * queued → preflight → running → verifying → succeeded
 *   │          │          │          │
 *   │          └──────────┴──────────┴──────→ failed
 *   └──────────┴──────────┴─────────────────→ cancelled
 * ```
 *
 * Cancel is allowed in `queued`, `preflight` and `running` (spec section 5.5,
 * plan decision Q20): preflight alone can take twenty seconds, so a Cancel
 * button that only works once Codex is spawned is not good enough. A cancel
 * that arrives before the spawn stops the job where it stands and no Codex ever
 * runs. In `verifying` it is ignored, because the run has already finished.
 *
 * Every one of those states is set here, by the main process, and never
 * inferred from something Codex said: Codex knows nothing about the app's
 * phases (spec section 5.5). The `activity` strings that travel alongside are
 * display text and never decide anything (spec section 12).
 *
 * **Every branch writes `result.json`**, because spec section 7 makes the main
 * process the sole author of it — including when Codex never ran. A preflight
 * failure writes one with `executor.codexVersion` null; a cancel writes one with
 * `CANCELLED`; a run that finished writes whatever the verifier of plan Task 3.6
 * concluded. The one case that writes nothing is a Generate refused before the
 * job directory exists, where there is no directory to write into; that call
 * fails over IPC instead and leaves no trace, which is what spec section 5.2
 * asks for.
 *
 * `jobs.list`, `jobs.get` and `jobs.openFolder` of spec section 8 live here
 * too. `jobs.get` validates the job ID against the pattern of spec section 6.1
 * before it touches the filesystem, because that ID arrives from the renderer.
 *
 * Node built-ins are allowed here; Electron is imported lazily inside
 * {@link revealInFolder} and nowhere else, so the tests run without a browser.
 */
import { appendFile, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { BuilderStateInput, IpcErrorCode, JobSummary } from '../shared/ipc-contract.ts'
import { isValidJobId } from '../shared/job-id.ts'
import type { RunState } from '../shared/progress.ts'
import {
  JobPacketSchema,
  type BuilderReference,
  type JobPacket,
  type Result,
  type ResultErrorCode,
  type ResultExecutor
} from '../shared/schemas.ts'

import type { PreflightOutcome } from './codex-preflight.ts'
import {
  CodexRunError,
  CodexRunner,
  EVENTS_FILE_NAME,
  ProgressEmitter,
  type CodexRunOutcome,
  type ProgressSink
} from './codex-runner.ts'
import {
  JOB_FILE_NAME,
  MaterializeError,
  type JobMaterializer,
  type MaterializedJob
} from './job-materializer.ts'
import type { ReferenceRegistry } from './reference-registry.ts'
import { buildResult, readResultJson, verifyCodexRun, writeResultJson } from './result-verifier.ts'
import { jobDir, workspaceLayout, type WorkspaceLayout } from './workspace.ts'

/** The `type` of the line main writes when preflight refused to start a run. */
export const STUDIO_PREFLIGHT_EVENT_TYPE = 'studio.preflight'

/** What `result.json` says when the user pressed Cancel (spec section 7.4). */
export const CANCELLED_MESSAGE = 'You cancelled this job.'

/** The states a cancel is accepted in (spec section 5.5, plan decision Q20). */
const CANCELLABLE_STATES: readonly RunState[] = ['queued', 'preflight', 'running']

/**
 * Thrown by a call the renderer made, carrying a code from the IPC vocabulary
 * of `src/shared/ipc-contract.ts` — the codes of spec section 7.4 plus the four
 * a call can fail with before a job exists.
 *
 * The message is short, user-facing and free of absolute paths
 * (spec section 11).
 */
export class JobError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'JobError'
    this.code = code
  }
}

/** The part of `CodexPreflight` this service uses (plan Task 3.2). */
export interface PreflightRunner {
  run(request?: { readonly force?: boolean }): Promise<PreflightOutcome>
}

/** Reveals a path in the OS file manager. Injected so tests need no Electron. */
export type FolderRevealer = (absPath: string) => Promise<void> | void

export interface JobServiceOptions {
  /** The workspace root, or the layout {@link workspaceLayout} built from it. */
  readonly workspace: string | WorkspaceLayout
  readonly materializer: JobMaterializer
  readonly preflight: PreflightRunner
  /** Defaults to a fresh {@link CodexRunner}. */
  readonly runner?: CodexRunner
  /** Needed by `jobs.get` to hand back handles for a job's inputs. */
  readonly registry?: ReferenceRegistry
  /** Where `jobs.onProgress` events go (spec section 5.5). */
  readonly onProgress?: ProgressSink
  /** Injected so tests get predictable timestamps. */
  readonly now?: () => Date
  /** Defaults to {@link revealInFolder}, which loads Electron lazily. */
  readonly reveal?: FolderRevealer
  /** Renders the thumbnail `jobs.list` shows for a finished job. */
  readonly renderThumbnail?: (absPath: string) => Promise<string | null>
}

/** What `jobs.generate` hands back (spec section 8 returns only the job ID). */
export interface StartedJob {
  readonly jobId: string
  /** Absolute path of the job directory. */
  readonly directory: string
  /**
   * The run, from `queued` to a terminal state. It resolves with the
   * `result.json` main wrote and never rejects, so an IPC handler that answers
   * with the job ID alone cannot leave an unhandled rejection behind.
   */
  readonly completed: Promise<Result>
}

/**
 * Owns every run in the app session.
 *
 * One instance lives in the main process. It is the only thing that moves a job
 * between states, and the only thing that writes `result.json`.
 */
export class JobService {
  readonly #layout: WorkspaceLayout
  readonly #materializer: JobMaterializer
  readonly #preflight: PreflightRunner
  readonly #runner: CodexRunner
  readonly #registry: ReferenceRegistry | undefined
  readonly #onProgress: ProgressSink | undefined
  readonly #now: () => Date
  readonly #reveal: FolderRevealer
  readonly #renderThumbnail: ((absPath: string) => Promise<string | null>) | undefined
  /** Jobs this session is running, with the state they are in right now. */
  readonly #active = new Map<string, ProgressEmitter>()
  /**
   * Jobs the user cancelled before Codex was spawned (plan decision Q20).
   *
   * Once the process exists the runner owns the cancel; before it does there is
   * nothing to signal, so the request is recorded here and the state machine
   * stops at its next checkpoint.
   */
  readonly #cancelRequested = new Set<string>()
  /**
   * The `completed` promise of every run in flight (plan Task 5.6).
   *
   * {@link whenIdle} waits on these, so the close guard can be sure each
   * cancelled run got as far as writing its `result.json` (spec section 7).
   */
  readonly #pending = new Map<string, Promise<Result>>()

  constructor(options: JobServiceOptions) {
    this.#layout =
      typeof options.workspace === 'string' ? workspaceLayout(options.workspace) : options.workspace
    this.#materializer = options.materializer
    this.#preflight = options.preflight
    this.#runner = options.runner ?? new CodexRunner()
    this.#registry = options.registry
    this.#onProgress = options.onProgress
    this.#now = options.now ?? (() => new Date())
    this.#reveal = options.reveal ?? revealInFolder
    this.#renderThumbnail = options.renderThumbnail
  }

  /** The job IDs running right now (spec section 10, plan Task 5.6). */
  get running(): readonly string[] {
    return [...this.#active.keys()]
  }

  isRunning(jobId: string): boolean {
    return this.#active.has(jobId)
  }

  /**
   * Materializes a job and runs it (spec sections 5.2 and 5.5).
   *
   * Rejects with {@link JobError} only while the job still does not exist —
   * an invalid builder state, a prompt checksum that does not match, a missing
   * reference. Once the directory is on disk the run always ends in a
   * `result.json`, and the failure is reported there rather than thrown.
   */
  async generate(state: BuilderStateInput, promptSha256: string): Promise<StartedJob> {
    let materialized: MaterializedJob

    try {
      materialized = await this.#materializer.materialize(state, promptSha256)
    } catch (error) {
      if (error instanceof MaterializeError) {
        throw new JobError(error.code, error.message)
      }

      throw error
    }

    const progress = new ProgressEmitter(materialized.jobId, this.#onProgress, this.#now)

    this.#active.set(materialized.jobId, progress)

    // Spec section 5.5: `queued` is set the moment the directory is complete.
    progress.emit('queued')

    const startedAt = this.#now().toISOString()
    const completed = this.#run(materialized, progress, startedAt).finally(() => {
      this.#active.delete(materialized.jobId)
      this.#cancelRequested.delete(materialized.jobId)
      this.#pending.delete(materialized.jobId)
    })

    this.#pending.set(materialized.jobId, completed)

    return { jobId: materialized.jobId, directory: materialized.directory, completed }
  }

  /**
   * Ends a job and everything it started, in any state spec section 5.5 allows
   * Cancel from: `queued`, `preflight` or `running`.
   *
   * With Codex running this kills the process tree (plan decision Q12). Before
   * the spawn there is nothing to signal, so the request is recorded and the
   * run stops at its next checkpoint without ever starting Codex
   * (plan decision Q20) — preflight alone can take twenty seconds, and a job
   * waiting on it must be cancellable.
   *
   * Either way the run itself writes the `cancelled` `result.json`, so this
   * returns as soon as the request is in. `false` means there was nothing to
   * cancel: no such run, or one that has already reached `verifying`, where the
   * work is done and the answer is whatever it produced.
   */
  cancel(jobId: string): boolean {
    this.#assertJobId(jobId)

    if (this.#runner.cancel(jobId)) {
      return true
    }

    const progress = this.#active.get(jobId)

    if (progress === undefined || !CANCELLABLE_STATES.includes(progress.state)) {
      return false
    }

    this.#cancelRequested.add(jobId)

    return true
  }

  /**
   * Cancels every run (spec section 10, plan Task 5.6).
   *
   * Used when the window is closing with Codex still running. Each cancelled
   * run writes its own `result.json` with `CANCELLED`; {@link whenIdle} is how
   * a caller waits for that. Returns the jobs that accepted the cancel.
   */
  cancelAll(): readonly string[] {
    return this.running.filter((jobId) => this.cancel(jobId))
  }

  /**
   * Resolves once no run is in flight (plan Task 5.6).
   *
   * A run's promise never rejects (see {@link generate}), and it is removed
   * from the pending map by the same `finally` that resolves it, so the loop
   * re-reads the map rather than trusting one snapshot of it.
   */
  async whenIdle(): Promise<void> {
    let pending = [...this.#pending.values()]

    while (pending.length > 0) {
      await Promise.allSettled(pending)
      pending = [...this.#pending.values()]
    }
  }

  /** Recent jobs (spec section 4.6), newest first. */
  async list(): Promise<JobSummary[]> {
    const summaries: JobSummary[] = []

    for (const jobId of await listJobIds(this.#layout)) {
      const directory = jobDir(this.#layout.root, jobId)
      const packet = await readJobPacket(directory)

      if (packet === null) {
        continue
      }

      summaries.push(await this.#summarize(directory, packet))
    }

    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  /**
   * One job, with handles for the files in its `inputs/` so the UI can
   * duplicate it into a new draft without ever seeing a path (plan Task 5.5).
   *
   * The job ID is validated before anything touches the filesystem, because it
   * came from the renderer (spec sections 6.1 and 11).
   */
  async get(jobId: string): Promise<{
    job: JobPacket
    result: Result | null
    references: BuilderReference[]
  }> {
    this.#assertJobId(jobId)

    const directory = jobDir(this.#layout.root, jobId)
    const packet = await readJobPacket(directory)

    if (packet === null) {
      throw new JobError('NOT_FOUND', 'That job is not in this workspace.')
    }

    return {
      job: packet,
      result: await readResultJson(directory),
      references: await this.#inputHandles(directory, packet)
    }
  }

  /** Reveals the job directory in the OS file manager (spec section 8). */
  async openFolder(jobId: string): Promise<boolean> {
    this.#assertJobId(jobId)

    const directory = jobDir(this.#layout.root, jobId)

    if (!(await isDirectory(directory))) {
      throw new JobError('NOT_FOUND', 'That job is not in this workspace.')
    }

    // `showItemInFolder` reveals a file, so point it at the one file every job
    // has; the folder opens with `job.json` selected.
    await this.#reveal(join(directory, JOB_FILE_NAME))

    return true
  }

  // -------------------------------------------------------------------------
  // The state machine
  // -------------------------------------------------------------------------

  /**
   * `preflight → running → verifying → terminal`.
   *
   * Never rejects: the caller may drop this promise, and a run that has a
   * directory must always end in a `result.json`.
   */
  async #run(
    materialized: MaterializedJob,
    progress: ProgressEmitter,
    startedAt: string
  ): Promise<Result> {
    const { jobId, directory, packet, inputPaths } = materialized

    try {
      // Plan decision Q20: cancelled while `queued`, which is where a job sits
      // between the directory being complete and this function running.
      if (this.#cancelRequested.has(jobId)) {
        return await this.#finishCancelled(directory, progress, jobId, startedAt)
      }

      progress.emit('preflight')

      const outcome = await this.#preflight.run()

      // Plan decision Q20: cancelled while preflight ran. The user's request
      // wins over whatever preflight went on to conclude — they stopped the
      // job, and it never got as far as Codex.
      if (this.#cancelRequested.has(jobId)) {
        return await this.#finishCancelled(directory, progress, jobId, startedAt)
      }

      if (!outcome.result.ok || outcome.launcher === null) {
        await this.#logPreflightFailure(directory, outcome)

        return await this.#finish(
          directory,
          progress,
          buildResult({
            jobId,
            status: 'failed',
            startedAt,
            completedAt: this.#now().toISOString(),
            // Spec section 7.2: Codex never ran, so there is no version, no
            // executable, no exit code and no signal to record.
            executor: nullExecutor(),
            error: outcome.result.ok
              ? { code: 'CODEX_NOT_FOUND', message: 'Codex CLI could not be started.' }
              : { code: outcome.result.code, message: outcome.result.message }
          })
        )
      }

      const { version, executable } = outcome.result

      progress.emit('running')

      const run = await this.#runner.start({
        jobId,
        jobDir: directory,
        inputPaths,
        launcher: outcome.launcher,
        codexVersion: version,
        progress
      })
      const executor: ResultExecutor = {
        codexVersion: version,
        executable,
        exitCode: run.exitCode,
        signal: run.signal
      }

      // The second half covers the sliver between `progress.emit('running')`
      // and the runner registering the child: a cancel that lands there finds
      // no process to kill and is recorded instead.
      if (run.cancelled || this.#cancelRequested.has(jobId)) {
        return await this.#finish(
          directory,
          progress,
          buildResult({
            jobId,
            status: 'cancelled',
            startedAt,
            completedAt: this.#now().toISOString(),
            executor,
            error: { code: 'CANCELLED', message: CANCELLED_MESSAGE }
          })
        )
      }

      if (run.spawnError !== null) {
        return await this.#finish(
          directory,
          progress,
          buildResult({
            jobId,
            status: 'failed',
            startedAt,
            completedAt: this.#now().toISOString(),
            executor,
            error: spawnFailure(run)
          })
        )
      }

      progress.emit('verifying')

      const verification = await verifyCodexRun({
        jobDir: directory,
        job: packet,
        exitCode: run.exitCode,
        stderr: run.stderr
      })

      return await this.#finish(
        directory,
        progress,
        buildResult({
          jobId,
          status: verification.status,
          startedAt,
          completedAt: this.#now().toISOString(),
          executor,
          outputs: verification.outputs,
          warnings: verification.warnings,
          error: verification.error
        })
      )
    } catch (error) {
      // Anything unexpected — a second `start` on this ID, a full disk while
      // the verifier reads — still has to leave a result.json behind, because
      // the UI reads no other file (spec section 7).
      return this.#finish(
        directory,
        progress,
        buildResult({
          jobId,
          status: 'failed',
          startedAt,
          completedAt: this.#now().toISOString(),
          executor: nullExecutor(),
          error: {
            code: 'GENERATION_FAILED',
            message:
              error instanceof CodexRunError || error instanceof JobError
                ? error.message
                : 'This job stopped because of an unexpected problem. The job folder still has the logs.'
          }
        })
      )
    }
  }

  /**
   * Ends a job the user cancelled before Codex was spawned (plan decision Q20).
   *
   * Spec section 7.2: every executor field is null, because no Codex ran — the
   * same shape a preflight failure writes, and the honest record of a job that
   * never started.
   */
  async #finishCancelled(
    directory: string,
    progress: ProgressEmitter,
    jobId: string,
    startedAt: string
  ): Promise<Result> {
    return this.#finish(
      directory,
      progress,
      buildResult({
        jobId,
        status: 'cancelled',
        startedAt,
        completedAt: this.#now().toISOString(),
        executor: nullExecutor(),
        error: { code: 'CANCELLED', message: CANCELLED_MESSAGE }
      })
    )
  }

  /**
   * Writes `result.json` and emits the terminal state.
   *
   * A write that fails must not turn a finished run into a rejected promise, so
   * the result is still returned; the run is then reported as interrupted the
   * next time the app starts (plan decision Q13), which is the honest outcome
   * for a job whose result never reached the disk.
   */
  async #finish(directory: string, progress: ProgressEmitter, result: Result): Promise<Result> {
    try {
      await writeResultJson(directory, result)
    } catch {
      // Left for `recoverInterruptedJobs`.
    }

    progress.emit(result.status)

    return result
  }

  /**
   * Records a preflight failure in the job's own log.
   *
   * Spec section 5.3 wants the executable question answered in `events.jsonl`;
   * on a successful run `studio.meta` answers it, and this is the answer when
   * there is no run. `attempts` lists every path the resolver probed and stays
   * in the log — it never crosses to the renderer.
   */
  async #logPreflightFailure(directory: string, outcome: PreflightOutcome): Promise<void> {
    const line = JSON.stringify({
      type: STUDIO_PREFLIGHT_EVENT_TYPE,
      ok: outcome.result.ok,
      code: outcome.result.ok ? null : outcome.result.code,
      message: outcome.result.ok ? null : outcome.result.message,
      attempts: outcome.attempts ?? []
    })

    try {
      await appendFile(join(directory, EVENTS_FILE_NAME), `${line}\n`, 'utf8')
    } catch {
      // A log that cannot be written must not stop the result from being one.
    }
  }

  async #summarize(directory: string, packet: JobPacket): Promise<JobSummary> {
    const result = await readResultJson(directory)
    const live = this.#active.get(packet.jobId)

    return {
      jobId: packet.jobId,
      subjectName: packet.subject.name,
      state: summaryState(result, live),
      createdAt: packet.createdAt,
      completedAt: result?.completedAt ?? null,
      preset: packet.source.preset,
      anchor: packet.source.anchor,
      outputCount: result?.outputs.length ?? 0,
      errorCode: summaryErrorCode(result, live),
      warnings: result?.warnings ?? [],
      thumbnailDataUrl: await this.#thumbnailFor(directory, result)
    }
  }

  async #thumbnailFor(directory: string, result: Result | null): Promise<string | null> {
    const first = result?.outputs[0]

    if (this.#renderThumbnail === undefined || first === undefined) {
      return null
    }

    try {
      return await this.#renderThumbnail(join(directory, ...first.path.split('/')))
    } catch {
      return null
    }
  }

  /**
   * Handles for the files in a job's `inputs/`, reusing the measurements
   * `job.json` already carries so nothing is re-read that does not have to be.
   */
  async #inputHandles(directory: string, packet: JobPacket): Promise<BuilderReference[]> {
    const registry = this.#registry

    if (registry === undefined) {
      return []
    }

    const references: BuilderReference[] = []

    for (const reference of packet.references) {
      try {
        references.push(
          await registry.createReference(join(directory, ...reference.path.split('/')), {
            role: reference.role,
            originalName: reference.originalName,
            ...(reference.note === undefined ? {} : { note: reference.note })
          })
        )
      } catch {
        // An input that has been deleted or replaced simply has no handle; the
        // job itself is still readable (spec section 4.2).
      }
    }

    return references
  }

  #assertJobId(jobId: string): void {
    if (!isValidJobId(jobId)) {
      throw new JobError('INVALID_REQUEST', 'That is not a job ID this app could have created.')
    }
  }
}

// ---------------------------------------------------------------------------
// Reading a job directory
// ---------------------------------------------------------------------------

/**
 * Every job ID with a directory in the workspace, in directory order.
 *
 * A directory whose name is not a valid job ID is skipped rather than reported:
 * the workspace is a local folder the user can put anything into, and nothing
 * that fails the pattern of spec section 6.1 may become a path this app builds.
 */
export async function listJobIds(workspace: string | WorkspaceLayout): Promise<string[]> {
  const layout = typeof workspace === 'string' ? workspaceLayout(workspace) : workspace

  let entries

  try {
    entries = await readdir(layout.jobs, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }

  return entries
    .filter((entry) => entry.isDirectory() && isValidJobId(entry.name))
    .map((entry) => entry.name)
}

/** `job.json`, or `null` when it is absent or does not match the schema. */
export async function readJobPacket(directory: string): Promise<JobPacket | null> {
  let raw: string

  try {
    raw = await readFile(join(directory, JOB_FILE_NAME), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const packet = JobPacketSchema.safeParse(parsed)

  return packet.success ? packet.data : null
}

/** Reveals a path in Explorer or Finder. Electron is loaded only here. */
export async function revealInFolder(absPath: string): Promise<void> {
  const { shell } = await import('electron')

  shell.showItemInFolder(absPath)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Spec section 7.2: every executor field is null when Codex never ran. */
function nullExecutor(): ResultExecutor {
  return { codexVersion: null, executable: null, exitCode: null, signal: null }
}

/**
 * A resolved executable that then refused to start.
 *
 * `ENOENT` means the file went away between preflight and Generate, which is
 * exactly what `CODEX_NOT_FOUND` describes (spec section 7.4); anything else is
 * a run that failed before it produced anything.
 */
function spawnFailure(run: CodexRunOutcome): { code: ResultErrorCode; message: string } {
  return run.spawnError?.code === 'ENOENT'
    ? {
        code: 'CODEX_NOT_FOUND',
        message: 'The Codex executable could not be started; check the path in settings.'
      }
    : {
        code: 'GENERATION_FAILED',
        message: `Codex could not be started (${run.spawnError?.code ?? 'unknown error'}).`
      }
}

/**
 * Spec section 12: a job with no `result.json` that main is not running shows
 * as `failed`. `recoverInterruptedJobs` writes that result at startup; this
 * covers the window before it has, and a result file that went missing later.
 */
function summaryState(result: Result | null, live: ProgressEmitter | undefined): RunState {
  if (result !== null) {
    return result.status
  }

  return live?.state ?? 'failed'
}

function summaryErrorCode(
  result: Result | null,
  live: ProgressEmitter | undefined
): ResultErrorCode | null {
  if (result !== null) {
    return result.error?.code ?? null
  }

  return live === undefined ? 'INTERRUPTED' : null
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
