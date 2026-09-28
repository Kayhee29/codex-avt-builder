/**
 * The job orchestrator and interrupted-job recovery (plan Task 3.7).
 *
 * Everything here drives the fake Codex of plan Task 3.3 through the real
 * runner and the real verifier, so what is under test is the state machine of
 * spec section 5.5 and the promise of spec section 7 that the main process
 * writes `result.json` on every path — including the path where Codex never
 * ran at all.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PreflightOutcome } from '../../src/main/codex-preflight.ts'
import { CodexRunner, EVENTS_FILE_NAME } from '../../src/main/codex-runner.ts'
import { JobMaterializer } from '../../src/main/job-materializer.ts'
import {
  JobError,
  JobService,
  STUDIO_PREFLIGHT_EVENT_TYPE,
  type PreflightRunner
} from '../../src/main/jobs.ts'
import { recoverInterruptedJobs } from '../../src/main/recovery.ts'
import { ReferenceRegistry } from '../../src/main/reference-registry.ts'
import { RESULT_FILE_NAME } from '../../src/main/result-verifier.ts'
import type { BuilderStateInput } from '../../src/shared/ipc-contract.ts'
import type { ProgressEvent } from '../../src/shared/progress.ts'
import { buildPrompt, sha256Hex, type OrderedReference } from '../../src/shared/prompt-builder.ts'
import { assignReferenceLabels } from '../../src/shared/reference-roles.ts'
import {
  ResultSchema,
  SCHEMA_VERSION,
  type BuilderReference,
  type BuilderState,
  type Result
} from '../../src/shared/schemas.ts'
import { fakeCodexLauncher, type FakeCodexScenario } from '../helpers/fake-codex.ts'
import { createTempWorkspace, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const IMAGE_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

const FIRST_NOW = new Date('2026-09-28T10:00:00.000Z')

let workspace: TempWorkspace
let registry: ReferenceRegistry
let materializer: JobMaterializer
let runner: CodexRunner
let events: ProgressEvent[]
let revealed: string[]
let clock: number
let stylePath: string

/** A monotonic clock, so startedAt and completedAt are distinguishable. */
function now(): Date {
  clock += 1000

  return new Date(FIRST_NOW.getTime() + clock)
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  registry = new ReferenceRegistry()
  materializer = new JobMaterializer({ workspace, registry, now: () => FIRST_NOW })
  runner = new CodexRunner()
  events = []
  revealed = []
  clock = 0
  stylePath = join(workspace.base, 'master-style.png')

  await copyFile(join(IMAGE_DIR, 'style-2x3.png'), stylePath)
})

afterEach(async () => {
  runner.cancelAll()
  await workspace.remove()
})

/** A preflight that always passes, pointed at one fake-Codex scenario. */
function passingPreflight(scenario: FakeCodexScenario): PreflightRunner {
  return {
    run: async (): Promise<PreflightOutcome> => ({
      result: { ok: true, version: '0.158.0', executable: process.execPath },
      launcher: fakeCodexLauncher({ scenario })
    })
  }
}

/** A preflight that fails the way a machine without Codex does. */
function failingPreflight(attempts: readonly string[] = []): PreflightRunner {
  return {
    run: async (): Promise<PreflightOutcome> => ({
      result: {
        ok: false,
        code: 'CODEX_NOT_FOUND',
        message: 'Codex CLI was not found. Install @openai/codex globally.'
      },
      launcher: null,
      ...(attempts.length === 0 ? {} : { attempts })
    })
  }
}

function service(preflight: PreflightRunner): JobService {
  return new JobService({
    workspace,
    materializer,
    preflight,
    runner,
    registry,
    now,
    onProgress: (event) => events.push(event),
    reveal: (path) => {
      revealed.push(path)
    }
  })
}

async function builderInput(
  overrides: Partial<BuilderState> = {}
): Promise<{ state: BuilderStateInput; promptSha256: string }> {
  const reference = await registry.createReference(stylePath, {
    role: 'style',
    note: 'Rough black outline'
  })
  const state: BuilderState = {
    schemaVersion: SCHEMA_VERSION,
    subject: { name: 'Richard Nixon', description: 'Chibi historical character portrait' },
    references: [reference],
    // The fake writes `style-2x3.png` into outputs/, so 2:3 and png are what a
    // clean run produces and the warnings list stays empty.
    output: { aspectRatio: '2:3', background: 'pale warm paper', format: 'png', count: 1 },
    negativeConstraints: [],
    source: { preset: null, anchor: null },
    ...overrides
  }

  return { state: toInput(state), promptSha256: await previewChecksum(state) }
}

function toInput(state: BuilderState): BuilderStateInput {
  return {
    ...state,
    references: state.references.map(
      ({ displayPath: _displayPath, thumbnail: _thumbnail, ...rest }) => rest
    )
  }
}

async function previewChecksum(state: BuilderState): Promise<string> {
  const references = assignReferenceLabels(state.references).map((reference): OrderedReference => ({
    label: reference.label,
    role: reference.role,
    originalName: reference.originalName,
    ...(reference.note === undefined ? {} : { note: reference.note })
  }))

  return sha256Hex(buildPrompt(state, references).markdown)
}

async function readResult(jobId: string): Promise<Result> {
  const raw = await readFile(join(workspace.jobs, jobId, RESULT_FILE_NAME), 'utf8')

  return ResultSchema.parse(JSON.parse(raw))
}

function states(): string[] {
  const seen: string[] = []

  for (const event of events) {
    if (seen[seen.length - 1] !== event.state) {
      seen.push(event.state)
    }
  }

  return seen
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition.')
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

describe('JobService.generate', () => {
  it('walks queued, preflight, running, verifying, succeeded in that order', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)
    const result = await started.completed

    expect(states()).toEqual(['queued', 'preflight', 'running', 'verifying', 'succeeded'])
    expect(result.status).toBe('succeeded')
    expect(result.error).toBeNull()
    expect(result.warnings).toEqual([])
    expect(result.outputs).toEqual([
      {
        path: 'outputs/001.png',
        mimeType: 'image/png',
        width: 2,
        height: 3,
        sizeBytes: 75,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    ])
    expect(await readResult(started.jobId)).toEqual(result)
    expect(jobs.isRunning(started.jobId)).toBe(false)
  })

  it('numbers every progress event once, from zero', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()

    await (
      await jobs.generate(state, promptSha256)
    ).completed

    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index))
    expect(events.at(-1)?.state).toBe('succeeded')
  })

  it('records the executor it really used', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const result = await (await jobs.generate(state, promptSha256)).completed

    expect(result.executor).toEqual({
      codexVersion: '0.158.0',
      executable: process.execPath,
      exitCode: 0,
      signal: null
    })
  })

  it('fails the job when Codex reports no image capability', async () => {
    const jobs = service(passingPreflight('capability-unavailable'))
    const { state, promptSha256 } = await builderInput()
    const result = await (await jobs.generate(state, promptSha256)).completed

    expect(states()).toEqual(['queued', 'preflight', 'running', 'verifying', 'failed'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('IMAGE_CAPABILITY_UNAVAILABLE')
    expect(result.error?.message).not.toContain('sk-')
  })

  it('fails the job when exit code 0 came with an unusable report', async () => {
    const jobs = service(passingPreflight('invalid-result'))
    const { state, promptSha256 } = await builderInput()
    const result = await (await jobs.generate(state, promptSha256)).completed

    // Spec section 5.6: exit code 0 is never enough on its own.
    expect(result.executor.exitCode).toBe(0)
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('INVALID_RESULT')
  })

  it('refuses an invalid builder state and leaves no job directory behind', async () => {
    const jobs = service(passingPreflight('success'))
    const { state } = await builderInput()

    await expect(jobs.generate(state, 'f'.repeat(64))).rejects.toMatchObject({
      name: 'JobError',
      code: 'INVALID_JOB'
    })
    expect(await jobs.list()).toEqual([])
    expect(events).toEqual([])
  })
})

describe('JobService.generate when preflight fails', () => {
  it('still writes result.json, with a null codexVersion', async () => {
    const jobs = service(failingPreflight(['C:\\probe\\one.exe', 'C:\\probe\\two.exe']))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)
    const result = await started.completed

    expect(states()).toEqual(['queued', 'preflight', 'failed'])
    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('CODEX_NOT_FOUND')
    // Spec section 7.2: Codex never ran, so nothing about it is claimed.
    expect(result.executor).toEqual({
      codexVersion: null,
      executable: null,
      exitCode: null,
      signal: null
    })
    expect(result.outputs).toEqual([])
    expect(await readResult(started.jobId)).toEqual(result)
  })

  it('writes the probed paths into events.jsonl for diagnosis (spec section 5.3)', async () => {
    const attempts = ['C:\\probe\\one.exe', 'C:\\probe\\two.exe']
    const jobs = service(failingPreflight(attempts))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)

    await started.completed

    const lines = (await readFile(join(started.directory, EVENTS_FILE_NAME), 'utf8'))
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const preflight = lines.find((line) => line['type'] === STUDIO_PREFLIGHT_EVENT_TYPE)

    expect(preflight?.['code']).toBe('CODEX_NOT_FOUND')
    expect(preflight?.['attempts']).toEqual(attempts)
  })
})

describe('JobService.cancel', () => {
  it('ends a running job as cancelled with CANCELLED', async () => {
    const jobs = service(passingPreflight('hang'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)

    await waitFor(() => runner.isRunning(started.jobId))
    expect(jobs.cancel(started.jobId)).toBe(true)

    const result = await started.completed

    expect(states()).toEqual(['queued', 'preflight', 'running', 'cancelled'])
    expect(result.status).toBe('cancelled')
    expect(result.error?.code).toBe('CANCELLED')
    // A cancelled run is never verified: there is nothing to trust.
    expect(result.outputs).toEqual([])
    expect(await readResult(started.jobId)).toEqual(result)
  })

  it('answers false for a job that is not running', async () => {
    const jobs = service(passingPreflight('success'))

    expect(jobs.cancel('2026-09-28-nobody-001')).toBe(false)
  })

  it('refuses a job ID that does not match spec section 6.1', () => {
    const jobs = service(passingPreflight('success'))

    expect(() => jobs.cancel('../etc')).toThrow(JobError)
  })
})

describe('JobService.get', () => {
  it('refuses an invalid job ID before touching the filesystem', async () => {
    const jobs = service(passingPreflight('success'))

    for (const bad of ['../etc', '..', 'C:\\Windows', '2026-09-28-x', '']) {
      await expect(jobs.get(bad)).rejects.toMatchObject({
        name: 'JobError',
        code: 'INVALID_REQUEST'
      })
    }
  })

  it('reports NOT_FOUND for a well-formed ID with no directory', async () => {
    const jobs = service(passingPreflight('success'))

    await expect(jobs.get('2026-09-28-nobody-001')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('returns the packet, the result and a handle per input', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)

    await started.completed

    const got = await jobs.get(started.jobId)

    expect(got.job.jobId).toBe(started.jobId)
    expect(got.result?.status).toBe('succeeded')
    expect(got.references).toHaveLength(1)
    expect(got.references[0]).toMatchObject({ role: 'style', originalName: 'master-style.png' })
    // Spec section 11: a handle never carries a path the renderer could use.
    expect(Object.keys(got.references[0] as BuilderReference)).not.toContain('path')
  })
})

describe('JobService.list', () => {
  it('reports a finished job from its result.json, newest first', async () => {
    const jobs = service(passingPreflight('success'))

    for (let index = 0; index < 2; index += 1) {
      const { state, promptSha256 } = await builderInput()

      await (
        await jobs.generate(state, promptSha256)
      ).completed
    }

    const summaries = await jobs.list()

    expect(summaries).toHaveLength(2)
    expect(summaries.map((summary) => summary.state)).toEqual(['succeeded', 'succeeded'])
    expect(summaries[0]?.subjectName).toBe('Richard Nixon')
    expect(summaries[0]?.outputCount).toBe(1)
    expect(summaries[0]?.errorCode).toBeNull()
    expect(summaries[0]?.thumbnailDataUrl).toBeNull()
  })

  it('shows a job with no result.json as failed with INTERRUPTED (spec section 12)', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)

    await started.completed
    await rm(join(started.directory, RESULT_FILE_NAME))

    const summaries = await jobs.list()

    expect(summaries[0]?.state).toBe('failed')
    expect(summaries[0]?.errorCode).toBe('INTERRUPTED')
    expect(summaries[0]?.completedAt).toBeNull()
  })

  it('ignores a directory in jobs/ that is not a job', async () => {
    const jobs = service(passingPreflight('success'))

    await mkdir(join(workspace.jobs, 'not-a-job-id'), { recursive: true })
    await mkdir(join(workspace.jobs, '2026-09-28-empty-001'), { recursive: true })

    expect(await jobs.list()).toEqual([])
  })
})

describe('JobService.openFolder', () => {
  it('reveals job.json inside the job directory', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)

    await started.completed

    expect(await jobs.openFolder(started.jobId)).toBe(true)
    expect(revealed).toEqual([join(started.directory, 'job.json')])
  })

  it('refuses an invalid ID and reports a missing job', async () => {
    const jobs = service(passingPreflight('success'))

    await expect(jobs.openFolder('../etc')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(jobs.openFolder('2026-09-28-nobody-001')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
    expect(revealed).toEqual([])
  })
})

describe('recoverInterruptedJobs (plan decision Q13)', () => {
  it('marks a job with job.json and no result.json as failed with INTERRUPTED', async () => {
    const { state, promptSha256 } = await builderInput()
    const materialized = await materializer.materialize(state, promptSha256)

    expect(await recoverInterruptedJobs({ workspace, now })).toEqual([materialized.jobId])

    const result = await readResult(materialized.jobId)

    expect(result.status).toBe('failed')
    expect(result.error?.code).toBe('INTERRUPTED')
    expect(result.startedAt).toBe(materialized.packet.createdAt)
    expect(result.executor).toEqual({
      codexVersion: null,
      executable: null,
      exitCode: null,
      signal: null
    })
  })

  it('leaves a finished job alone and is safe to run twice', async () => {
    const jobs = service(passingPreflight('success'))
    const { state, promptSha256 } = await builderInput()
    const started = await jobs.generate(state, promptSha256)
    const finished = await started.completed

    expect(await recoverInterruptedJobs({ workspace, now })).toEqual([])
    expect(await readResult(started.jobId)).toEqual(finished)

    expect(await recoverInterruptedJobs({ workspace, now })).toEqual([])
  })

  it('never deletes the logs a failed run left behind (spec section 10)', async () => {
    const { state, promptSha256 } = await builderInput()
    const materialized = await materializer.materialize(state, promptSha256)

    await writeFile(join(materialized.directory, EVENTS_FILE_NAME), '{"type":"studio.meta"}\n')

    await recoverInterruptedJobs({ workspace, now })

    expect((await stat(join(materialized.directory, EVENTS_FILE_NAME))).size).toBeGreaterThan(0)
    expect((await stat(join(materialized.directory, 'job.json'))).size).toBeGreaterThan(0)
  })

  it('skips a job the caller says is still running', async () => {
    const { state, promptSha256 } = await builderInput()
    const materialized = await materializer.materialize(state, promptSha256)

    expect(await recoverInterruptedJobs({ workspace, now, isRunning: () => true })).toEqual([])
    await expect(readResult(materialized.jobId)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('ignores a directory with no readable job.json', async () => {
    await mkdir(join(workspace.jobs, '2026-09-28-broken-001'), { recursive: true })
    await writeFile(join(workspace.jobs, '2026-09-28-broken-001', 'job.json'), 'not json', 'utf8')

    expect(await recoverInterruptedJobs({ workspace, now })).toEqual([])
    await expect(
      stat(join(workspace.jobs, '2026-09-28-broken-001', RESULT_FILE_NAME))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
