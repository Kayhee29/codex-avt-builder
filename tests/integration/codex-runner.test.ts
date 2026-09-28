/**
 * The Codex runner against the fake Codex of plan Task 3.3 (plan Task 3.5).
 *
 * Nothing here starts the real `codex` (spec section 13, AGENTS.md). What is
 * under test is the command line of spec section 5.3, the streaming of spec
 * section 5.5, the process-tree cancel of plan decision Q12 and the refusal of
 * a second run on a job already running (spec section 10).
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildCodexArgs,
  buildOrchestrationInstruction,
  CodexRunError,
  CodexRunner,
  EVENTS_FILE_NAME,
  LAST_MESSAGE_FILE_NAME,
  ProgressEmitter,
  STDERR_FILE_NAME,
  STUDIO_META_EVENT_TYPE
} from '../../src/main/codex-runner.ts'
import { ACTIVITY } from '../../src/main/jsonl-normalizer.ts'
import { ProgressEventSchema, type ProgressEvent } from '../../src/shared/progress.ts'
import { fakeCodexLauncher, type FakeCodexScenario } from '../helpers/fake-codex.ts'
import { createTempWorkspace, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const JOB_ID = '2026-09-28-richard-nixon-001'

/**
 * Strings a user typed. None of them may appear on the command line
 * (spec section 11); Codex reads them from `prompt.md` and `job.json`.
 */
const SUBJECT_NAME = 'Richard Nixon'
const SUBJECT_DESCRIPTION = 'Chibi historical character portrait'
const SUBJECT_NOTES = 'Clear silhouette, no watermark'
const PROMPT_BODY = 'Draw the subject with a muted warm paper background.'

let workspace: TempWorkspace
let jobDir: string

beforeEach(async () => {
  workspace = await createTempWorkspace()
  jobDir = join(workspace.jobs, JOB_ID)
  await mkdir(join(jobDir, 'inputs'), { recursive: true })
  await mkdir(join(jobDir, 'outputs'), { recursive: true })
  await writeFile(join(jobDir, 'prompt.md'), PROMPT_BODY, 'utf8')
  await writeFile(
    join(jobDir, 'job.json'),
    JSON.stringify({
      jobId: JOB_ID,
      subject: { name: SUBJECT_NAME, description: SUBJECT_DESCRIPTION, notes: SUBJECT_NOTES }
    }),
    'utf8'
  )
})

afterEach(async () => {
  await workspace.remove()
})

interface ArgvRecord {
  argv: string[]
  cwd: string
  jobDir: string
  scenario: string
  execPath: string
  envKeys: string[]
}

async function readArgv(): Promise<ArgvRecord> {
  return JSON.parse(await readFile(join(jobDir, 'argv.json'), 'utf8')) as ArgvRecord
}

async function readLines(name: string): Promise<string[]> {
  const raw = await readFile(join(jobDir, name), 'utf8')

  return raw.split('\n').filter((line) => line.trim() !== '')
}

/** Two inputs in role order, the way `JobMaterializer` hands them over. */
async function writeInputs(): Promise<string[]> {
  const style = join(jobDir, 'inputs', 'style.png')
  const identity = join(jobDir, 'inputs', 'identity.jpg')

  await writeFile(style, 'not really a png', 'utf8')
  await writeFile(identity, 'not really a jpeg', 'utf8')

  return [style, identity]
}

async function run(
  scenario: FakeCodexScenario,
  options: { inputPaths?: readonly string[]; events?: ProgressEvent[] } = {}
) {
  const runner = new CodexRunner()
  const emitter =
    options.events === undefined
      ? undefined
      : new ProgressEmitter(JOB_ID, (event) => options.events?.push(event))

  return runner.start({
    jobId: JOB_ID,
    jobDir,
    inputPaths: options.inputPaths ?? [],
    launcher: fakeCodexLauncher({ scenario }),
    codexVersion: '0.158.0',
    ...(emitter === undefined ? {} : { progress: emitter })
  })
}

describe('buildCodexArgs', () => {
  it('builds exactly the command line of spec section 5.3', () => {
    const args = buildCodexArgs({
      jobId: JOB_ID,
      jobDir: '/jobs/2026-09-28-richard-nixon-001',
      inputPaths: ['/jobs/2026-09-28-richard-nixon-001/inputs/style.png'],
      launcher: { prefixArgs: [] }
    })

    expect(args).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      '/jobs/2026-09-28-richard-nixon-001',
      '-i',
      '/jobs/2026-09-28-richard-nixon-001/inputs/style.png',
      '--output-last-message',
      join('/jobs/2026-09-28-richard-nixon-001', LAST_MESSAGE_FILE_NAME),
      buildOrchestrationInstruction(JOB_ID)
    ])
  })

  it('never carries a flag spec section 5.3 forbids', () => {
    const args = buildCodexArgs({
      jobId: JOB_ID,
      jobDir: jobDir,
      inputPaths: [],
      launcher: { prefixArgs: [] }
    })

    for (const forbidden of [
      '--full-auto',
      '--dangerously-bypass-approvals-and-sandbox',
      'danger-full-access',
      'sandbox_workspace_write.network_access=true'
    ]) {
      expect(args.join(' ')).not.toContain(forbidden)
    }
  })

  it('refuses a job ID that does not match spec section 6.1', () => {
    expect(() =>
      buildCodexArgs({
        jobId: '../etc/passwd',
        jobDir,
        inputPaths: [],
        launcher: { prefixArgs: [] }
      })
    ).toThrow(CodexRunError)
  })
})

describe('CodexRunner.start', () => {
  it('passes the argv of spec section 5.3 to the child, prefixArgs first', async () => {
    const inputPaths = await writeInputs()

    await run('success', { inputPaths })

    const record = await readArgv()

    expect(record.argv).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '-C',
      jobDir,
      '-i',
      inputPaths[0],
      '-i',
      inputPaths[1],
      '--output-last-message',
      join(jobDir, LAST_MESSAGE_FILE_NAME),
      buildOrchestrationInstruction(JOB_ID)
    ])
    expect(record.cwd).toBe(jobDir)
  })

  it('keeps the -i order the materializer handed over', async () => {
    const inputPaths = await writeInputs()

    await run('success', { inputPaths })

    const record = await readArgv()
    const attached = record.argv.filter((_value, index) => record.argv[index - 1] === '-i')

    expect(attached).toEqual(inputPaths)
  })

  it('puts no user text on the command line (spec section 11)', async () => {
    const inputPaths = await writeInputs()

    await run('success', { inputPaths })

    const commandLine = (await readArgv()).argv.join('\u0000')

    for (const secret of [SUBJECT_NAME, SUBJECT_DESCRIPTION, SUBJECT_NOTES, PROMPT_BODY]) {
      expect(commandLine).not.toContain(secret)
    }

    // The single user-derived value allowed through is the validated job ID of
    // spec section 6.1, and it appears only where the spec puts it: the job
    // directory, the paths underneath it, and the fixed instruction.
    const withJobId = (await readArgv()).argv.filter((value) => value.includes(JOB_ID))

    expect(withJobId).toEqual([
      jobDir,
      inputPaths[0],
      inputPaths[1],
      join(jobDir, LAST_MESSAGE_FILE_NAME),
      buildOrchestrationInstruction(JOB_ID)
    ])
  })

  it('gives the child the allowlisted environment, without OPENAI_API_KEY', async () => {
    const outcome = await run('success', {
      inputPaths: [],
      events: []
    })

    expect(outcome.exitCode).toBe(0)

    const { envKeys } = await readArgv()

    expect(envKeys).not.toContain('OPENAI_API_KEY')
    // The launcher's own variables are merged on top of the allowlist, which is
    // the only reason the scenario reached the fake at all.
    expect(envKeys).toContain('FAKE_CODEX_SCENARIO')
  })

  it('drops OPENAI_API_KEY even when it is set in the parent environment', async () => {
    const runner = new CodexRunner()

    await runner.start({
      jobId: JOB_ID,
      jobDir,
      inputPaths: [],
      launcher: fakeCodexLauncher({ scenario: 'success' }),
      env: { ...process.env, OPENAI_API_KEY: 'sk-NOT-A-REAL-KEY-000000' }
    })

    const { envKeys } = await readArgv()

    expect(envKeys).not.toContain('OPENAI_API_KEY')
  })

  it('writes studio.meta as the first line of events.jsonl', async () => {
    await run('success')

    const lines = await readLines(EVENTS_FILE_NAME)
    const meta = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>

    expect(meta['type']).toBe(STUDIO_META_EVENT_TYPE)
    expect(meta['codexVersion']).toBe('0.158.0')
    expect(meta['executable']).toBe(process.execPath)
    expect(meta['args']).toContain('--skip-git-repo-check')
  })

  it('writes every Codex line after it, and the file stays valid JSONL', async () => {
    await run('success')

    const lines = await readLines(EVENTS_FILE_NAME)

    expect(lines.length).toBeGreaterThan(10)

    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    const types = lines.map((line) => (JSON.parse(line) as { type?: string }).type)

    expect(types).toContain('thread.started')
    expect(types).toContain('item.completed')
    expect(types).toContain('turn.completed')
  })

  it('emits progress events with a rising seq and the image_gen activity', async () => {
    const events: ProgressEvent[] = []

    await run('success', { events })

    expect(events.length).toBeGreaterThan(0)

    for (const [index, event] of events.entries()) {
      expect(() => ProgressEventSchema.parse(event)).not.toThrow()
      expect(event.seq).toBe(index)
      expect(event.jobId).toBe(JOB_ID)
    }

    expect(events.map((event) => event.activity)).toContain(ACTIVITY.imageGen)
  })

  it('writes stderr to stderr.log and reports a non-zero exit code', async () => {
    const outcome = await run('nonzero-exit')

    expect(outcome.exitCode).toBe(1)
    expect(outcome.cancelled).toBe(false)
    expect(outcome.spawnError).toBeNull()
    expect(await readFile(join(jobDir, STDERR_FILE_NAME), 'utf8')).toContain(
      'image generation failed'
    )
    expect(outcome.stderr).toContain('image generation failed')
  })

  it('honours --output-last-message the way the real CLI does', async () => {
    await run('success')

    expect(await readFile(join(jobDir, LAST_MESSAGE_FILE_NAME), 'utf8')).toContain('image_gen')
  })

  it('refuses a second start while the job is running (spec section 10)', async () => {
    const runner = new CodexRunner()
    const first = runner.start({
      jobId: JOB_ID,
      jobDir,
      inputPaths: [],
      launcher: fakeCodexLauncher({ scenario: 'hang' })
    })

    // The first `start` only registers the run once it has spawned, so wait for
    // the fake to appear rather than racing it.
    await waitFor(() => runner.isRunning(JOB_ID))

    await expect(
      runner.start({
        jobId: JOB_ID,
        jobDir,
        inputPaths: [],
        launcher: fakeCodexLauncher({ scenario: 'success' })
      })
    ).rejects.toMatchObject({ code: 'ALREADY_RUNNING' })

    runner.cancel(JOB_ID)
    await first
  })

  it('reports a spawn failure instead of throwing', async () => {
    const runner = new CodexRunner()
    const outcome = await runner.start({
      jobId: JOB_ID,
      jobDir,
      inputPaths: [],
      launcher: {
        command: join(workspace.base, 'no-such-executable'),
        prefixArgs: [],
        source: 'path'
      }
    })

    expect(outcome.spawnError?.code).toBe('ENOENT')
    expect(runner.isRunning(JOB_ID)).toBe(false)
    // The log exists even though nothing ran, so the failure is diagnosable.
    expect((await readLines(EVENTS_FILE_NAME))[0]).toContain(STUDIO_META_EVENT_TYPE)
  })
})

describe('CodexRunner.cancel', () => {
  it('ends the hang scenario in well under two seconds and reports cancelled', async () => {
    const runner = new CodexRunner()
    const events: ProgressEvent[] = []
    const started = Date.now()
    const run = runner.start({
      jobId: JOB_ID,
      jobDir,
      inputPaths: [],
      launcher: fakeCodexLauncher({ scenario: 'hang' }),
      progress: new ProgressEmitter(JOB_ID, (event) => events.push(event))
    })

    await waitFor(() => runner.isRunning(JOB_ID))
    expect(runner.cancel(JOB_ID)).toBe(true)

    const outcome = await run

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(outcome.cancelled).toBe(true)
    expect(runner.isRunning(JOB_ID)).toBe(false)
    // The three lines the hang scenario streamed before stopping are kept.
    expect((await readLines(EVENTS_FILE_NAME)).length).toBe(4)
  })

  it('answers false for a job that is not running', () => {
    expect(new CodexRunner().cancel(JOB_ID)).toBe(false)
  })

  /**
   * The point of plan decision Q12: Codex spawns children — the sandbox helper
   * and every shell command it runs — and killing only the process it started
   * would leave them alive holding the job directory.
   *
   * The fake Codex spawns nothing, so this test builds its own two-level tree:
   * a parent that spawns a grandchild and then hangs, and a grandchild that
   * appends a byte to a heartbeat file every 40 ms. After cancel, the heartbeat
   * file must stop growing. Without `/T` on Windows, or without the process
   * group on POSIX, it keeps growing and this test fails.
   *
   * The grandchild is `detached` on purpose. A plain child of a plain child
   * dies with its parent on this machine whatever flags `taskkill` gets, so it
   * cannot tell `/T` apart from `/F`; a detached grandchild survives a bare
   * `taskkill /F` and is killed only by `/T`, which is the behaviour plan
   * decision Q12 is actually about. Measured on Windows 10 19045 with Node
   * 25.2.1 by running this test against both argument lists.
   */
  it('kills the whole process tree, not just the process it started', async () => {
    const heartbeat = join(workspace.base, 'heartbeat.txt')
    const grandchild = join(workspace.base, 'grandchild.mjs')
    const parent = join(workspace.base, 'parent.mjs')

    await writeFile(
      grandchild,
      `import { appendFileSync } from 'node:fs'
const path = ${JSON.stringify(heartbeat)}
const timer = setInterval(() => appendFileSync(path, '.'), 40)
// A safety net: if the tree kill fails, this still exits and leaves no stray
// process behind on the developer's machine.
setTimeout(() => { clearInterval(timer); process.exit(0) }, 8_000)
`,
      'utf8'
    )
    await writeFile(
      parent,
      `import { spawn } from 'node:child_process'
const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], {
  stdio: 'ignore',
  detached: true
})
child.unref()
process.stdout.write('{"type":"thread.started"}\\n')
setInterval(() => {}, 1_000)
`,
      'utf8'
    )

    const runner = new CodexRunner()
    const run = runner.start({
      jobId: JOB_ID,
      jobDir,
      inputPaths: [],
      launcher: { command: process.execPath, prefixArgs: [parent], source: 'path' }
    })

    await waitFor(async () => (await sizeOf(heartbeat)) > 0, 4_000)
    expect(runner.cancel(JOB_ID)).toBe(true)
    await run

    // Give anything still alive time to write several more heartbeats.
    const settled = await afterQuietPeriod(heartbeat, 400)
    const later = await afterQuietPeriod(heartbeat, 400)

    expect(later).toBe(settled)
  }, 20_000)
})

describe('ProgressEmitter', () => {
  it('numbers events from zero and keeps the state between activities', () => {
    const events: ProgressEvent[] = []
    const emitter = new ProgressEmitter(JOB_ID, (event) => events.push(event))

    emitter.emit('queued')
    emitter.emit('running')
    emitter.emitActivity(ACTIVITY.imageGen)

    expect(events.map((event) => [event.seq, event.state, event.activity])).toEqual([
      [0, 'queued', undefined],
      [1, 'running', undefined],
      [2, 'running', ACTIVITY.imageGen]
    ])
  })

  it('refuses a job ID that does not match spec section 6.1', () => {
    expect(() => new ProgressEmitter('../etc')).toThrow(CodexRunError)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await condition()) {
      return
    }

    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition.')
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function afterQuietPeriod(path: string, ms: number): Promise<number> {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

  return sizeOf(path)
}
