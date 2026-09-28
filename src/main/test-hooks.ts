/**
 * The injections the end-to-end harness needs (plan Task 6.1).
 *
 * Three things the Playwright suite cannot drive from the outside are replaced
 * here, and **only** when `NODE_ENV` is `test`:
 *
 * | Environment variable        | Replaces                                  |
 * | --------------------------- | ----------------------------------------- |
 * | `STUDIO_CODEX_LAUNCHER`     | the resolved Codex executable             |
 * | `STUDIO_TEST_OPEN_DIALOG`   | `dialog.showOpenDialog`, a native picker  |
 * | `STUDIO_TEST_CLOSE_ANSWER`  | `dialog.showMessageBox`, a native dialog  |
 *
 * The gate is deliberately one condition on one variable a packaged app never
 * carries: without `NODE_ENV=test` every function here returns `null` and the
 * app wires its production collaborators, whatever else the environment says.
 * A user who happens to have `STUDIO_CODEX_LAUNCHER` set therefore cannot make
 * the shipped app start something other than Codex.
 *
 * Why each one exists:
 *
 * - The suite must never start the real Codex (spec section 13, AGENTS.md), so
 *   the launcher of plan decision Q8 is pointed at `tests/fake-codex/`. The
 *   `FAKE_CODEX_*` variables ride on `CodexLauncher.env` rather than on
 *   `process.env`, because a Codex child only ever receives the allowlist
 *   `minimalCodexEnv` builds and that allowlist must not learn test-only names.
 * - Playwright drives the renderer, not the operating system: it cannot click a
 *   native file picker or a native message box. Both are therefore scripted
 *   from a file and an environment variable respectively.
 *
 * Node built-ins are allowed here; Electron is not imported, so
 * `tests/unit/test-hooks.test.ts` covers the gate without a window.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import type { CodexLauncher } from './codex-resolver.ts'
import { QUIT_BUTTON_INDEX, STAY_BUTTON_INDEX, type ShowMessageBox } from './close-guard.ts'
import type { OpenDialogAnswer, ShowOpenDialog } from './dialog.ts'

/** Nothing in this module does anything unless `NODE_ENV` has this value. */
export const TEST_MODE_ENV_VALUE = 'test'

/** Selects a stand-in for the resolved Codex executable; see {@link TestLauncherKind}. */
export const CODEX_LAUNCHER_ENV_VAR = 'STUDIO_CODEX_LAUNCHER'

/** Overrides where `fake` looks for the fake Codex script. */
export const FAKE_CODEX_SCRIPT_ENV_VAR = 'STUDIO_FAKE_CODEX_SCRIPT'

/** An absolute path to the JSON file that scripts the file picker. */
export const OPEN_DIALOG_ENV_VAR = 'STUDIO_TEST_OPEN_DIALOG'

/** `quit` or `stay`: the button the close guard's message box reports. */
export const CLOSE_ANSWER_ENV_VAR = 'STUDIO_TEST_CLOSE_ANSWER'

/** `tests/fake-codex/fake-codex.mjs`, relative to the app path. */
export const FAKE_CODEX_SCRIPT_RELATIVE_PATH = join('tests', 'fake-codex', 'fake-codex.mjs')

/** The prefix of every variable that scripts the fake of plan Task 3.3. */
const FAKE_CODEX_ENV_PREFIX = 'FAKE_CODEX_'

/**
 * The file name the `missing` launcher points at, inside the app path.
 *
 * Spawning it fails with `ENOENT`, which preflight reports as
 * `CODEX_NOT_FOUND` (spec section 7.4) — the failure the e2e suite needs to
 * observe without uninstalling anything from the machine it runs on.
 */
export const MISSING_CODEX_FILE_NAME = 'no-such-codex-executable.exe'

/**
 * What `STUDIO_CODEX_LAUNCHER` may name.
 *
 * `fake` runs `tests/fake-codex/fake-codex.mjs` under the current Node, which
 * is the launcher shape of plan decision Q8. `missing` names a file that is not
 * there.
 */
export type TestLauncherKind = 'fake' | 'missing'

export type EnvLike = Readonly<Partial<Record<string, string>>>

/** Whether the test-only injections below are allowed at all. */
export function isTestMode(env: EnvLike = process.env): boolean {
  return env['NODE_ENV'] === TEST_MODE_ENV_VALUE
}

/**
 * The launcher the harness asked for, or `null` to resolve the real Codex.
 *
 * `appPath` is `app.getAppPath()`, which is the repository root for the
 * unpackaged build the e2e suite launches; the fake script lives there.
 */
export function testCodexLauncher(
  env: EnvLike = process.env,
  appPath = process.cwd()
): CodexLauncher | null {
  if (!isTestMode(env)) {
    return null
  }

  const kind = env[CODEX_LAUNCHER_ENV_VAR]

  if (kind === 'missing') {
    return { command: join(appPath, MISSING_CODEX_FILE_NAME), prefixArgs: [], source: 'settings' }
  }

  if (kind !== 'fake') {
    return null
  }

  const override = env[FAKE_CODEX_SCRIPT_ENV_VAR]
  const script =
    override !== undefined && override.trim() !== '' && isAbsolute(override)
      ? override
      : join(appPath, FAKE_CODEX_SCRIPT_RELATIVE_PATH)

  return {
    command: process.execPath,
    prefixArgs: [script],
    source: 'path',
    env: fakeCodexEnvFrom(env)
  }
}

/**
 * Every `FAKE_CODEX_*` variable the harness set, so the child really receives
 * the scenario it was given. Without this merge each run would silently fall
 * back to `success`, because `minimalCodexEnv` drops what it does not name.
 */
export function fakeCodexEnvFrom(env: EnvLike): Record<string, string> {
  const forwarded: Record<string, string> = {}

  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(FAKE_CODEX_ENV_PREFIX) && value !== undefined) {
      forwarded[name] = value
    }
  }

  return forwarded
}

/**
 * A file picker that answers from a JSON file, or `null` to use the real one.
 *
 * The file is read on every call rather than once, so a test rewrites it
 * between clicks and each slot receives a different image. Its shape is
 * `{ "canceled": false, "filePaths": ["<absolute path>"] }`; anything missing,
 * unreadable or malformed is reported as a cancelled dialog, which is what a
 * user closing the picker looks like (plan Task 2.3).
 */
export function scriptedShowOpenDialog(env: EnvLike = process.env): ShowOpenDialog | null {
  if (!isTestMode(env)) {
    return null
  }

  const scriptPath = env[OPEN_DIALOG_ENV_VAR]

  if (scriptPath === undefined || scriptPath.trim() === '') {
    return null
  }

  return async (): Promise<OpenDialogAnswer> => readOpenDialogScript(scriptPath)
}

async function readOpenDialogScript(scriptPath: string): Promise<OpenDialogAnswer> {
  const cancelled: OpenDialogAnswer = { canceled: true, filePaths: [] }

  let parsed: unknown

  try {
    parsed = JSON.parse(await readFile(scriptPath, 'utf8'))
  } catch {
    return cancelled
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return cancelled
  }

  const { canceled, filePaths } = parsed as { canceled?: unknown; filePaths?: unknown }

  if (canceled === true || !Array.isArray(filePaths)) {
    return cancelled
  }

  const paths = filePaths.filter((entry): entry is string => typeof entry === 'string')

  return paths.length === 0 ? cancelled : { canceled: false, filePaths: paths }
}

/**
 * A message box that answers from an environment variable, or `null` to use
 * the real one.
 *
 * The close guard of plan Task 5.6 asks before quitting on top of a running
 * Codex, and that question is drawn by the operating system. Playwright cannot
 * press either button, so `electronApp.close()` would hang forever with a run
 * in flight. Under test the answer is decided up front: `stay` keeps the app
 * open, anything else — including the default — quits and cancels the run,
 * which is the behaviour teardown needs.
 */
export function scriptedShowMessageBox(env: EnvLike = process.env): ShowMessageBox | null {
  if (!isTestMode(env)) {
    return null
  }

  const answer = env[CLOSE_ANSWER_ENV_VAR]

  if (answer === undefined || answer.trim() === '') {
    return null
  }

  const response = answer === 'stay' ? STAY_BUTTON_INDEX : QUIT_BUTTON_INDEX

  return async () => ({ response })
}
