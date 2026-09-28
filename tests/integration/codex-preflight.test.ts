import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CodexPreflight,
  runCodexPreflight,
  type CodexCommandResult,
  type RunCodexCommand
} from '../../src/main/codex-preflight.ts'
import type { CodexLauncher } from '../../src/main/codex-resolver.ts'
import { CODEX_MIN_VERSION } from '../../src/shared/codex-version.ts'
import { PreflightResultSchema } from '../../src/shared/ipc-contract.ts'
import { createTempDir } from '../helpers/tmp-workspace.ts'

let temp: { path: string; remove(): Promise<void> }

beforeEach(async () => {
  temp = await createTempDir()
})

afterEach(async () => {
  await temp.remove()
})

/**
 * A stand-in for the Codex executable, run through `node <script>` exactly the
 * way plan decision Q8 runs the fake Codex of Task 3.3. It answers the two
 * preflight commands and nothing else, so these tests stay independent of the
 * fake's job-running behaviour.
 */
async function stubLauncher(options: {
  version?: string
  loginExitCode?: number
  versionExitCode?: number
  versionOn?: 'stdout' | 'stderr'
  versionText?: string
  hang?: boolean
  recordEnvTo?: string
}): Promise<CodexLauncher> {
  const script = join(temp.path, `stub-${String(Math.random()).slice(2)}.mjs`)
  const versionText = options.versionText ?? `codex-cli ${options.version ?? CODEX_MIN_VERSION}`
  const source = `
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const recordEnvTo = ${JSON.stringify(options.recordEnvTo ?? null)}

if (recordEnvTo !== null) {
  writeFileSync(recordEnvTo, JSON.stringify(Object.keys(process.env).sort()), 'utf8')
}

if (${String(options.hang === true)}) {
  setInterval(() => {}, 1000)
} else if (args[0] === '--version') {
  process.${options.versionOn ?? 'stdout'}.write(${JSON.stringify(`${versionText}\n`)})
  process.exit(${String(options.versionExitCode ?? 0)})
} else if (args[0] === 'login' && args[1] === 'status') {
  // The real 0.27.0 binary prints this on stderr and exits 0; only the exit
  // code is part of the contract (spec section 5.3).
  process.stderr.write('Logged in using ChatGPT\\n')
  process.exit(${String(options.loginExitCode ?? 0)})
} else {
  process.stderr.write('unexpected argv: ' + args.join(' ') + '\\n')
  process.exit(64)
}
`

  await writeFile(script, source, 'utf8')

  return { command: process.execPath, prefixArgs: [script], source: 'path' }
}

describe('runCodexPreflight against a real child process', () => {
  it('reports CODEX_VERSION_UNSUPPORTED for the 0.27.0 installed on this machine', async () => {
    const outcome = await runCodexPreflight({ launcher: await stubLauncher({ version: '0.27.0' }) })

    expect(outcome.result).toEqual({
      ok: false,
      code: 'CODEX_VERSION_UNSUPPORTED',
      message: expect.stringContaining('0.27.0')
    })
    expect(outcome.result.ok === false && outcome.result.message).toContain(CODEX_MIN_VERSION)
    expect(outcome.launcher).toBeNull()
  })

  it('reports CODEX_NOT_AUTHENTICATED when login status exits non-zero', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ version: CODEX_MIN_VERSION, loginExitCode: 1 })
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_AUTHENTICATED' })
    expect(outcome.launcher).toBeNull()
  })

  it('passes when the version is high enough and login exits 0', async () => {
    const launcher = await stubLauncher({ version: CODEX_MIN_VERSION })
    const outcome = await runCodexPreflight({ launcher })

    expect(outcome.result).toEqual({
      ok: true,
      version: CODEX_MIN_VERSION,
      executable: process.execPath
    })
    expect(outcome.launcher).toBe(launcher)
  })

  it('accepts a version above the minimum', async () => {
    const outcome = await runCodexPreflight({ launcher: await stubLauncher({ version: '1.2.3' }) })

    expect(outcome.result).toMatchObject({ ok: true, version: '1.2.3' })
  })

  it('compares numerically, so 0.27.0 is below 0.158.0', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ version: '0.27.0' }),
      minVersion: '0.158.0'
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_VERSION_UNSUPPORTED' })
  })

  it('reads the version off stderr as well as stdout', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ version: CODEX_MIN_VERSION, versionOn: 'stderr' })
    })

    expect(outcome.result).toMatchObject({ ok: true, version: CODEX_MIN_VERSION })
  })

  it('reports CODEX_NOT_FOUND with a timeout message when the CLI hangs', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ hang: true }),
      timeoutMs: 800
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_FOUND' })
    expect(outcome.result.ok === false && outcome.result.message).toMatch(/did not answer/i)
    expect(outcome.result.ok === false && outcome.result.message).toContain('--version')
  })

  it('reports CODEX_NOT_FOUND when --version exits non-zero', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ versionExitCode: 3 })
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_FOUND' })
  })

  it('reports CODEX_VERSION_UNSUPPORTED when the output holds no version', async () => {
    const outcome = await runCodexPreflight({
      launcher: await stubLauncher({ versionText: 'usage: some other program' })
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_VERSION_UNSUPPORTED' })
  })

  it('reports CODEX_NOT_FOUND when the executable does not exist', async () => {
    const outcome = await runCodexPreflight({
      launcher: {
        command: join(temp.path, 'no-such-codex.exe'),
        prefixArgs: [],
        source: 'settings'
      }
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_FOUND' })
  })

  it('never hands OPENAI_API_KEY or any other secret to the child', async () => {
    const envDump = join(temp.path, 'child-env.json')
    const launcher = await stubLauncher({
      version: CODEX_MIN_VERSION,
      recordEnvTo: envDump
    })

    const outcome = await runCodexPreflight({
      launcher,
      env: {
        ...process.env,
        OPENAI_API_KEY: 'sk-must-not-be-forwarded',
        CODEX_HOME: join(temp.path, 'codex-home')
      }
    })

    expect(outcome.result.ok).toBe(true)

    const keys = JSON.parse(await readFile(envDump, 'utf8')) as string[]

    expect(keys).not.toContain('OPENAI_API_KEY')
    expect(keys).toContain('CODEX_HOME')
  })
})

describe('runCodexPreflight resolution failures', () => {
  it('turns a broken settings override into CODEX_NOT_FOUND naming the path', async () => {
    const missing = join(temp.path, 'nowhere', 'codex-x86_64-pc-windows-msvc.exe')
    const outcome = await runCodexPreflight({
      codexExecutable: missing,
      platform: 'win32',
      env: {}
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_FOUND' })
    expect(outcome.result.ok === false && outcome.result.message).toContain(missing)
  })

  it('never resolves through the npm shim, so a PATH with only codex.cmd fails', async () => {
    await writeFile(join(temp.path, 'codex.cmd'), '@echo off\r\n', 'utf8')

    const outcome = await runCodexPreflight({
      platform: 'win32',
      env: { PATH: temp.path },
      run: async () => {
        throw new Error('preflight must not get as far as running a command')
      }
    })

    expect(outcome.result).toMatchObject({ ok: false, code: 'CODEX_NOT_FOUND' })
  })
})

describe('every outcome matches the IPC contract', () => {
  it('validates against PreflightResultSchema', async () => {
    const launchers = [
      await stubLauncher({ version: '0.27.0' }),
      await stubLauncher({ version: CODEX_MIN_VERSION, loginExitCode: 1 }),
      await stubLauncher({ version: CODEX_MIN_VERSION })
    ]

    for (const launcher of launchers) {
      const outcome = await runCodexPreflight({ launcher })

      expect(PreflightResultSchema.safeParse(outcome.result).success).toBe(true)
    }
  })
})

describe('CodexPreflight caching (plan decision Q7)', () => {
  const okResult: CodexCommandResult = {
    code: 0,
    signal: null,
    stdout: `codex-cli ${CODEX_MIN_VERSION}\n`,
    stderr: '',
    timedOut: false,
    spawnError: null
  }

  function countingRun(): { run: RunCodexCommand; calls: () => number } {
    let calls = 0
    const run: RunCodexCommand = async () => {
      calls += 1

      return okResult
    }

    return { run, calls: () => calls }
  }

  const launcher: CodexLauncher = {
    command: join('C:', 'codex', 'codex.exe'),
    prefixArgs: [],
    source: 'settings'
  }

  it('runs the two commands once and answers from the cache afterwards', async () => {
    const { run, calls } = countingRun()
    const preflight = new CodexPreflight({ launcher, run })

    await preflight.run()
    await preflight.run()
    await preflight.run()

    expect(calls()).toBe(2)
  })

  it('runs again when force is set', async () => {
    const { run, calls } = countingRun()
    const preflight = new CodexPreflight({ launcher, run })

    await preflight.run()
    await preflight.run({ force: true })

    expect(calls()).toBe(4)
  })

  it('shares one run between concurrent callers', async () => {
    const { run, calls } = countingRun()
    const preflight = new CodexPreflight({ launcher, run })

    const [first, second] = await Promise.all([preflight.run(), preflight.run()])

    expect(calls()).toBe(2)
    expect(first).toBe(second)
  })

  it('exposes nothing before the first run and the outcome after it', async () => {
    const { run } = countingRun()
    const preflight = new CodexPreflight({ launcher, run })

    expect(preflight.cached).toBeNull()

    const outcome = await preflight.run()

    expect(preflight.cached).toBe(outcome)

    preflight.clear()

    expect(preflight.cached).toBeNull()
  })

  it('stops at the version check and never asks about login', async () => {
    const asked: string[][] = []
    const preflight = new CodexPreflight({
      launcher,
      run: async (_launcher, args) => {
        asked.push([...args])

        return { ...okResult, stdout: 'codex-cli 0.27.0\n' }
      }
    })

    const outcome = await preflight.run()

    expect(outcome.result).toMatchObject({ code: 'CODEX_VERSION_UNSUPPORTED' })
    expect(asked).toEqual([['--version']])
  })
})
