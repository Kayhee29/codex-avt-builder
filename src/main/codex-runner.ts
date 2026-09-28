/**
 * Running `codex exec` for one job (plan Task 3.5, spec sections 5.3 and 5.5).
 *
 * This is the only place in the app that starts Codex. Everything spec section
 * 11 requires of that call is a property of this file:
 *
 * - `spawn` with an argument array and `shell: false`, never a shell string;
 * - the working directory is the job directory, so the `workspace-write`
 *   sandbox cannot reach `src/`, another job, a preset or an anchor;
 * - the child environment is the allowlist {@link minimalCodexEnv} builds, so
 *   `OPENAI_API_KEY` and every other secret in the developer's shell stay out;
 * - the only user-derived value on the command line is the job ID, and it is
 *   validated against the pattern of spec section 6.1 before it gets there.
 *   Subject name, notes and the prompt itself never appear: Codex reads them
 *   from `prompt.md` and `job.json` inside the job directory.
 *
 * What comes out is three files in the job directory and a stream of
 * {@link ProgressEvent}s:
 *
 * ```text
 * events.jsonl      studio.meta, then every line Codex wrote (spec 5.5)
 * stderr.log        stderr verbatim, never shown to the user unsanitized
 * last-message.txt  written by Codex itself via --output-last-message
 * ```
 *
 * **This module decides no outcome.** It reports how the process ended; whether
 * that is a success is the verifier's job (spec section 5.6, plan Task 3.6) and
 * the run state is the orchestrator's (plan Task 3.7). A zero exit code means
 * nothing on its own.
 *
 * Node built-ins are allowed here; Electron is not imported at all.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'

import { isValidJobId } from '../shared/job-id.ts'
import { ProgressEventSchema, type ProgressEvent, type RunState } from '../shared/progress.ts'

import { minimalCodexEnv, type CodexLauncher } from './codex-resolver.ts'
import { createLineSplitter, eventLogLine, normalizeCodexLine } from './jsonl-normalizer.ts'

/** The raw Codex stream, first line written by main (spec section 5.5). */
export const EVENTS_FILE_NAME = 'events.jsonl'

/** Codex's stderr, kept for diagnosis and never displayed raw (spec 5.5). */
export const STDERR_FILE_NAME = 'stderr.log'

/** What `--output-last-message` points at (spec section 5.3). */
export const LAST_MESSAGE_FILE_NAME = 'last-message.txt'

/** The `type` of the line main writes before Codex says anything (spec 5.5). */
export const STUDIO_META_EVENT_TYPE = 'studio.meta'

/** How much stderr is kept in memory for the verifier's sandbox check. */
export const MAX_STDERR_MEMORY_BYTES = 64 * 1024

/**
 * The fixed orchestration instruction of spec section 5.4.
 *
 * `{{jobId}}` is the only thing that varies, and it is a job ID that has
 * already passed {@link isValidJobId}. Nothing the user typed is in here.
 */
export const ORCHESTRATION_INSTRUCTION = [
  'You are executing Reference Image Studio job {{jobId}}.',
  'The current working directory is the job directory. Read run-instructions.md, job.json and prompt.md.',
  'The images attached to this message are the references listed in job.json, in the same order.',
  'Do not read files outside this directory except the Codex image-generation output folder.',
  "Do not reinterpret or expand the user's creative intent.",
  'Generate the images with the built-in image_gen tool using the attached references and prompt.md.',
  'Copy every generated image into outputs/ and write codex-result.json matching the project schema.',
  'Do not call external APIs, do not use API keys, and do not enable network access.',
  'If image generation is unavailable, write a failed codex-result.json and stop.'
].join('\n')

/** The placeholder {@link buildOrchestrationInstruction} replaces. */
export const JOB_ID_PLACEHOLDER = '{{jobId}}'

/** Why {@link CodexRunner.start} refused, using the codes of spec section 7.4. */
export type CodexRunErrorCode = 'ALREADY_RUNNING' | 'INVALID_JOB'

/**
 * Thrown before a process exists. Once Codex has started, failures are reported
 * in {@link CodexRunOutcome} instead, because a run that produced log files must
 * not disappear into an exception.
 *
 * The message is short, user-facing and carries no absolute path
 * (spec section 11).
 */
export class CodexRunError extends Error {
  readonly code: CodexRunErrorCode

  constructor(code: CodexRunErrorCode, message: string) {
    super(message)
    this.name = 'CodexRunError'
    this.code = code
  }
}

/** Where a {@link ProgressEmitter} sends what it built. */
export type ProgressSink = (event: ProgressEvent) => void

/**
 * The one counter behind `ProgressEvent.seq` for a whole run.
 *
 * Spec section 5.5 wants a sequence number that rises across the run, and a run
 * spans the orchestrator's state changes (plan Task 3.7) and this module's
 * activity lines. One emitter is therefore created per job and handed down, so
 * both share the counter and the UI can drop a late event by number alone.
 */
export class ProgressEmitter {
  readonly #jobId: string
  readonly #sink: ProgressSink | undefined
  readonly #now: () => Date
  #seq = 0
  #state: RunState = 'queued'

  constructor(jobId: string, sink?: ProgressSink | undefined, now: () => Date = () => new Date()) {
    if (!isValidJobId(jobId)) {
      throw new CodexRunError('INVALID_JOB', 'That job ID is not one this app could have created.')
    }

    this.#jobId = jobId
    this.#sink = sink
    this.#now = now
  }

  /** The state the last event carried. */
  get state(): RunState {
    return this.#state
  }

  /** How many events have been emitted so far. */
  get count(): number {
    return this.#seq
  }

  /** Emits a state change, optionally with display text (spec section 5.5). */
  emit(state: RunState, activity?: string): ProgressEvent {
    this.#state = state

    const event = ProgressEventSchema.parse({
      jobId: this.#jobId,
      state,
      ...(activity === undefined ? {} : { activity }),
      seq: this.#seq,
      at: this.#now().toISOString()
    })

    this.#seq += 1
    this.#sink?.(event)

    return event
  }

  /** Emits display text without changing the state (spec section 12). */
  emitActivity(activity: string): ProgressEvent {
    return this.emit(this.#state, activity)
  }
}

export interface CodexRunRequest {
  readonly jobId: string
  /** Absolute path of `workspace/jobs/<job-id>`; also the child's cwd. */
  readonly jobDir: string
  /**
   * Absolute paths of the copied references, already in role order. They become
   * the repeated `-i` arguments of spec section 5.3, in this exact order, which
   * is the order `job.json` and the Image A/B labels in `prompt.md` use.
   */
  readonly inputPaths: readonly string[]
  readonly launcher: CodexLauncher
  /** Written into the `studio.meta` line; `null` when preflight did not say. */
  readonly codexVersion?: string | null
  /** Shared with the orchestrator so `seq` rises across the whole run. */
  readonly progress?: ProgressEmitter
  /** Defaults to `process.env`; only the allowlist reaches the child. */
  readonly env?: Readonly<Partial<Record<string, string>>>
  /** Defaults to `process.platform`. Injected so the tests are explicit. */
  readonly platform?: NodeJS.Platform
}

/** How one run ended. Nothing here says whether the job succeeded. */
export interface CodexRunOutcome {
  readonly jobId: string
  readonly exitCode: number | null
  readonly signal: string | null
  /** True when {@link CodexRunner.cancel} killed this run. */
  readonly cancelled: boolean
  /** Every argument after the executable, exactly as spawned. */
  readonly args: readonly string[]
  readonly startedAt: string
  readonly completedAt: string
  /** The process could not be started at all; no Codex ever ran. */
  readonly spawnError: NodeJS.ErrnoException | null
  /** The first {@link MAX_STDERR_MEMORY_BYTES} of stderr, for diagnosis. */
  readonly stderr: string
}

/**
 * The command line of spec section 5.3, as an argument array.
 *
 * ```text
 * <prefixArgs…> exec --json --sandbox workspace-write --skip-git-repo-check
 *   -C <job directory>
 *   -i <inputs/…>            (repeated, in role order)
 *   --output-last-message <job directory>/last-message.txt
 *   <fixed orchestration instruction>
 * ```
 *
 * `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`,
 * `--sandbox danger-full-access` and
 * `-c sandbox_workspace_write.network_access=true` are forbidden by spec
 * section 5.3 and never appear here, not even as a fallback when the sandbox
 * fails.
 */
export function buildCodexArgs(request: {
  readonly jobId: string
  readonly jobDir: string
  readonly inputPaths: readonly string[]
  readonly launcher: Pick<CodexLauncher, 'prefixArgs'>
}): string[] {
  const instruction = buildOrchestrationInstruction(request.jobId)

  return [
    ...request.launcher.prefixArgs,
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '--skip-git-repo-check',
    '-C',
    request.jobDir,
    ...request.inputPaths.flatMap((path) => ['-i', path]),
    '--output-last-message',
    join(request.jobDir, LAST_MESSAGE_FILE_NAME),
    instruction
  ]
}

/**
 * The instruction of spec section 5.4 with the job ID filled in.
 *
 * The job ID is validated here rather than trusted, because this is the one
 * string that crosses from user data onto a command line (spec section 11).
 */
export function buildOrchestrationInstruction(jobId: string): string {
  if (!isValidJobId(jobId)) {
    throw new CodexRunError(
      'INVALID_JOB',
      'That job ID is not one this app could have created, so it will not be run.'
    )
  }

  return ORCHESTRATION_INSTRUCTION.split(JOB_ID_PLACEHOLDER).join(jobId)
}

/**
 * Kills a process and everything it started (plan decision Q12).
 *
 * Codex spawns children of its own — the sandbox helper and every shell command
 * it runs — so killing the process alone would leave them holding the job
 * directory open. On Windows that means `taskkill /T /F`, which a child cannot
 * intercept; elsewhere the child was spawned `detached`, so it leads its own
 * process group and one signal to `-pid` reaches all of it.
 *
 * Best effort by design: a process that has already exited makes every one of
 * these calls fail, and that is not an error worth propagating.
 */
export function killProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Partial<Record<string, string>>> = process.env
): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }

  if (platform === 'win32') {
    try {
      const child = spawn(taskkillPath(env), ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })

      child.on('error', () => {
        // taskkill is missing or the process is already gone; nothing to do.
      })
      child.unref()
    } catch {
      // Same: the tree is either gone or unreachable.
    }

    return
  }

  try {
    // Negative pid: the whole process group created by `detached: true`.
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
}

/** One in-flight run. Held only so {@link CodexRunner.cancel} can find it. */
interface RunHandle {
  readonly child: ChildProcess
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Partial<Record<string, string>>>
  cancelled: boolean
}

/**
 * Starts Codex for a job and streams what it says.
 *
 * One instance lives in the main process. It remembers which jobs are running,
 * which is what makes the second `start` of spec section 10 refusable and what
 * `jobs.cancel` and the "still running" check on window close (plan Task 5.6)
 * ask.
 */
export class CodexRunner {
  readonly #runs = new Map<string, RunHandle>()

  /** The job IDs running right now. */
  get running(): readonly string[] {
    return [...this.#runs.keys()]
  }

  isRunning(jobId: string): boolean {
    return this.#runs.has(jobId)
  }

  /**
   * Runs `codex exec` to completion.
   *
   * Resolves when the process has exited and both log files are closed, so a
   * caller may read `events.jsonl` immediately afterwards. It rejects only
   * before a process exists — a refused second start (spec section 10) or an
   * invalid job ID; a Codex that fails to spawn resolves with `spawnError` set,
   * because by then `events.jsonl` exists and the run has to be reported, not
   * thrown away.
   */
  async start(request: CodexRunRequest): Promise<CodexRunOutcome> {
    if (this.#runs.has(request.jobId)) {
      throw new CodexRunError(
        'ALREADY_RUNNING',
        'This job is already running; wait for it to finish or cancel it first.'
      )
    }

    const platform = request.platform ?? process.platform
    const env = request.env ?? process.env
    const args = buildCodexArgs(request)
    const progress = request.progress
    const startedAt = new Date().toISOString()
    const events = createWriteStream(join(request.jobDir, EVENTS_FILE_NAME), {
      // Append: spec section 10 forbids deleting a job's logs, and a rerun of
      // the same directory must add to the record rather than erase it.
      flags: 'a',
      encoding: 'utf8'
    })
    const stderrLog = createWriteStream(join(request.jobDir, STDERR_FILE_NAME), {
      flags: 'a',
      encoding: 'utf8'
    })

    // Spec section 5.5: the first line is main's own, so a reader knows which
    // Codex version and which command produced the rest of the file.
    events.write(
      `${JSON.stringify({
        type: STUDIO_META_EVENT_TYPE,
        codexVersion: request.codexVersion ?? null,
        executable: request.launcher.command,
        args
      })}\n`
    )

    let child: ChildProcess

    try {
      child = spawn(request.launcher.command, args, {
        cwd: request.jobDir,
        // Spec section 11. Never `shell: true`, whatever stops working.
        shell: false,
        windowsHide: true,
        // Plan decision Q12: a process group to signal on POSIX. Windows has
        // no process groups for this, and `detached` there would open a new
        // console window, so the tree is killed with `taskkill /T /F` instead.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // The allowlist first, then whatever an injected launcher adds. In
        // production `launcher.env` is absent, so this is the allowlist alone.
        env: { ...minimalCodexEnv(env, platform), ...request.launcher.env }
      })
    } catch (error) {
      await closeStreams(events, stderrLog)

      return {
        jobId: request.jobId,
        exitCode: null,
        signal: null,
        cancelled: false,
        args,
        startedAt,
        completedAt: new Date().toISOString(),
        spawnError: error as NodeJS.ErrnoException,
        stderr: ''
      }
    }

    const handle: RunHandle = { child, platform, env, cancelled: false }

    this.#runs.set(request.jobId, handle)

    try {
      const ended = await this.#pump(child, events, stderrLog, progress)

      return {
        jobId: request.jobId,
        exitCode: ended.code,
        signal: ended.signal,
        cancelled: handle.cancelled,
        args,
        startedAt,
        completedAt: new Date().toISOString(),
        spawnError: ended.spawnError,
        stderr: ended.stderr
      }
    } finally {
      this.#runs.delete(request.jobId)
      await closeStreams(events, stderrLog)
    }
  }

  /**
   * Ends a running job and everything it started (plan decision Q12).
   *
   * Returns whether a run was found. The promise from {@link start} still
   * resolves normally, with `cancelled: true`, once the process is gone.
   */
  cancel(jobId: string): boolean {
    const handle = this.#runs.get(jobId)

    if (handle === undefined) {
      return false
    }

    handle.cancelled = true

    const pid = handle.child.pid

    if (pid === undefined) {
      // The process never got an id; killing the handle is all that is left.
      handle.child.kill('SIGKILL')

      return true
    }

    killProcessTree(pid, handle.platform, handle.env)

    return true
  }

  /** Cancels every running job. Plan Task 5.6 calls this on window close. */
  cancelAll(): readonly string[] {
    const cancelled: string[] = []

    for (const jobId of this.running) {
      if (this.cancel(jobId)) {
        cancelled.push(jobId)
      }
    }

    return cancelled
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Reads both pipes until the process closes.
   *
   * Every stdout line goes to `events.jsonl` through
   * {@link eventLogLine}, which keeps the file valid JSONL even when Codex
   * writes something that is not JSON (spec section 5.5). A line that produced
   * display text also becomes a `running` progress event; an unparsed or
   * unknown line is logged and nothing more, and never fails the job.
   */
  async #pump(
    child: ChildProcess,
    events: WriteStream,
    stderrLog: WriteStream,
    progress: ProgressEmitter | undefined
  ): Promise<{
    code: number | null
    signal: string | null
    spawnError: NodeJS.ErrnoException | null
    stderr: string
  }> {
    const splitter = createLineSplitter()
    let stderr = ''

    const handleLine = (line: string): void => {
      const normalized = normalizeCodexLine(line)

      if (normalized === null) {
        return
      }

      events.write(`${eventLogLine(normalized)}\n`)

      if (normalized.kind === 'activity') {
        progress?.emitActivity(normalized.activity)
      }
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) {
        handleLine(line)
      }
    })

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderrLog.write(chunk)

      if (stderr.length < MAX_STDERR_MEMORY_BYTES) {
        stderr = (stderr + chunk).slice(0, MAX_STDERR_MEMORY_BYTES)
      }
    })

    return new Promise((resolvePromise) => {
      let spawnError: NodeJS.ErrnoException | null = null

      child.on('error', (error) => {
        spawnError = error as NodeJS.ErrnoException
      })

      child.on('close', (code, signal) => {
        for (const line of splitter.flush()) {
          handleLine(line)
        }

        resolvePromise({ code, signal, spawnError, stderr })
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `taskkill.exe` under `%SystemRoot%\System32` when the environment says where
 * that is, and the bare name otherwise.
 *
 * Naming the full path matters: this app never runs a command through a shell,
 * so a `taskkill` planted earlier on `PATH` would otherwise be what gets
 * started. The argument list is a pid and two fixed flags; nothing user-derived
 * is anywhere near it.
 */
function taskkillPath(env: Readonly<Partial<Record<string, string>>>): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir']

  return systemRoot === undefined || systemRoot.trim() === ''
    ? 'taskkill.exe'
    : join(systemRoot, 'System32', 'taskkill.exe')
}

/** Ends both log streams and waits for the bytes to reach the disk. */
async function closeStreams(...streams: readonly WriteStream[]): Promise<void> {
  for (const stream of streams) {
    stream.end()

    try {
      await finished(stream)
    } catch {
      // A stream that failed to close leaves the log short; the run itself is
      // still reportable and must not be lost to this.
    }
  }
}
