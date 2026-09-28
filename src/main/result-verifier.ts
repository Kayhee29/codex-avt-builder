/**
 * Turning what Codex claimed into what actually happened (plan Task 3.6, spec
 * sections 5.6 and 7).
 *
 * There are two result files and they have different owners:
 *
 * | File                | Written by | What it is                            |
 * | ------------------- | ---------- | ------------------------------------- |
 * | `codex-result.json` | Codex CLI  | the executor's **claim**              |
 * | `result.json`       | main       | the **verified** truth the UI reads   |
 *
 * A zero exit code is never enough (spec section 5.6). Codex's claim is parsed,
 * and then every file it names is opened and measured again: `mimeType` comes
 * from magic bytes, `width` and `height` from the image header, `sizeBytes` and
 * `sha256` from the bytes on disk. Nothing in `result.json` is copied from
 * `codex-result.json` except the fact that a path was declared at all
 * (spec section 7.2).
 *
 * The distinction spec section 7.3 draws between a failure and a warning is the
 * other half of this file:
 *
 * - a missing, malformed or contradictory claim, a declared output that is not
 *   a readable PNG/JPEG/WebP inside `outputs/`, or a symlink, fails the job;
 * - a file in `outputs/` nobody declared, or a size, ratio, format or count
 *   that differs from what `job.json` asked for, is a warning and the job still
 *   succeeds. `job.json`'s `output` is a request, not a guarantee
 *   (spec section 6.2).
 *
 * The main process writes `result.json` on every path, including when Codex
 * never ran; {@link buildResult} and {@link writeResultJson} are how the
 * orchestrator of plan Task 3.7 does that for preflight failures, cancels and
 * interrupted jobs too.
 *
 * Node built-ins are allowed here; Electron is not imported at all.
 */
import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  CodexResultSchema,
  ResultSchema,
  SCHEMA_VERSION,
  type CodexResult,
  type ImageFormat,
  type JobPacket,
  type Result,
  type ResultErrorCode,
  type ResultExecutor,
  type ResultOutput,
  type ResultStatus
} from '../shared/schemas.ts'

import { STDERR_FILE_NAME } from './codex-runner.ts'
import { imageExtension, ImageInspectError, inspectImage } from './image-inspect.ts'
import { OUTPUTS_DIRECTORY } from './job-materializer.ts'
import { sanitizeMessage } from './jsonl-normalizer.ts'
import { writeJsonAtomically } from './library.ts'
import { safeJoin, UnsafePathError } from './workspace.ts'

/** Codex's own report (spec section 7.1). The UI never reads this file. */
export const CODEX_RESULT_FILE_NAME = 'codex-result.json'

/** The verified result (spec section 7.2). The only file the UI reads. */
export const RESULT_FILE_NAME = 'result.json'

/** How much of `stderr.log` is scanned for the sandbox message. */
export const MAX_STDERR_SCAN_BYTES = 64 * 1024

/** How far the measured aspect ratio may drift before it is worth a warning. */
export const ASPECT_RATIO_TOLERANCE = 0.02

/** `3:4`, the shape `job.json` stores an aspect ratio in (spec section 6.2). */
const ASPECT_RATIO = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/

/**
 * Lines in Codex's stderr that mean the sandbox could not be built
 * (spec sections 5.3 and 7.4, `CODEX_SANDBOX_UNAVAILABLE`).
 *
 * On Windows the native sandbox needs build 1809 or newer and one elevated
 * setup that Codex CLI performs itself; this app never runs that setup and
 * never falls back to `danger-full-access` to get around it (spec section 5.3).
 * Telling the user which of the two it is depends on recognising the message.
 *
 * These patterns are inferred from the spec's prose, not captured from a real
 * CLI — no machine here runs a Codex new enough to produce one (see
 * `tests/fake-codex/README.md`). Plan Task 6.3 captures real output; if a
 * sandbox failure then shows up as `GENERATION_FAILED` instead, the fix is to
 * add the observed wording here.
 */
export const SANDBOX_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /\bsandbox\b[^\n]{0,120}?\b(unavailable|not available|not supported|unsupported|disabled)\b/i,
  /\b(could not|couldn't|cannot|can't|unable to|failed to)\b[^\n]{0,80}?\bsandbox\b/i,
  /\bsandbox\b[^\n]{0,80}?\b(requires|needs)\b[^\n]{0,60}?\b(administrator|admin|elevat)/i,
  /\bsandbox (setup|initiali[sz]ation)\b[^\n]{0,60}?\b(required|failed|incomplete|not (been )?run)\b/i
]

/**
 * The user-facing warnings of spec section 7.3.
 *
 * English, like every other message this app's main process produces for the
 * renderer (`CodexResolveError`, `MaterializeError`, the preflight messages).
 * The Vietnamese strings of plan decision Q10 are the renderer's, plus the
 * `activity` labels spec section 5.5 spells out in Vietnamese itself.
 */
export const WARNING = {
  undeclared: (name: string): string =>
    `Codex left a file in outputs/ that it did not report: ${name}. It was ignored.`,
  duplicate: (path: string): string => `Codex reported ${path} twice; the duplicate was ignored.`,
  format: (path: string, requested: ImageFormat, actual: ImageFormat): string =>
    `The job asked for ${requested} and ${path} is ${actual}.`,
  aspectRatio: (path: string, requested: string, width: number, height: number): string =>
    `The job asked for ${requested} and ${path} measures ${String(width)}x${String(height)}.`,
  count: (requested: number, actual: number): string =>
    `The job asked for ${String(requested)} image${requested === 1 ? '' : 's'} and Codex produced ${String(actual)}.`
} as const

/** What `verifying` concluded (spec section 7.3). */
export interface Verification {
  readonly status: ResultStatus
  /** Measured from the files on disk, never copied from Codex. */
  readonly outputs: readonly ResultOutput[]
  readonly warnings: readonly string[]
  readonly error: { readonly code: ResultErrorCode; readonly message: string } | null
}

export interface VerifyRequest {
  /** Absolute path of the job directory. */
  readonly jobDir: string
  /** `job.json`; only the job ID and the output request are consulted. */
  readonly job: Pick<JobPacket, 'jobId' | 'output'>
  /** The process exit code, or `null` when it was signalled or never started. */
  readonly exitCode: number | null
  /** Defaults to the first {@link MAX_STDERR_SCAN_BYTES} of `stderr.log`. */
  readonly stderr?: string
  /** Passed to the image inspector; defaults to the 20 MB of spec section 4.2. */
  readonly maxBytes?: number
}

/**
 * Applies spec sections 5.6 and 7.3 to one finished run.
 *
 * Never throws for a bad result: an unverifiable run is a `failed`
 * {@link Verification} with a code from spec section 7.4, because the caller
 * must write `result.json` either way. A real I/O failure — an unreadable
 * `outputs/` directory, say — still propagates, since that is the app's
 * problem and not Codex's.
 */
export async function verifyCodexRun(request: VerifyRequest): Promise<Verification> {
  const stderr = request.stderr ?? (await readStderrExcerpt(request.jobDir))

  // Checked first: when the sandbox could not be built, Codex never got far
  // enough to write a report, and "no codex-result.json" would otherwise be
  // reported as the far less useful `GENERATION_FAILED` (spec section 5.3).
  if (detectSandboxUnavailable(stderr)) {
    return failure(
      'CODEX_SANDBOX_UNAVAILABLE',
      'Codex could not start its sandbox on this machine. Run the Codex CLI sandbox setup once, then try again.'
    )
  }

  const raw = await readOptionalFile(join(request.jobDir, CODEX_RESULT_FILE_NAME))

  if (raw === null) {
    // Spec section 7.3: a non-zero exit with no report is `GENERATION_FAILED`;
    // exiting 0 and reporting nothing is a broken executor, not a failed image.
    return request.exitCode === 0
      ? failure(
          'INVALID_RESULT',
          'Codex finished without writing codex-result.json, so there is nothing to verify.'
        )
      : failure(
          'GENERATION_FAILED',
          `Codex stopped with exit code ${String(request.exitCode ?? -1)} and wrote no result. See the job folder for the logs.`
        )
  }

  const claim = parseCodexResult(raw)

  if (claim === null) {
    return failure(
      'INVALID_RESULT',
      'Codex wrote a codex-result.json this app cannot read; the job is not counted as done.'
    )
  }

  if (claim.jobId !== request.job.jobId) {
    return failure('INVALID_RESULT', 'Codex reported a result for a different job.')
  }

  if (claim.status === 'failed') {
    if (claim.error === null) {
      return failure(
        'INVALID_RESULT',
        'Codex reported a failure without saying why; the job is not counted as done.'
      )
    }

    // The four codes of spec section 7.1 are all codes spec section 7.4 keeps,
    // so a reported failure passes through with its own code. Anything else was
    // already refused by the schema above.
    return {
      status: 'failed',
      outputs: [],
      warnings: await undeclaredFileWarnings(request.jobDir, new Set()),
      error: { code: claim.error.code, message: sanitizeMessage(claim.error.message) }
    }
  }

  if (claim.error !== null) {
    return failure(
      'INVALID_RESULT',
      'Codex reported success and an error at the same time; the job is not counted as done.'
    )
  }

  if (claim.outputs.length === 0) {
    // Spec section 7.3, and spec section 5.6's "at least one output image".
    return failure(
      'INVALID_RESULT',
      'Codex reported success but listed no image, so there is nothing to show.'
    )
  }

  const outputs: ResultOutput[] = []
  const warnings: string[] = []
  const declared = new Set<string>()

  for (const entry of claim.outputs) {
    if (declared.has(entry.path)) {
      warnings.push(WARNING.duplicate(entry.path))

      continue
    }

    declared.add(entry.path)

    const measured = await measureOutput(request, entry.path)

    if (typeof measured === 'string') {
      return failure('INVALID_RESULT', measured)
    }

    outputs.push(measured)
  }

  warnings.push(...(await undeclaredFileWarnings(request.jobDir, declared)))
  warnings.push(...compareWithRequest(request.job.output, outputs))

  return { status: 'succeeded', outputs, warnings, error: null }
}

/** Whether Codex's stderr says the sandbox could not be built. */
export function detectSandboxUnavailable(stderr: string): boolean {
  return SANDBOX_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(stderr))
}

export interface BuildResultInput {
  readonly jobId: string
  readonly status: ResultStatus
  readonly startedAt: string
  readonly completedAt: string
  readonly executor: ResultExecutor
  readonly outputs?: readonly ResultOutput[]
  readonly warnings?: readonly string[]
  readonly error?: { readonly code: ResultErrorCode; readonly message: string } | null
}

/**
 * Assembles `result.json` (spec section 7.2) and validates it before anyone
 * sees it, so a shape the UI could not read never reaches the disk.
 */
export function buildResult(input: BuildResultInput): Result {
  return ResultSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    jobId: input.jobId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    executor: input.executor,
    outputs: input.outputs ?? [],
    warnings: input.warnings ?? [],
    promptPath: 'prompt.md',
    error: input.error ?? null
  })
}

/**
 * Writes `result.json` atomically.
 *
 * `job.json` is written once and never touched again (spec section 6);
 * `result.json` is the file the main process owns, and it is written through a
 * temporary file and a rename so a reader never sees half of one.
 */
export async function writeResultJson(jobDir: string, result: Result): Promise<Result> {
  const validated = ResultSchema.parse(result)

  await writeJsonAtomically(join(jobDir, RESULT_FILE_NAME), validated)

  return validated
}

/** Reads `result.json`, or `null` when it is absent or unreadable. */
export async function readResultJson(jobDir: string): Promise<Result | null> {
  const raw = await readOptionalFile(join(jobDir, RESULT_FILE_NAME))

  if (raw === null) {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const result = ResultSchema.safeParse(parsed)

  return result.success ? result.data : null
}

/** The beginning of `stderr.log`, capped so a noisy run cannot fill memory. */
export async function readStderrExcerpt(
  jobDir: string,
  maxBytes: number = MAX_STDERR_SCAN_BYTES
): Promise<string> {
  let handle

  try {
    handle = await open(join(jobDir, STDERR_FILE_NAME), 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }

    throw error
  }

  try {
    const buffer = Buffer.alloc(maxBytes)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)

    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failure(code: ResultErrorCode, message: string): Verification {
  return { status: 'failed', outputs: [], warnings: [], error: { code, message } }
}

function parseCodexResult(raw: string): CodexResult | null {
  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const result = CodexResultSchema.safeParse(parsed)

  return result.success ? result.data : null
}

/**
 * Re-measures one declared output, or says in one sentence why it cannot be
 * accepted (spec section 7.3).
 *
 * `safeJoin` refuses a path that leaves the job directory once symlinks are
 * resolved, and `inspectImage` refuses a symlink, anything that is not a
 * regular file, and bytes that are not PNG, JPEG or WebP. Both are the same
 * gates the job inputs went through (spec section 11).
 */
async function measureOutput(
  request: VerifyRequest,
  declaredPath: string
): Promise<ResultOutput | string> {
  let absolute: string

  try {
    absolute = await safeJoin(request.jobDir, ...declaredPath.split('/'))
  } catch (error) {
    if (error instanceof UnsafePathError) {
      return 'Codex reported an image outside the job folder, which this app will not accept.'
    }

    throw error
  }

  try {
    const inspected = await inspectImage(
      absolute,
      request.maxBytes === undefined ? {} : { maxBytes: request.maxBytes }
    )

    return {
      path: declaredPath,
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      sizeBytes: inspected.sizeBytes,
      sha256: inspected.sha256
    }
  } catch (error) {
    if (error instanceof ImageInspectError) {
      return `Codex reported ${declaredPath}, but it cannot be used: ${error.message}`
    }

    throw error
  }
}

/**
 * Spec section 7.3: a file sitting in `outputs/` that Codex did not declare is
 * ignored and mentioned, never a failure.
 */
async function undeclaredFileWarnings(
  jobDir: string,
  declared: ReadonlySet<string>
): Promise<string[]> {
  let entries

  try {
    entries = await readdir(join(jobDir, OUTPUTS_DIRECTORY), { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }

  const warnings: string[] = []

  for (const entry of entries) {
    if (!declared.has(`${OUTPUTS_DIRECTORY}/${entry.name}`)) {
      warnings.push(sanitizeMessage(WARNING.undeclared(entry.name)))
    }
  }

  return warnings
}

/**
 * Spec section 7.3: a measured value that differs from the request in
 * `job.json` is a warning the UI shows, never a failure. `output` is what the
 * user asked `image_gen` for in natural language, and the tool is free to
 * answer with something else (spec section 6.2).
 *
 * The count is compared as well as the format and the ratio. Spec section 7.3
 * names "size, ratio or format", but `count` sits in the same `output` object
 * and is a request in exactly the same sense, so a job that asked for three
 * images and got one says so rather than looking complete.
 */
function compareWithRequest(
  request: JobPacket['output'],
  outputs: readonly ResultOutput[]
): string[] {
  const warnings: string[] = []

  if (outputs.length !== request.count) {
    warnings.push(WARNING.count(request.count, outputs.length))
  }

  const requested = parseAspectRatio(request.aspectRatio)

  for (const output of outputs) {
    const actualFormat = imageExtension(output.mimeType)

    if (actualFormat !== request.format) {
      warnings.push(WARNING.format(output.path, request.format, actualFormat))
    }

    if (requested !== null) {
      const actual = output.width / output.height

      if (Math.abs(actual - requested) / requested > ASPECT_RATIO_TOLERANCE) {
        warnings.push(
          WARNING.aspectRatio(output.path, request.aspectRatio, output.width, output.height)
        )
      }
    }
  }

  return warnings
}

/** `3:4` as a number, or `null` when the field holds free text. */
function parseAspectRatio(value: string): number | null {
  const match = ASPECT_RATIO.exec(value)

  if (match === null) {
    return null
  }

  const width = Number(match[1])
  const height = Number(match[2])

  return height > 0 && width > 0 ? width / height : null
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }

    throw error
  }
}
