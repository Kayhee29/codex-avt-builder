/**
 * The result verifier against the fake Codex of plan Task 3.3 (plan Task 3.6).
 *
 * Spec section 5.6 is the rule these tests exist to defend: a zero exit code is
 * never enough. Every scenario here really runs the fake through the runner, so
 * the files being verified are files a process wrote, not fixtures shaped by
 * hand — except the two cases the fake deliberately does not cover, which its
 * README says to build in this file.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CodexRunner, STDERR_FILE_NAME } from '../../src/main/codex-runner.ts'
import {
  buildResult,
  CODEX_RESULT_FILE_NAME,
  detectSandboxUnavailable,
  readResultJson,
  RESULT_FILE_NAME,
  verifyCodexRun,
  writeResultJson,
  type Verification
} from '../../src/main/result-verifier.ts'
import type { JobPacket } from '../../src/shared/schemas.ts'
import { fakeCodexLauncher, type FakeCodexScenario } from '../helpers/fake-codex.ts'
import { createTempWorkspace, linkFile, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const JOB_ID = '2026-09-28-richard-nixon-001'

const IMAGE_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

/** `style-2x3.png` is 2 wide and 3 high, so a 2:3 request matches exactly. */
const REQUEST: JobPacket['output'] = {
  aspectRatio: '2:3',
  background: 'pale warm paper',
  format: 'png',
  count: 1
}

let workspace: TempWorkspace
let jobDir: string

beforeEach(async () => {
  workspace = await createTempWorkspace()
  jobDir = join(workspace.jobs, JOB_ID)
  await mkdir(join(jobDir, 'outputs'), { recursive: true })
})

afterEach(async () => {
  await workspace.remove()
})

/** Runs a scenario end to end and verifies whatever it left behind. */
async function runAndVerify(
  scenario: FakeCodexScenario,
  job: Pick<JobPacket, 'jobId' | 'output'> = { jobId: JOB_ID, output: REQUEST }
): Promise<Verification> {
  const outcome = await new CodexRunner().start({
    jobId: JOB_ID,
    jobDir,
    inputPaths: [],
    launcher: fakeCodexLauncher({ scenario })
  })

  return verifyCodexRun({ jobDir, job, exitCode: outcome.exitCode })
}

/** Verifies a job directory the test wrote itself, with no process involved. */
async function verifyOnly(
  options: {
    exitCode?: number | null
    job?: Pick<JobPacket, 'jobId' | 'output'>
    stderr?: string
  } = {}
): Promise<Verification> {
  return verifyCodexRun({
    jobDir,
    job: options.job ?? { jobId: JOB_ID, output: REQUEST },
    exitCode: options.exitCode ?? 0,
    ...(options.stderr === undefined ? {} : { stderr: options.stderr })
  })
}

async function writeCodexResult(value: unknown): Promise<void> {
  await writeFile(
    join(jobDir, CODEX_RESULT_FILE_NAME),
    `${JSON.stringify(value, null, 2)}\n`,
    'utf8'
  )
}

async function copyFixture(name: string, into: string): Promise<void> {
  await copyFile(join(IMAGE_DIR, name), join(jobDir, into))
}

describe('verifyCodexRun on a real fake-Codex run', () => {
  it('succeeds for the success scenario and measures the file, not the claim', async () => {
    const verification = await runAndVerify('success')

    expect(verification.status).toBe('succeeded')
    expect(verification.error).toBeNull()
    expect(verification.warnings).toEqual([])
    // Codex declared only a path. Every number below was read back off disk:
    // 2x3 is what `style-2x3.png` really is (spec section 7.2).
    expect(verification.outputs).toEqual([
      {
        path: 'outputs/001.png',
        mimeType: 'image/png',
        width: 2,
        height: 3,
        sizeBytes: 75,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    ])
  })

  it('measures the sha256 of the bytes that are actually there', async () => {
    const verification = await runAndVerify('success')
    const bytes = await readFile(join(jobDir, 'outputs', '001.png'))
    const { createHash } = await import('node:crypto')

    expect(verification.outputs[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('reports INVALID_RESULT when the claim does not match the schema', async () => {
    const verification = await runAndVerify('invalid-result')

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('INVALID_RESULT')
    // The image the scenario wrote is real; the report about it is not, so the
    // job still fails (spec section 5.6).
    expect(verification.outputs).toEqual([])
  })

  it('reports INVALID_RESULT for an output path outside the job directory', async () => {
    const verification = await runAndVerify('outputs-outside-job')

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('INVALID_RESULT')
  })

  it('reports GENERATION_FAILED when the process exits non-zero with no report', async () => {
    const verification = await runAndVerify('nonzero-exit')

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('GENERATION_FAILED')
    expect(verification.outputs).toEqual([])
  })

  it('passes IMAGE_CAPABILITY_UNAVAILABLE through with a sanitized message', async () => {
    const verification = await runAndVerify('capability-unavailable')

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('IMAGE_CAPABILITY_UNAVAILABLE')
    expect(verification.error?.message).toContain('image_gen tool is not available')
    // The fake's message carries an absolute path and a fake key; neither may
    // reach the renderer (spec section 11).
    expect(verification.error?.message).not.toContain('C:\\Users')
    expect(verification.error?.message).not.toContain('sk-NOT-A-REAL-KEY')
  })
})

describe('verifyCodexRun on cases the fake does not cover', () => {
  /** Spec section 7.3, third bullet. The fake has no scenario for this. */
  it('reports INVALID_RESULT for exit 0, status succeeded and no outputs', async () => {
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [],
      error: null
    })

    const verification = await verifyOnly()

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('INVALID_RESULT')
    expect(verification.error?.message).toContain('listed no image')
  })

  /**
   * Spec section 7.3 and section 11: a symlink is never an acceptable output.
   *
   * Creating one on Windows needs developer mode or elevation, so `linkFile`
   * says when the OS refused and the test skips rather than passing for the
   * wrong reason.
   */
  it('reports INVALID_RESULT for a symlink inside outputs/', async (context) => {
    await copyFixture('style-2x3.png', 'real.png')

    const kind = await linkFile(join(jobDir, 'real.png'), join(jobDir, 'outputs', '001.png'))

    if (kind === 'none') {
      // Reported as skipped rather than passed: this machine refused the link,
      // so nothing below was exercised.
      context.skip()
    }

    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: null
    })

    const verification = await verifyOnly()

    expect(verification.status).toBe('failed')
    expect(verification.error?.code).toBe('INVALID_RESULT')
    expect(verification.error?.message).toContain('symlink')
  })

  it('reports INVALID_RESULT when the declared file is simply not there', async () => {
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: null
    })

    const verification = await verifyOnly()

    expect(verification.error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when the declared file is not really an image', async () => {
    await copyFixture('text-pretending-to-be.png', 'outputs/001.png')
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: null
    })

    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when codex-result.json is not JSON at all', async () => {
    await writeFile(join(jobDir, CODEX_RESULT_FILE_NAME), 'not json', 'utf8')

    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when the report names another job', async () => {
    await copyFixture('style-2x3.png', 'outputs/001.png')
    await writeCodexResult({
      schemaVersion: 1,
      jobId: '2026-09-28-someone-else-002',
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: null
    })

    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when success and an error are claimed together', async () => {
    await copyFixture('style-2x3.png', 'outputs/001.png')
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: { code: 'GENERATION_FAILED', message: 'it did not work' }
    })

    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when a failure is claimed without a reason', async () => {
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'failed',
      outputs: [],
      error: null
    })

    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })

  it('reports INVALID_RESULT when exit 0 leaves no codex-result.json', async () => {
    expect((await verifyOnly()).error?.code).toBe('INVALID_RESULT')
  })
})

describe('warnings, which never fail a job (spec section 7.3)', () => {
  beforeEach(async () => {
    await copyFixture('style-2x3.png', 'outputs/001.png')
  })

  async function declareOne(): Promise<void> {
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }],
      error: null
    })
  }

  it('warns about a file in outputs/ that was never declared', async () => {
    await copyFixture('outfit-6x5.webp', 'outputs/stray.webp')
    await declareOne()

    const verification = await verifyOnly()

    expect(verification.status).toBe('succeeded')
    expect(verification.warnings).toEqual([expect.stringContaining('stray.webp')])
    expect(verification.outputs).toHaveLength(1)
  })

  it('warns when the format differs from what job.json asked for', async () => {
    await declareOne()

    const verification = await verifyOnly({
      job: { jobId: JOB_ID, output: { ...REQUEST, format: 'webp' } }
    })

    expect(verification.status).toBe('succeeded')
    expect(verification.warnings).toEqual([expect.stringContaining('asked for webp')])
  })

  it('warns when the aspect ratio differs from what job.json asked for', async () => {
    await declareOne()

    const verification = await verifyOnly({
      job: { jobId: JOB_ID, output: { ...REQUEST, aspectRatio: '1:1' } }
    })

    expect(verification.status).toBe('succeeded')
    expect(verification.warnings).toEqual([expect.stringContaining('2x3')])
  })

  it('warns when fewer images came back than the job asked for', async () => {
    await declareOne()

    const verification = await verifyOnly({
      job: { jobId: JOB_ID, output: { ...REQUEST, count: 3 } }
    })

    expect(verification.status).toBe('succeeded')
    expect(verification.warnings).toEqual([expect.stringContaining('asked for 3 images')])
  })

  it('warns and ignores a duplicate declaration', async () => {
    await writeCodexResult({
      schemaVersion: 1,
      jobId: JOB_ID,
      status: 'succeeded',
      outputs: [{ path: 'outputs/001.png' }, { path: 'outputs/001.png' }],
      error: null
    })

    const verification = await verifyOnly()

    expect(verification.status).toBe('succeeded')
    expect(verification.outputs).toHaveLength(1)
    expect(verification.warnings).toEqual([expect.stringContaining('twice')])
  })

  it('says nothing when the measurements match the request', async () => {
    await declareOne()

    expect((await verifyOnly()).warnings).toEqual([])
  })
})

describe('CODEX_SANDBOX_UNAVAILABLE (spec section 5.3)', () => {
  const messages = [
    'error: the Windows sandbox is not available on this machine',
    'failed to create sandbox: operation not permitted',
    'codex: sandbox setup is required before exec can run',
    'sandbox requires administrator privileges to set up'
  ]

  for (const message of messages) {
    it(`detects ${JSON.stringify(message.slice(0, 32))}`, () => {
      expect(detectSandboxUnavailable(message)).toBe(true)
    })
  }

  it('does not fire on ordinary stderr', () => {
    expect(detectSandboxUnavailable('fake-codex: image generation failed\n')).toBe(false)
    expect(detectSandboxUnavailable('running inside the workspace-write sandbox\n')).toBe(false)
  })

  it('reads stderr.log itself and maps it to CODEX_SANDBOX_UNAVAILABLE', async () => {
    await writeFile(
      join(jobDir, STDERR_FILE_NAME),
      'codex: failed to create sandbox: run the setup once\n',
      'utf8'
    )

    const verification = await verifyCodexRun({
      jobDir,
      job: { jobId: JOB_ID, output: REQUEST },
      exitCode: 1
    })

    expect(verification.error?.code).toBe('CODEX_SANDBOX_UNAVAILABLE')
    expect(verification.error?.message).toContain('sandbox setup')
  })

  it('takes precedence over the missing report, which would say GENERATION_FAILED', async () => {
    const withoutStderr = await verifyOnly({ exitCode: 1, stderr: '' })

    expect(withoutStderr.error?.code).toBe('GENERATION_FAILED')

    const withStderr = await verifyOnly({
      exitCode: 1,
      stderr: 'error: sandbox is not available on this machine'
    })

    expect(withStderr.error?.code).toBe('CODEX_SANDBOX_UNAVAILABLE')
  })
})

describe('result.json', () => {
  it('is written atomically and reads back through the schema', async () => {
    const result = buildResult({
      jobId: JOB_ID,
      status: 'failed',
      startedAt: '2026-09-28T10:00:00Z',
      completedAt: '2026-09-28T10:00:01Z',
      // Spec section 7: main writes result.json even when Codex never ran.
      executor: { codexVersion: null, executable: null, exitCode: null, signal: null },
      error: { code: 'CODEX_NOT_FOUND', message: 'Codex CLI was not found.' }
    })

    await writeResultJson(jobDir, result)

    expect(await readResultJson(jobDir)).toEqual(result)
    expect(JSON.parse(await readFile(join(jobDir, RESULT_FILE_NAME), 'utf8'))).toEqual(result)
  })

  it('answers null when there is no result.json, and when it is corrupt', async () => {
    expect(await readResultJson(jobDir)).toBeNull()

    await writeFile(join(jobDir, RESULT_FILE_NAME), '{ not json', 'utf8')
    expect(await readResultJson(jobDir)).toBeNull()

    await writeFile(join(jobDir, RESULT_FILE_NAME), '{"schemaVersion":1}', 'utf8')
    expect(await readResultJson(jobDir)).toBeNull()
  })

  it('refuses to write a result the UI could not read', () => {
    expect(() =>
      buildResult({
        jobId: 'not a job id',
        status: 'succeeded',
        startedAt: '2026-09-28T10:00:00Z',
        completedAt: '2026-09-28T10:00:01Z',
        executor: { codexVersion: null, executable: null, exitCode: null, signal: null }
      })
    ).toThrow()
  })

  it('leaves no temporary file behind', async () => {
    await writeResultJson(
      jobDir,
      buildResult({
        jobId: JOB_ID,
        status: 'cancelled',
        startedAt: '2026-09-28T10:00:00Z',
        completedAt: '2026-09-28T10:00:01Z',
        executor: { codexVersion: '0.158.0', executable: 'codex', exitCode: null, signal: null },
        error: { code: 'CANCELLED', message: 'You cancelled this job.' }
      })
    )

    await expect(rm(join(jobDir, `${RESULT_FILE_NAME}.tmp`))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})
