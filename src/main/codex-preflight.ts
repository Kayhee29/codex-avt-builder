/**
 * Codex preflight (plan Task 3.2, spec section 5.3).
 *
 * Before a job runs, the main process checks three things in order and stops at
 * the first failure:
 *
 * | Step               | Command              | Failure                       |
 * | ------------------ | -------------------- | ----------------------------- |
 * | resolve executable | —                    | `CODEX_NOT_FOUND`             |
 * | version            | `<codex> --version`  | `CODEX_VERSION_UNSUPPORTED`   |
 * | login              | `<codex> login status` | `CODEX_NOT_AUTHENTICATED`   |
 *
 * Neither command calls `codex exec`, so preflight never consumes a generation
 * (spec section 5.3). Both run with the allowlisted child environment of
 * `./codex-resolver.ts`, so no secret from the developer's shell is handed to
 * Codex; authentication is Codex's own login and nothing else (spec section 2).
 *
 * The result is cached for the app session and `system.preflight({ force:
 * true })` runs it again (plan decision Q7). `PreflightResult` is exactly the
 * IPC payload declared in `src/shared/ipc-contract.ts`; the launcher travels
 * beside it in {@link PreflightOutcome} because the runner of plan Task 3.5
 * needs `prefixArgs` and the renderer must never see them.
 *
 * Failure messages carry no absolute path. The one exception comes straight
 * from `CodexResolveError`: when the user's own `codexExecutable` setting is
 * what failed, the message names that path, because the renderer already has it
 * from `system.getSettings` and cannot fix the setting blind.
 *
 * Node built-ins are allowed here; Electron is not imported at all.
 */
import { spawn } from 'node:child_process'

import {
  CODEX_MIN_VERSION,
  isCodexVersionSupported,
  parseCodexVersion
} from '../shared/codex-version.ts'
import type { PreflightResult } from '../shared/ipc-contract.ts'

import {
  CodexResolveError,
  minimalCodexEnv,
  resolveCodexExecutable,
  type CodexLauncher
} from './codex-resolver.ts'

/** Spec section 5.3 gives each preflight command ten seconds. */
export const PREFLIGHT_TIMEOUT_MS = 10_000

/** Enough of a `--version` line to read; anything past this is dropped. */
export const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024

/** What one preflight command did. Nothing here ever throws. */
export interface CodexCommandResult {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** The command outlived its timeout and was killed. */
  readonly timedOut: boolean
  /** The process could not be started at all. */
  readonly spawnError: NodeJS.ErrnoException | null
}

/** Runs one Codex command. Injected so a test can drive preflight in memory. */
export type RunCodexCommand = (
  launcher: CodexLauncher,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env: Record<string, string> }
) => Promise<CodexCommandResult>

export interface CodexPreflightOptions {
  /** `Settings.codexExecutable`, handed to the resolver (spec section 5.3). */
  readonly codexExecutable?: string | null
  /** Skips resolution. The Playwright harness of plan Task 6.1 uses this. */
  readonly launcher?: CodexLauncher
  /** Defaults to {@link runCodexCommand}. */
  readonly run?: RunCodexCommand
  /** Defaults to {@link PREFLIGHT_TIMEOUT_MS}, per command. */
  readonly timeoutMs?: number
  /** Defaults to {@link CODEX_MIN_VERSION}. */
  readonly minVersion?: string
  /** Defaults to `process.env`; only the allowlist reaches the child. */
  readonly env?: Readonly<Partial<Record<string, string>>>
  /** Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

/**
 * The preflight result plus how to start Codex.
 *
 * `result` is what crosses IPC. `launcher` is main-process-only and is `null`
 * whenever `result.ok` is false.
 */
export interface PreflightOutcome {
  readonly result: PreflightResult
  readonly launcher: CodexLauncher | null
}

/**
 * Runs the three checks once.
 *
 * Which failure gets which code follows the table in spec section 5.3, with one
 * judgement call the spec leaves open: a file that cannot be started, does not
 * answer `--version`, or never answers within the timeout is reported as
 * `CODEX_NOT_FOUND` rather than `CODEX_VERSION_UNSUPPORTED`, because it is not
 * a working Codex executable at all. `CODEX_VERSION_UNSUPPORTED` is reserved
 * for a CLI that answered — with a version below the minimum, or with output no
 * version can be read from.
 */
export async function runCodexPreflight(
  options: CodexPreflightOptions = {}
): Promise<PreflightOutcome> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const run = options.run ?? runCodexCommand
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS
  const minVersion = options.minVersion ?? CODEX_MIN_VERSION
  const childEnv = minimalCodexEnv(env, platform)

  let launcher: CodexLauncher

  if (options.launcher !== undefined) {
    launcher = options.launcher
  } else {
    try {
      launcher = await resolveCodexExecutable({
        platform,
        env,
        ...(options.codexExecutable === undefined
          ? {}
          : { codexExecutable: options.codexExecutable })
      })
    } catch (error) {
      if (error instanceof CodexResolveError) {
        return failed('CODEX_NOT_FOUND', error.message)
      }

      throw error
    }
  }

  const version = await run(launcher, ['--version'], { timeoutMs, env: childEnv })
  const unreachable = describeUnreachable(version, '--version', timeoutMs)

  if (unreachable !== null) {
    return failed('CODEX_NOT_FOUND', unreachable)
  }

  if (version.code !== 0) {
    return failed(
      'CODEX_NOT_FOUND',
      `The Codex executable exited with code ${String(version.code)} instead of printing its version. It does not look like a working Codex CLI.`
    )
  }

  const reported = parseCodexVersion(version.stdout) ?? parseCodexVersion(version.stderr)

  if (reported === null) {
    return failed(
      'CODEX_VERSION_UNSUPPORTED',
      `Could not read a version from \`codex --version\`. This app needs Codex CLI ${minVersion} or newer.`
    )
  }

  if (!isCodexVersionSupported(reported, minVersion)) {
    return failed(
      'CODEX_VERSION_UNSUPPORTED',
      `Codex CLI ${reported} is installed, but image generation needs ${minVersion} or newer. Run \`npm install -g @openai/codex@latest\`.`
    )
  }

  const login = await run(launcher, ['login', 'status'], { timeoutMs, env: childEnv })
  const loginUnreachable = describeUnreachable(login, 'login status', timeoutMs)

  if (loginUnreachable !== null) {
    return failed('CODEX_NOT_FOUND', loginUnreachable)
  }

  if (login.code !== 0) {
    return failed(
      'CODEX_NOT_AUTHENTICATED',
      'Codex CLI is not signed in. Run `codex login` in a terminal, then check again.'
    )
  }

  return {
    result: { ok: true, version: reported, executable: launcher.command },
    launcher
  }
}

/**
 * The per-session cache of plan decision Q7.
 *
 * One instance lives in the main process. `run()` answers from the cache;
 * `run({ force: true })` runs the checks again, which is what the preflight
 * banner's retry button and `system.preflight({ force: true })` call. Two
 * concurrent callers share one run rather than starting two.
 */
export class CodexPreflight {
  readonly #options: CodexPreflightOptions
  #cached: PreflightOutcome | null = null
  #inFlight: Promise<PreflightOutcome> | null = null

  constructor(options: CodexPreflightOptions = {}) {
    this.#options = options
  }

  /** The last outcome, or `null` when preflight has not run this session. */
  get cached(): PreflightOutcome | null {
    return this.#cached
  }

  async run(request: { readonly force?: boolean } = {}): Promise<PreflightOutcome> {
    if (request.force === true) {
      this.clear()
    } else if (this.#cached !== null) {
      return this.#cached
    }

    this.#inFlight ??= runCodexPreflight(this.#options)
      .then((outcome) => {
        this.#cached = outcome

        return outcome
      })
      .finally(() => {
        this.#inFlight = null
      })

    return this.#inFlight
  }

  /** Forgets the cached outcome; the next `run()` checks again. */
  clear(): void {
    this.#cached = null
  }
}

/**
 * Spawns one Codex command and collects what it printed.
 *
 * `shell: false` and an argument array, like every other Codex call in this app
 * (spec section 11). Output is capped so a chatty binary cannot fill memory,
 * and the timeout kills the child and resolves rather than hanging the app —
 * a Codex that never answers `--version` must not be able to freeze Generate.
 */
export async function runCodexCommand(
  launcher: CodexLauncher,
  args: readonly string[],
  options: { readonly timeoutMs: number; readonly env: Record<string, string> }
): Promise<CodexCommandResult> {
  return new Promise<CodexCommandResult>((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      spawnError: NodeJS.ErrnoException | null
    ): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, timedOut, spawnError })
    }

    let child

    try {
      child = spawn(launcher.command, [...launcher.prefixArgs, ...args], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // The allowlist first, then whatever the injected launcher adds. In
        // production `launcher.env` is absent, so this is the allowlist alone.
        env: { ...options.env, ...launcher.env }
      })
    } catch (error) {
      return finish(null, null, error as NodeJS.ErrnoException)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(null, null, null)
    }, options.timeoutMs)

    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = capture(stdout, chunk)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr = capture(stderr, chunk)
    })
    child.on('error', (error) => {
      finish(null, null, error as NodeJS.ErrnoException)
    })
    child.on('close', (code, signal) => {
      finish(code, signal, null)
    })
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failed(
  code: 'CODEX_NOT_FOUND' | 'CODEX_VERSION_UNSUPPORTED' | 'CODEX_NOT_AUTHENTICATED',
  message: string
): PreflightOutcome {
  return { result: { ok: false, code, message }, launcher: null }
}

/**
 * A sentence when the command never really ran, `null` when it did. The
 * executable path is deliberately absent: the message crosses to the renderer.
 */
function describeUnreachable(
  result: CodexCommandResult,
  label: string,
  timeoutMs: number
): string | null {
  if (result.timedOut) {
    return `Codex CLI did not answer \`${label}\` within ${String(Math.round(timeoutMs / 1000))} seconds and was stopped.`
  }

  if (result.spawnError !== null) {
    return result.spawnError.code === 'ENOENT'
      ? 'The Codex executable could not be found where it was expected.'
      : `The Codex executable could not be started (${result.spawnError.code ?? 'unknown error'}).`
  }

  return null
}

function capture(buffer: string, chunk: string): string {
  return buffer.length >= MAX_CAPTURED_OUTPUT_BYTES
    ? buffer
    : (buffer + chunk).slice(0, MAX_CAPTURED_OUTPUT_BYTES)
}
