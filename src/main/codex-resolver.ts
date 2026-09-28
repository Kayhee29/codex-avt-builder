/**
 * Finding the real Codex executable (plan Task 3.1, spec section 5.3).
 *
 * This module exists because of one Windows detail. The `codex` on `PATH` after
 * `npm install -g @openai/codex` is `codex.cmd`, a shim that runs `node
 * .../bin/codex.js`, which in turn runs the real binary
 * `codex-x86_64-pc-windows-msvc.exe`. `child_process.spawn` with `shell: false`
 * cannot execute a `.cmd` at all — it fails with `ENOENT` — and spec section
 * 5.3 forbids turning `shell: true` on to get around it. So the app resolves
 * the real executable itself:
 *
 * 1. the path the user configured in settings, if any;
 * 2. the binary inside the npm-global `@openai/codex` package;
 * 3. `codex` on `PATH`, and only when that is a real executable.
 *
 * On Windows the resolved file must end in `.exe`; `.cmd`, `.bat` and `.ps1`
 * are refused, which is the entire point. On macOS and Linux it must be a
 * regular file with an execute bit.
 *
 * What comes out is the launcher of plan decision Q8, `{ command, prefixArgs,
 * source }`. Production always gets `prefixArgs: []`; the tests build their own
 * launcher pointing at `tests/fake-codex/fake-codex.mjs` and never come through
 * here.
 *
 * Node built-ins are allowed here; Electron is not imported at all.
 */
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path'

/** Which of the three steps of spec section 5.3 produced the executable. */
export type CodexExecutableSource = 'settings' | 'npm-global' | 'path'

/**
 * How the Codex runner of plan Task 3.5 starts a process (decision Q8).
 *
 * `prefixArgs` is always empty in production and holds the fake's script path
 * in tests, so `exec --json …` can be appended the same way in both and a test
 * can assert the exact argv without needing a real `.exe`.
 *
 * `env` exists for the same reason. The child's environment is the allowlist
 * {@link minimalCodexEnv} builds, which deliberately drops everything the
 * allowlist does not name — including the `FAKE_CODEX_*` variables that script
 * the fake of plan Task 3.3. Rather than writing test-only variable names into
 * a production allowlist, the extra variables ride on the injected launcher:
 * whoever builds a fake launcher supplies them, and the launcher
 * {@link resolveCodexExecutable} returns never has any. It is merged on top of
 * the allowlist, so it can also be used to pin `CODEX_HOME` for a test run.
 */
export interface CodexLauncher {
  readonly command: string
  readonly prefixArgs: readonly string[]
  readonly source: CodexExecutableSource
  /** Merged on top of {@link minimalCodexEnv}; empty in production. */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * Thrown when no real executable was found (spec section 7.4,
 * `CODEX_NOT_FOUND`).
 *
 * `message` is short and user-facing. It names an absolute path in exactly one
 * case: when the user's own `codexExecutable` setting is the thing that failed.
 * That path is not a secret — the renderer already receives it from
 * `system.getSettings` — and the user cannot fix the setting without seeing
 * which path was refused. Every other path that was tried stays in
 * {@link attempts}, which the main process logs and writes into `events.jsonl`
 * for diagnosis (spec section 5.3) and never sends to the renderer.
 */
export class CodexResolveError extends Error {
  readonly code = 'CODEX_NOT_FOUND' as const
  /** Every absolute path that was probed, in the order they were probed. */
  readonly attempts: readonly string[]

  constructor(message: string, attempts: readonly string[]) {
    super(message)
    this.name = 'CodexResolveError'
    this.attempts = [...attempts]
  }
}

/** File extensions Windows treats as executable but `spawn` cannot run. */
export const REJECTED_WINDOWS_EXTENSIONS = ['.cmd', '.bat', '.ps1'] as const

/** How long {@link npmGlobalPrefixes} waits for `npm prefix -g`. */
export const NPM_PREFIX_TIMEOUT_MS = 5_000

export interface ResolveCodexOptions {
  /** `Settings.codexExecutable`; the first place spec section 5.3 looks. */
  readonly codexExecutable?: string | null
  /** Defaults to `process.platform`. Injected so the tests are cross-platform. */
  readonly platform?: NodeJS.Platform
  /** Defaults to `process.arch`. */
  readonly arch?: string
  /** Defaults to `process.env`; supplies `PATH`, `APPDATA` and `ComSpec`. */
  readonly env?: Readonly<Partial<Record<string, string>>>
  /**
   * Where npm keeps global packages. Defaults to {@link npmGlobalPrefixes},
   * which spawns `npm prefix -g`; the tests inject a temp directory instead so
   * no child process runs.
   */
  readonly npmPrefixes?: () => Promise<readonly string[]>
}

/**
 * Resolves the Codex executable, or throws {@link CodexResolveError}.
 *
 * A configured override that does not work is an error and does not fall
 * through to the other two steps: the user asked for that specific file, and
 * silently running a different one would hide the mistake.
 */
export async function resolveCodexExecutable(
  options: ResolveCodexOptions = {}
): Promise<CodexLauncher> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const env = options.env ?? process.env
  const attempts: string[] = []

  const configured = options.codexExecutable?.trim()

  if (configured !== undefined && configured !== '') {
    const candidate = resolve(configured)

    attempts.push(candidate)

    const problem = await describeCandidate(candidate, platform)

    if (problem !== null) {
      throw new CodexResolveError(
        `The Codex executable configured in settings cannot be used: ${candidate} ${problem}`,
        attempts
      )
    }

    return { command: candidate, prefixArgs: [], source: 'settings' }
  }

  const npmPrefixes = options.npmPrefixes ?? (() => npmGlobalPrefixes(platform, env))

  for (const candidate of packageCandidates(await npmPrefixes(), platform, arch)) {
    attempts.push(candidate)

    if (await isUsableExecutable(candidate, platform)) {
      return { command: candidate, prefixArgs: [], source: 'npm-global' }
    }
  }

  for (const candidate of pathCandidates(env, platform)) {
    attempts.push(candidate)

    if (await isUsableExecutable(candidate, platform)) {
      return { command: candidate, prefixArgs: [], source: 'path' }
    }
  }

  throw new CodexResolveError(
    platform === 'win32'
      ? 'Codex CLI was not found. The `codex` on PATH is the npm `codex.cmd` shim, which cannot be started directly; install @openai/codex globally or set the path to codex-*.exe in settings.'
      : 'Codex CLI was not found. Install @openai/codex globally or set the path to the executable in settings.',
    attempts
  )
}

/**
 * The environment a Codex child process gets (spec section 5.3, plan Task 3.5).
 *
 * An allowlist rather than a denylist: only the variables named below are
 * passed on, so `OPENAI_API_KEY` and every other secret in the developer's
 * shell stay out by construction rather than by remembering to filter them.
 * Authentication is Codex's own login, never an API key handed over by this
 * app (spec section 2).
 *
 * `CODEX_HOME` is forwarded because that is where `image_gen` writes and where
 * the login lives; `HOME` and `USERPROFILE` are forwarded so Codex can find
 * `~/.codex` when `CODEX_HOME` is unset.
 */
export function minimalCodexEnv(
  env: Readonly<Partial<Record<string, string>>> = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const names =
    platform === 'win32'
      ? [...SHARED_ENV_NAMES, ...WINDOWS_ENV_NAMES]
      : [...SHARED_ENV_NAMES, ...POSIX_ENV_NAMES]
  const result: Record<string, string> = {}

  for (const name of names) {
    const value = env[name]

    if (value !== undefined) {
      result[name] = value
    }
  }

  return result
}

/**
 * Global npm prefixes, best effort and never throwing.
 *
 * `npm prefix -g` is asked first, as the plan's Task 3.1 says, then the
 * locations that can be derived from the environment without a child process.
 * On Windows npm itself is a `.cmd`, so it is run through `%ComSpec% /d /s /c`
 * with a fixed argument list; nothing user-supplied is anywhere near that
 * command line (spec section 11).
 */
export async function npmGlobalPrefixes(
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Partial<Record<string, string>>> = process.env
): Promise<readonly string[]> {
  const prefixes: string[] = []
  const add = (value: string | undefined): void => {
    if (value === undefined || value.trim() === '') {
      return
    }

    const absolute = resolve(value.trim())

    if (!prefixes.includes(absolute)) {
      prefixes.push(absolute)
    }
  }

  add(await npmPrefixFromCli(platform, env))
  add(env['npm_config_prefix'])

  if (platform === 'win32') {
    const appData = env['APPDATA']

    add(appData === undefined ? undefined : join(appData, 'npm'))
  } else {
    add('/usr/local')

    const home = env['HOME']

    add(home === undefined ? undefined : join(home, '.npm-global'))
  }

  return prefixes
}

/**
 * Every path inside a set of npm prefixes that could hold the real binary, in
 * the order they are probed. Exported so a diagnostic can print the list.
 */
export function packageCandidates(
  prefixes: readonly string[],
  platform: NodeJS.Platform,
  arch: string
): readonly string[] {
  const binaryNames = platformBinaryNames(platform, arch)
  const platformPackage = `codex-${platform}-${arch}`
  const candidates: string[] = []

  for (const prefix of prefixes) {
    // `npm prefix -g` answers `…\Roaming\npm` on Windows and `/usr/local` on
    // macOS and Linux, so both module roots are tried under every prefix.
    for (const modules of [join(prefix, 'node_modules'), join(prefix, 'lib', 'node_modules')]) {
      const mainPackage = join(modules, '@openai', 'codex')
      const packageDirs = [
        mainPackage,
        // Newer releases may ship the binary in a per-platform optional
        // dependency instead of in the main package's `bin/`.
        join(modules, '@openai', platformPackage),
        join(mainPackage, 'node_modules', '@openai', platformPackage)
      ]

      for (const packageDir of packageDirs) {
        for (const name of binaryNames) {
          const candidate = join(packageDir, 'bin', name)

          if (!candidates.includes(candidate)) {
            candidates.push(candidate)
          }
        }
      }
    }
  }

  return candidates
}

/**
 * Where `codex` would be looked up on `PATH`.
 *
 * On Windows only `codex.exe` is probed. The extensionless `codex` shell script
 * and `codex.cmd`, `codex.bat` and `codex.ps1` that npm drops next to it are
 * never candidates, so a machine that has only the shim resolves to nothing and
 * the caller reports `CODEX_NOT_FOUND` instead of failing later with `ENOENT`.
 */
export function pathCandidates(
  env: Readonly<Partial<Record<string, string>>>,
  platform: NodeJS.Platform
): readonly string[] {
  const rawPath = env['PATH'] ?? env['Path'] ?? env['path'] ?? ''
  const fileName = platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates: string[] = []

  for (const entry of rawPath.split(delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, '')

    if (directory === '' || !isAbsolute(directory)) {
      continue
    }

    const candidate = join(directory, fileName)

    if (!candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }

  return candidates
}

/**
 * Whether a path is something `spawn` can start with `shell: false`: a regular
 * file, `.exe` on Windows, with an execute bit elsewhere.
 */
export async function isUsableExecutable(
  candidate: string,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  return (await describeCandidate(candidate, platform)) === null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Variables every platform's Codex process needs. `PATH` is here because Codex
 * shells out; `CODEX_HOME` because that is where its login and its generated
 * images live; `TMPDIR`/`TEMP`/`TMP` because a process without a temp directory
 * misbehaves in ways that are hard to diagnose.
 */
const SHARED_ENV_NAMES = ['PATH', 'CODEX_HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'] as const

const POSIX_ENV_NAMES = ['HOME', 'SHELL', 'USER', 'LOGNAME', 'TERM'] as const

/**
 * Windows needs more of the environment than POSIX does: without `SystemRoot`
 * a process cannot load `ws2_32.dll`, and `PATHEXT` and `ComSpec` are how a
 * child resolves its own subprocesses.
 */
const WINDOWS_ENV_NAMES = [
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'USERNAME',
  'USERDOMAIN'
] as const

/** The file names the `@openai/codex` package uses for this platform. */
function platformBinaryNames(platform: NodeJS.Platform, arch: string): readonly string[] {
  const triple = targetTriple(platform, arch)
  const plain = platform === 'win32' ? 'codex.exe' : 'codex'

  return triple === null ? [plain] : [`codex-${triple}`, plain]
}

/** The Rust target triple in the binary names the package ships. */
function targetTriple(platform: NodeJS.Platform, arch: string): string | null {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : null

  if (cpu === null) {
    return null
  }

  switch (platform) {
    case 'win32':
      return `${cpu}-pc-windows-msvc.exe`
    case 'darwin':
      return `${cpu}-apple-darwin`
    case 'linux':
      return `${cpu}-unknown-linux-musl`
    default:
      return null
  }
}

/**
 * `null` when the candidate is usable, otherwise the tail of a sentence saying
 * why it is not. The wording ends up in {@link CodexResolveError}'s message for
 * the settings override, so it is short and has no second absolute path in it.
 */
async function describeCandidate(
  candidate: string,
  platform: NodeJS.Platform
): Promise<string | null> {
  if (platform === 'win32') {
    const extension = extname(candidate).toLowerCase()

    if (
      REJECTED_WINDOWS_EXTENSIONS.includes(
        extension as (typeof REJECTED_WINDOWS_EXTENSIONS)[number]
      )
    ) {
      return `is an npm shim (${extension}), not the real executable. Point at codex-x86_64-pc-windows-msvc.exe instead.`
    }

    if (extension !== '.exe') {
      return 'is not a .exe. On Windows only a real executable can be started directly.'
    }
  }

  let stats

  try {
    stats = await stat(candidate)
  } catch {
    return 'does not exist.'
  }

  if (!stats.isFile()) {
    return 'is not a file.'
  }

  if (platform !== 'win32' && !(await isExecutableFile(candidate))) {
    return 'is not executable.'
  }

  return null
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK)

    return true
  } catch {
    return false
  }
}

/**
 * `npm prefix -g`, or `undefined` when npm is missing, slow or unhappy. The
 * argument list is a constant; nothing derived from user input reaches it.
 */
async function npmPrefixFromCli(
  platform: NodeJS.Platform,
  env: Readonly<Partial<Record<string, string>>>
): Promise<string | undefined> {
  const comSpec = env['ComSpec'] ?? env['COMSPEC']
  const command = platform === 'win32' ? comSpec : 'npm'
  const args = platform === 'win32' ? ['/d', '/s', '/c', 'npm prefix -g'] : ['prefix', '-g']

  if (command === undefined || command === '') {
    return undefined
  }

  return new Promise<string | undefined>((resolvePromise) => {
    let settled = false
    const finish = (value: string | undefined): void => {
      if (!settled) {
        settled = true
        resolvePromise(value)
      }
    }

    let child
    try {
      child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: minimalCodexEnv(env, platform)
      })
    } catch {
      return finish(undefined)
    }

    const timer = setTimeout(() => {
      child.kill()
      finish(undefined)
    }, NPM_PREFIX_TIMEOUT_MS)

    timer.unref?.()

    let stdout = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('error', () => {
      clearTimeout(timer)
      finish(undefined)
    })
    child.on('close', (code) => {
      clearTimeout(timer)

      const line = stdout.split(/\r?\n/).find((candidate) => candidate.trim() !== '')

      finish(code === 0 && line !== undefined ? line.trim() : undefined)
    })
  })
}
