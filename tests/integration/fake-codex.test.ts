/**
 * The fake Codex is the foundation every later Codex test stands on, so it gets
 * its own test: if it stops answering `--version`, stops writing `argv.json` or
 * stops acting out a scenario, the failure should show up here rather than as a
 * confusing failure in the runner or the verifier.
 */
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CodexResultSchema } from '../../src/shared/schemas.ts'
import {
  fakeCodexEnv,
  fakeCodexLauncher,
  FAKE_CODEX_SCENARIOS,
  type FakeCodexScenario
} from '../helpers/fake-codex.ts'
import { createTempDir } from '../helpers/tmp-workspace.ts'

const JOB_ID = '2026-09-28-richard-nixon-001'

let temp: { path: string; remove(): Promise<void> }
/** A directory named like a job, the way the runner's cwd always is. */
let jobDir: string

beforeEach(async () => {
  temp = await createTempDir()
  jobDir = join(temp.path, 'jobs', JOB_ID)
  await mkdir(join(jobDir, 'inputs'), { recursive: true })
})

afterEach(async () => {
  await temp.remove()
})

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runFake(
  args: readonly string[],
  options: { env?: Record<string, string>; cwd?: string } = {}
): Promise<RunResult> {
  const launcher = fakeCodexLauncher()

  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(launcher.command, [...launcher.prefixArgs, ...args], {
      cwd: options.cwd ?? jobDir,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.env }
    })

    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr })
    })
  })
}

/** Runs `exec` with the argument shape spec section 5.3 fixes. */
async function runExec(
  scenario: FakeCodexScenario,
  extraArgs: readonly string[] = []
): Promise<RunResult> {
  return runFake(
    [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      jobDir,
      '-i',
      join(jobDir, 'inputs', 'style.png'),
      ...extraArgs,
      `You are executing Reference Image Studio job ${JOB_ID}.`
    ],
    { env: fakeCodexEnv({ scenario, lineDelayMs: 0 }) }
  )
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'))
}

function jsonlLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown)
}

describe('preflight commands', () => {
  it('answers --version high enough to pass preflight', async () => {
    const result = await runFake(['--version'])

    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('codex-cli 0.158.0')
  })

  it('lets a test claim any version', async () => {
    const result = await runFake(['--version'], { env: fakeCodexEnv({ version: '0.27.0' }) })

    expect(result.stdout.trim()).toBe('codex-cli 0.27.0')
  })

  it('exits 0 from login status by default, printing on stderr like the real CLI', async () => {
    const result = await runFake(['login', 'status'])

    expect(result.code).toBe(0)
    expect(result.stderr).toContain('Logged in')
    expect(result.stdout).toBe('')
  })

  it('fails login status when FAKE_CODEX_LOGIN says so', async () => {
    const result = await runFake(['login', 'status'], { env: fakeCodexEnv({ loginExitCode: 1 }) })

    expect(result.code).toBe(1)
  })

  it('refuses a command it does not know', async () => {
    const result = await runFake(['doctor'])

    expect(result.code).toBe(64)
  })
})

describe('exec: argv.json', () => {
  it('records the exact argv so plan Task 3.5 can assert the command line', async () => {
    await runExec('success')

    const recorded = (await readJson(join(jobDir, 'argv.json'))) as {
      argv: string[]
      cwd: string
      scenario: string
      envKeys: string[]
    }

    expect(recorded.argv.slice(0, 6)).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C'
    ])
    expect(recorded.cwd).toBe(jobDir)
    expect(recorded.scenario).toBe('success')
  })

  it('records only the names of environment variables, never their values', async () => {
    await runExec('success')

    const recorded = (await readJson(join(jobDir, 'argv.json'))) as { envKeys: string[] }
    const serialized = JSON.stringify(recorded)

    expect(Array.isArray(recorded.envKeys)).toBe(true)
    expect(recorded.envKeys).toContain('PATH')
    expect(serialized).not.toContain(process.env['PATH'] ?? '\u0000never')
  })
})

describe('exec: the JSONL stream', () => {
  it('replays the fixture as one JSON object per line', async () => {
    const result = await runExec('success')
    const events = jsonlLines(result.stdout) as { type: string }[]

    expect(events[0]).toEqual({ type: 'thread.started', thread_id: 'thread_synthetic_success' })
    expect(events.at(-1)).toMatchObject({ type: 'turn.completed' })
    expect(events.filter((event) => event.type === 'item.started').length).toBeGreaterThan(0)
  })

  it('uses only the event vocabulary spec section 5.5 fixes', async () => {
    const known = new Set([
      'thread.started',
      'turn.started',
      'item.started',
      'item.updated',
      'item.completed',
      'turn.completed',
      'error'
    ])

    for (const fixture of ['success', 'capability-unavailable', 'nonzero-exit'] as const) {
      const result = await runExec(fixture)

      for (const event of jsonlLines(result.stdout) as { type: string }[]) {
        expect(known.has(event.type), `unexpected event type ${event.type}`).toBe(true)
      }
    }
  })

  it('writes the last agent message to --output-last-message', async () => {
    const target = join(jobDir, 'last-message.txt')

    await runExec('success', ['--output-last-message', target])

    await expect(readFile(target, 'utf8')).resolves.toContain('outputs/001.png')
  })
})

describe('exec: scenarios', () => {
  it('success produces a real image and a valid codex-result.json', async () => {
    const result = await runExec('success')

    expect(result.code).toBe(0)

    const codexResult = await readJson(join(jobDir, 'codex-result.json'))
    const parsed = CodexResultSchema.safeParse(codexResult)

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toMatchObject({
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }]
    })
    await expect(readdir(join(jobDir, 'outputs'))).resolves.toEqual(['001.png'])
  })

  it('takes the job ID from job.json when the runner materialized one', async () => {
    const otherId = '2026-09-28-someone-else-002'

    await writeFile(join(jobDir, 'job.json'), JSON.stringify({ jobId: otherId }), 'utf8')
    await runExec('success')

    expect(await readJson(join(jobDir, 'codex-result.json'))).toMatchObject({ jobId: otherId })
  })

  it('capability-unavailable reports the code spec section 7.1 allows', async () => {
    const result = await runExec('capability-unavailable')

    expect(result.code).toBe(0)

    const codexResult = await readJson(join(jobDir, 'codex-result.json'))

    expect(CodexResultSchema.safeParse(codexResult).success).toBe(true)
    expect(codexResult).toMatchObject({
      status: 'failed',
      outputs: [],
      error: { code: 'IMAGE_CAPABILITY_UNAVAILABLE' }
    })
  })

  it('capability-unavailable leaves a message the sanitizer has to clean', async () => {
    await runExec('capability-unavailable')

    const codexResult = (await readJson(join(jobDir, 'codex-result.json'))) as {
      error: { message: string }
    }

    expect(codexResult.error.message).toContain('C:\\Users')
    expect(codexResult.error.message).toContain('Bearer sk-')
  })

  it('invalid-result writes a report the schema refuses', async () => {
    const result = await runExec('invalid-result')

    expect(result.code).toBe(0)
    expect(
      CodexResultSchema.safeParse(await readJson(join(jobDir, 'codex-result.json'))).success
    ).toBe(false)
  })

  it('nonzero-exit exits 1 and leaves no codex-result.json at all', async () => {
    const result = await runExec('nonzero-exit')

    expect(result.code).toBe(1)
    await expect(readFile(join(jobDir, 'codex-result.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('nonzero-exit streams an error event carrying a secret and a path', async () => {
    const result = await runExec('nonzero-exit')
    const events = jsonlLines(result.stdout) as { type: string; message?: string }[]
    const error = events.find((event) => event.type === 'error')

    expect(error?.message).toContain('Bearer sk-')
    expect(error?.message).toContain('C:\\Users')
  })

  it('outputs-outside-job declares a path that escapes the job directory', async () => {
    await runExec('outputs-outside-job')

    const codexResult = (await readJson(join(jobDir, 'codex-result.json'))) as {
      outputs: { path: string }[]
    }

    expect(codexResult.outputs[0]?.path).toBe('outputs/../../fake-codex-escape.png')
    // The schema refuses the path before any filesystem check runs.
    expect(CodexResultSchema.safeParse(codexResult).success).toBe(false)
    await expect(readFile(join(jobDir, '..', 'fake-codex-escape.png'))).resolves.toBeInstanceOf(
      Buffer
    )
  })

  it('refuses a scenario name it does not know', async () => {
    const result = await runFake(['exec', '--json'], {
      env: { FAKE_CODEX_SCENARIO: 'not-a-scenario' }
    })

    expect(result.code).toBe(65)
  })

  it('hang streams a few lines and then waits to be killed', async () => {
    const launcher = fakeCodexLauncher()
    const child = spawn(
      launcher.command,
      [...launcher.prefixArgs, 'exec', '--json', '-C', jobDir],
      {
        cwd: jobDir,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...fakeCodexEnv({ scenario: 'hang', lineDelayMs: 0 }) }
      }
    )

    let stdout = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })

    const exited = new Promise<void>((resolvePromise) => {
      child.on('close', () => {
        resolvePromise()
      })
    })

    // Give it long enough to write argv.json and the first lines, then kill it
    // the way `cancel()` will (plan decision Q12).
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))

    expect(jsonlLines(stdout).length).toBeGreaterThan(0)
    expect(child.exitCode).toBeNull()

    child.kill('SIGKILL')
    await exited

    await expect(readFile(join(jobDir, 'codex-result.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

describe('the scenario list', () => {
  it('matches what the helper advertises', async () => {
    expect([...FAKE_CODEX_SCENARIOS]).toEqual([
      'success',
      'capability-unavailable',
      'invalid-result',
      'nonzero-exit',
      'hang',
      'outputs-outside-job'
    ])
  })
})
