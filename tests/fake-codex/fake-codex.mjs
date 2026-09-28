#!/usr/bin/env node
/**
 * The scriptable stand-in for the Codex CLI (plan Task 3.3).
 *
 * Automated tests never start the real `codex` (spec section 13, AGENTS.md).
 * They start this file instead, through the launcher of plan decision Q8:
 *
 * ```js
 * { command: process.execPath, prefixArgs: ['tests/fake-codex/fake-codex.mjs'] }
 * ```
 *
 * so the runner appends `exec --json …` exactly as it would in production and a
 * test can assert the argv without needing a real `.exe` on disk.
 *
 * What it answers:
 *
 * - `--version` prints `codex-cli <FAKE_CODEX_VERSION or 0.158.0>` and exits 0;
 * - `login status` exits with `FAKE_CODEX_LOGIN` (default 0), printing on
 *   stderr like the real CLI does;
 * - `exec` records its argv, replays a JSONL fixture on stdout and then acts
 *   out the scenario named by `FAKE_CODEX_SCENARIO`.
 *
 * See `./README.md` for the scenario table and for what the fixtures are.
 *
 * Plain JavaScript on purpose: it is spawned as a file, not imported, so it
 * must run under `node` with no build step.
 */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/codex-jsonl/0.158.0/', import.meta.url))
const IMAGE_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

/** The version the fake claims, high enough to pass preflight by default. */
const DEFAULT_VERSION = '0.158.0'

/** Milliseconds between JSONL lines, so the runner really sees a stream. */
const DEFAULT_LINE_DELAY_MS = 2

/**
 * A secret and an absolute path, so the normalizer's and the verifier's
 * sanitizers have something to remove. Not a real key: `sk-NOT-A-REAL-KEY`.
 */
const DIRTY_DETAIL =
  'Tried C:\\Users\\example\\AppData\\Roaming\\codex\\config.toml with authorization Bearer sk-NOT-A-REAL-KEY-000000.'

/**
 * What each `FAKE_CODEX_SCENARIO` does. `stopAfterLines` is only for `hang`,
 * which stops mid-stream and waits to be killed.
 */
const SCENARIOS = {
  success: { fixture: 'success.jsonl', exitCode: 0 },
  'capability-unavailable': { fixture: 'capability-unavailable.jsonl', exitCode: 0 },
  'invalid-result': { fixture: 'success.jsonl', exitCode: 0 },
  'nonzero-exit': { fixture: 'error.jsonl', exitCode: 1 },
  hang: { fixture: 'success.jsonl', exitCode: 0, stopAfterLines: 3 },
  'outputs-outside-job': { fixture: 'success.jsonl', exitCode: 0 }
}

const argv = process.argv.slice(2)

await main()

async function main() {
  if (argv.includes('--version') || argv.includes('-V')) {
    await write(
      process.stdout,
      `codex-cli ${process.env['FAKE_CODEX_VERSION'] ?? DEFAULT_VERSION}\n`
    )
    process.exitCode = 0

    return
  }

  if (argv[0] === 'login' && argv[1] === 'status') {
    const code = Number.parseInt(process.env['FAKE_CODEX_LOGIN'] ?? '0', 10)

    // The real 0.27.0 binary prints this on stderr and exits 0; spec section
    // 5.3 only looks at the exit code.
    await write(process.stderr, code === 0 ? 'Logged in using ChatGPT\n' : 'Not logged in\n')
    process.exitCode = code

    return
  }

  if (argv[0] !== 'exec') {
    await write(process.stderr, `fake-codex: unsupported command: ${argv.join(' ')}\n`)
    process.exitCode = 64

    return
  }

  await runExec()
}

async function runExec() {
  const scenarioName = process.env['FAKE_CODEX_SCENARIO'] ?? 'success'
  const scenario = SCENARIOS[scenarioName]

  if (scenario === undefined) {
    await write(process.stderr, `fake-codex: unknown FAKE_CODEX_SCENARIO: ${scenarioName}\n`)
    process.exitCode = 65

    return
  }

  const cwd = process.cwd()
  const jobDir = resolve(optionValue('-C') ?? cwd)

  // Plan Task 3.5 asserts the exact command line from this file. Only the
  // names of the environment variables are recorded, never their values: a
  // test asserts `OPENAI_API_KEY` is absent, and writing secrets from the
  // developer's shell into a file would defeat the point of checking.
  await writeJson(join(cwd, 'argv.json'), {
    argv,
    cwd,
    jobDir,
    scenario: scenarioName,
    execPath: process.execPath,
    envKeys: Object.keys(process.env).sort()
  })

  const lines = await fixtureLines(scenario.fixture)
  const limit = scenario.stopAfterLines ?? lines.length
  const delay = Number.parseInt(process.env['FAKE_CODEX_LINE_DELAY_MS'] ?? '', 10)
  const lineDelayMs = Number.isNaN(delay) ? DEFAULT_LINE_DELAY_MS : delay

  for (const line of lines.slice(0, limit)) {
    await write(process.stdout, `${line}\n`)

    if (lineDelayMs > 0) {
      await sleep(lineDelayMs)
    }
  }

  if (scenarioName === 'hang') {
    await hangUntilKilled()

    return
  }

  await writeLastMessage(lines)
  await actOutScenario(scenarioName, jobDir)

  process.exitCode = scenario.exitCode
}

/** Everything a scenario does to the job directory after the stream. */
async function actOutScenario(scenarioName, jobDir) {
  const jobId = await resolveJobId(jobDir)
  const outputs = join(jobDir, 'outputs')

  switch (scenarioName) {
    case 'success': {
      await mkdir(outputs, { recursive: true })
      await copyFile(join(IMAGE_DIR, 'style-2x3.png'), join(outputs, '001.png'))
      await writeJson(join(jobDir, 'codex-result.json'), {
        schemaVersion: 1,
        jobId,
        status: 'succeeded',
        outputs: [{ path: 'outputs/001.png' }],
        error: null
      })

      return
    }

    case 'capability-unavailable': {
      await writeJson(join(jobDir, 'codex-result.json'), {
        schemaVersion: 1,
        jobId,
        status: 'failed',
        outputs: [],
        error: {
          code: 'IMAGE_CAPABILITY_UNAVAILABLE',
          message: `The image_gen tool is not available in this session. ${DIRTY_DETAIL}`
        }
      })

      return
    }

    case 'invalid-result': {
      // The image is real; the report is not. An error code outside the four
      // spec section 7.1 allows, a `status` that contradicts `error`, and a
      // field the strict schema does not know.
      await mkdir(outputs, { recursive: true })
      await copyFile(join(IMAGE_DIR, 'style-2x3.png'), join(outputs, '001.png'))
      await writeJson(join(jobDir, 'codex-result.json'), {
        schemaVersion: 1,
        jobId,
        status: 'succeeded',
        outputs: [{ path: 'outputs/001.png', width: 1024 }],
        error: { code: 'SOMETHING_ELSE', message: 'not one of the four allowed codes' }
      })

      return
    }

    case 'nonzero-exit': {
      // Exits 1 with no codex-result.json at all: spec section 7.3's
      // `GENERATION_FAILED`.
      await write(process.stderr, 'fake-codex: image generation failed\n')

      return
    }

    case 'outputs-outside-job': {
      // Claims an output that escapes the job directory, and really puts a
      // file there, so the verifier of plan Task 3.6 refuses a path rather
      // than a missing file.
      await mkdir(outputs, { recursive: true })
      await copyFile(join(IMAGE_DIR, 'style-2x3.png'), join(jobDir, '..', 'fake-codex-escape.png'))
      await writeJson(join(jobDir, 'codex-result.json'), {
        schemaVersion: 1,
        jobId,
        status: 'succeeded',
        outputs: [{ path: 'outputs/../../fake-codex-escape.png' }],
        error: null
      })

      return
    }

    default:
      return
  }
}

/** Waits to be killed, the way a stuck Codex would (plan decision Q12). */
async function hangUntilKilled() {
  return new Promise(() => {
    const keepAlive = setInterval(() => {}, 1_000)

    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
      process.on(signal, () => {
        clearInterval(keepAlive)
        process.exit(143)
      })
    }
  })
}

/**
 * The job ID to put in `codex-result.json`: the one in `job.json` when the
 * runner materialized a real job, otherwise the directory name, which is the
 * job ID by construction (spec section 9).
 */
async function resolveJobId(jobDir) {
  try {
    const packet = JSON.parse(await readFile(join(jobDir, 'job.json'), 'utf8'))

    if (typeof packet.jobId === 'string') {
      return packet.jobId
    }
  } catch {
    // No job.json: a test driving the fake on its own.
  }

  return process.env['FAKE_CODEX_JOB_ID'] ?? basename(jobDir)
}

/** Mirrors `--output-last-message`, which the real CLI writes on exit. */
async function writeLastMessage(lines) {
  const target = optionValue('--output-last-message')

  if (target === undefined) {
    return
  }

  let message = ''

  for (const line of lines) {
    try {
      const event = JSON.parse(line)

      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        message = event.item.text ?? ''
      }
    } catch {
      // A fixture line that is not JSON has no message in it.
    }
  }

  await writeFile(resolve(target), `${message}\n`, 'utf8')
}

async function fixtureLines(name) {
  const raw = await readFile(join(FIXTURE_DIR, name), 'utf8')

  return raw.split(/\r?\n/).filter((line) => line.trim() !== '')
}

/** The value after `flag` in argv, or `undefined`. */
function optionValue(flag) {
  const index = argv.indexOf(flag)

  return index === -1 ? undefined : argv[index + 1]
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Resolves once the bytes are handed to the OS, so nothing is lost on exit. */
async function write(stream, text) {
  return new Promise((resolvePromise, rejectPromise) => {
    stream.write(text, (error) => (error ? rejectPromise(error) : resolvePromise()))
  })
}

async function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
