/**
 * How every test reaches the fake Codex of plan Task 3.3.
 *
 * One place builds the launcher of plan decision Q8, so the runner of Task 3.5,
 * the verifier of Task 3.6 and the orchestrator of Task 3.7 all start the same
 * file the same way and nothing has to hard-code a path into the fake.
 */
import { fileURLToPath } from 'node:url'

/** The absolute path of `tests/fake-codex/fake-codex.mjs`. */
export const FAKE_CODEX_SCRIPT = fileURLToPath(
  new URL('../fake-codex/fake-codex.mjs', import.meta.url)
)

/** The scenarios `FAKE_CODEX_SCENARIO` accepts; see the fake's README. */
export const FAKE_CODEX_SCENARIOS = [
  'success',
  'capability-unavailable',
  'invalid-result',
  'nonzero-exit',
  'hang',
  'outputs-outside-job'
] as const

export type FakeCodexScenario = (typeof FAKE_CODEX_SCENARIOS)[number]

/**
 * The launcher shape of plan decision Q8, pointed at the fake.
 *
 * `source` is `'path'` only because `CodexLauncher` needs one; nothing resolved
 * this and no real executable is involved.
 *
 * The `FAKE_CODEX_*` variables ride on the launcher rather than on
 * `process.env`, because a Codex child only ever gets the allowlist
 * `minimalCodexEnv` builds and that allowlist must not learn test-only names.
 */
export function fakeCodexLauncher(options: FakeCodexOptions = {}): {
  command: string
  prefixArgs: readonly string[]
  source: 'path'
  env: Record<string, string>
} {
  return {
    command: process.execPath,
    prefixArgs: [FAKE_CODEX_SCRIPT],
    source: 'path',
    env: fakeCodexEnv(options)
  }
}

export interface FakeCodexOptions {
  scenario?: FakeCodexScenario
  version?: string
  loginExitCode?: number
  lineDelayMs?: number
  jobId?: string
}

/** The environment variables that script a fake run. */
export function fakeCodexEnv(options: FakeCodexOptions): Record<string, string> {
  const env: Record<string, string> = {}

  if (options.scenario !== undefined) {
    env['FAKE_CODEX_SCENARIO'] = options.scenario
  }

  if (options.version !== undefined) {
    env['FAKE_CODEX_VERSION'] = options.version
  }

  if (options.loginExitCode !== undefined) {
    env['FAKE_CODEX_LOGIN'] = String(options.loginExitCode)
  }

  if (options.lineDelayMs !== undefined) {
    env['FAKE_CODEX_LINE_DELAY_MS'] = String(options.lineDelayMs)
  }

  if (options.jobId !== undefined) {
    env['FAKE_CODEX_JOB_ID'] = options.jobId
  }

  return env
}
