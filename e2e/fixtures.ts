/**
 * The Playwright Electron harness (plan Task 6.1).
 *
 * Each test launches the **built** app — `out/main/index.js`, the same bundle
 * `pnpm build` produces — against a throwaway workspace, with the fake Codex of
 * plan Task 3.3 standing in for the real CLI. No automated test ever starts the
 * installed `codex` (spec section 13, AGENTS.md).
 *
 * The environment the app is launched with:
 *
 * | Variable                    | Why                                                |
 * | --------------------------- | -------------------------------------------------- |
 * | `NODE_ENV=test`             | the one gate that opens `src/main/test-hooks.ts`   |
 * | `STUDIO_WORKSPACE`          | the per-test temp workspace (plan Task 2.1)        |
 * | `STUDIO_CODEX_LAUNCHER`     | `fake`, or `missing` for the `CODEX_NOT_FOUND` path |
 * | `FAKE_CODEX_SCENARIO`       | which run the fake acts out                        |
 * | `STUDIO_TEST_OPEN_DIALOG`   | the scripted reference picker                      |
 * | `STUDIO_TEST_CLOSE_ANSWER`  | the scripted close-guard message box                |
 *
 * The last two exist because Playwright drives the renderer and cannot touch a
 * native dialog. The close guard of plan Task 5.6 in particular would make
 * `electronApp.close()` hang forever with a run in flight, since the question
 * it asks is drawn by the operating system.
 *
 * `test.use({ codexScenario, codexLauncher, closeAnswer })` picks all three per
 * file or per test.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'

import type { RunState } from '../src/shared/progress.ts'

import { E2eWorkspace } from './helpers/workspace.ts'

export { expect }
export { E2eWorkspace } from './helpers/workspace.ts'

/**
 * The repository root; the app is launched from here, unpackaged.
 *
 * `__dirname` rather than `import.meta.url`: Playwright transpiles this suite
 * to CommonJS, because the package is not `"type": "module"`, and `import.meta`
 * is a syntax error there. `electron.vite.config.ts` and `vitest.config.ts` do
 * the same for the same reason.
 */
export const REPO_ROOT = resolve(__dirname, '..')

/** The built main process `pnpm build` writes. */
export const MAIN_ENTRY = join(REPO_ROOT, 'out', 'main', 'index.js')

/** The scenarios `tests/fake-codex/fake-codex.mjs` knows (see its README). */
export type CodexScenario =
  | 'success'
  | 'capability-unavailable'
  | 'invalid-result'
  | 'nonzero-exit'
  | 'hang'
  | 'outputs-outside-job'

/** `fake` runs the stand-in; `missing` points at a file that is not there. */
export type CodexLauncherKind = 'fake' | 'missing'

/** The three run states a job stops in (spec section 12). */
export const TERMINAL_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled']

export interface StudioOptions {
  readonly codexScenario: CodexScenario
  readonly codexLauncher: CodexLauncherKind
  /** What the close guard's scripted message box answers (plan Task 5.6). */
  readonly closeAnswer: 'quit' | 'stay'
}

/** The running app, its window and the workspace it is pointed at. */
export interface Studio {
  readonly app: ElectronApplication
  readonly page: Page
  readonly workspace: E2eWorkspace

  /** A `<section aria-label="…">` of the layout, by its Vietnamese name. */
  region(name: string): Locator
  /** The run panel of plan Task 5.5, which carries `data-state`. */
  runPanel(): Locator
  /** The run state the panel is showing right now, or `null` before any run. */
  runState(): Promise<string | null>
  /** Waits until the run panel reports one of `states`. */
  waitForRunState(states: readonly string[], timeoutMs?: number): Promise<string>
  /** Waits until the run panel reports a terminal state, and returns it. */
  waitForTerminalState(timeoutMs?: number): Promise<string>
}

interface StudioFixtures {
  readonly workspace: E2eWorkspace
  readonly studio: Studio
}

export const test = base.extend<StudioOptions & StudioFixtures>({
  codexScenario: ['success', { option: true }],
  codexLauncher: ['fake', { option: true }],
  closeAnswer: ['quit', { option: true }],

  workspace: async ({}, use, testInfo) => {
    const workspace = await E2eWorkspace.create()

    try {
      await use(workspace)
    } finally {
      // `STUDIO_E2E_KEEP=1` leaves a failed test's workspace on disk, which is
      // the only way to read the `result.json` and `events.jsonl` that explain
      // why a run ended the way it did.
      if (process.env['STUDIO_E2E_KEEP'] === '1' && testInfo.status !== testInfo.expectedStatus) {
        console.warn(`e2e: kept the workspace of a failed test at ${workspace.base}`)
      } else {
        await workspace.remove()
      }
    }
  },

  studio: async ({ workspace, codexScenario, codexLauncher, closeAnswer }, use, testInfo) => {
    if (!existsSync(MAIN_ENTRY)) {
      throw new Error(
        `The built app is missing: ${MAIN_ENTRY}. Run \`pnpm build\` before \`pnpm test:e2e\`.`
      )
    }

    // The repository root, not `out/main/index.js`: Electron then reads the
    // `main` field of `package.json` and `app.getAppPath()` is the repository,
    // which is where `tests/fake-codex/` lives. Pointing it straight at the
    // bundle makes the app path `out/main`, and the fake cannot be found.
    const app = await electron.launch({
      args: [REPO_ROOT],
      cwd: REPO_ROOT,
      env: launchEnv({ workspace, codexScenario, codexLauncher, closeAnswer })
    })

    // The main process logs every IPC failure to stderr (plan Task 4.2) and
    // nothing else would show it, so it is kept and attached to a failed test.
    const log: string[] = []

    app.process().stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString('utf8')))
    app.process().stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString('utf8')))

    const page = await app.firstWindow()

    await page.waitForLoadState('domcontentloaded')

    try {
      await use(studioApi(app, page, workspace))
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && log.length > 0) {
        await testInfo.attach('main-process.log', { body: log.join(''), contentType: 'text/plain' })
      }

      await app.close()
    }
  }
})

function studioApi(app: ElectronApplication, page: Page, workspace: E2eWorkspace): Studio {
  const runPanel = (): Locator => page.locator('section.run')

  const waitForRunState = async (
    states: readonly string[],
    timeoutMs = 20_000
  ): Promise<string> => {
    await expect
      .poll(async () => (await runPanel().getAttribute('data-state')) ?? '', { timeout: timeoutMs })
      .toMatch(new RegExp(`^(${states.join('|')})$`))

    return (await runPanel().getAttribute('data-state')) ?? ''
  }

  return {
    app,
    page,
    workspace,
    region: (name: string): Locator => page.getByRole('region', { name, exact: true }),
    runPanel,
    runState: async (): Promise<string | null> => {
      return (await runPanel().count()) === 0 ? null : runPanel().getAttribute('data-state')
    },
    waitForRunState,
    waitForTerminalState: async (timeoutMs = 20_000): Promise<string> =>
      waitForRunState(TERMINAL_STATES, timeoutMs)
  }
}

/**
 * The child's environment.
 *
 * `_electron.launch` replaces the environment wholesale, so the parent's is the
 * base: on Windows the Electron binary needs `PATH`, `SystemRoot` and
 * `TEMP` to start at all. `ELECTRON_RENDERER_URL` is removed so the built
 * renderer is loaded from `file://` even if a dev server is running.
 */
function launchEnv(options: StudioOptions & { workspace: E2eWorkspace }): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[name] = value
    }
  }

  delete env['ELECTRON_RENDERER_URL']

  env['NODE_ENV'] = 'test'
  env['STUDIO_WORKSPACE'] = options.workspace.root
  env['STUDIO_CODEX_LAUNCHER'] = options.codexLauncher
  env['STUDIO_TEST_OPEN_DIALOG'] = options.workspace.dialogScript
  env['STUDIO_TEST_CLOSE_ANSWER'] = options.closeAnswer
  env['FAKE_CODEX_SCENARIO'] = options.codexScenario

  return env
}
