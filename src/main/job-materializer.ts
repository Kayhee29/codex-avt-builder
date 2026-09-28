/**
 * The immutable job materializer (plan Task 2.5, spec section 5.2).
 *
 * Pressing Generate turns the builder state into a directory that no longer
 * depends on anything outside itself:
 *
 * ```text
 * workspace/jobs/<job-id>/
 *   job.json              written once, no run state (spec section 6)
 *   prompt.md             the prompt the user previewed
 *   run-instructions.md   instructions/run-job.md with the job ID filled in
 *   inputs/<role>.<ext>   a copy of every active reference
 *   outputs/              empty, for Codex to fill
 * ```
 *
 * The steps are the ones spec section 5.2 lists, in that order, and everything
 * that can be refused is refused before the directory exists, so a rejected
 * Generate leaves nothing behind.
 *
 * Copying the references is what makes a run reproducible after the user
 * renames, edits or deletes the originals (spec section 5.2), and the numbers
 * written into `job.json` are measured from the copies, never taken from what
 * the renderer sent (spec section 6.2).
 */
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CODEX_MIN_VERSION } from '../shared/codex-version.ts'
import { BuilderStateInputSchema, type BuilderStateInput } from '../shared/ipc-contract.ts'
import { buildJobId, MAX_JOB_SEQUENCE, MIN_JOB_SEQUENCE } from '../shared/job-id.ts'
import { buildPrompt, sha256Hex, type OrderedReference } from '../shared/prompt-builder.ts'
import {
  assignReferenceLabels,
  DuplicateReferenceRoleError,
  type LabelledReference
} from '../shared/reference-roles.ts'
import {
  JobPacketSchema,
  SCHEMA_VERSION,
  type BuilderReference,
  type BuilderState,
  type JobPacket,
  type JobReference
} from '../shared/schemas.ts'

import {
  imageExtension,
  ImageInspectError,
  inspectImage,
  type InspectedImage
} from './image-inspect.ts'
import type { ReferenceRegistry } from './reference-registry.ts'
import { safeJoin, workspaceLayout, type WorkspaceLayout } from './workspace.ts'

export const JOB_FILE_NAME = 'job.json'
export const PROMPT_FILE_NAME = 'prompt.md'
export const RUN_INSTRUCTIONS_FILE_NAME = 'run-instructions.md'
export const INPUTS_DIRECTORY = 'inputs'
export const OUTPUTS_DIRECTORY = 'outputs'

/** The only placeholder `instructions/run-job.md` carries (plan Task 0.2). */
export const JOB_ID_PLACEHOLDER = '{{jobId}}'

/**
 * `instructions/run-job.md` in the repository.
 *
 * A packaged app passes {@link JobMaterializerOptions.instructionTemplatePath}
 * instead, because there the template ships as a resource rather than next to
 * the compiled main process (plan Task 6.5).
 */
export const DEFAULT_INSTRUCTION_TEMPLATE_PATH = fileURLToPath(
  new URL('../../instructions/run-job.md', import.meta.url)
)

/**
 * Why a job was refused. Both are codes spec section 7.4 lets the main process
 * set.
 */
export type MaterializeErrorCode = 'INVALID_JOB' | 'MISSING_REFERENCE'

export class MaterializeError extends Error {
  readonly code: MaterializeErrorCode

  constructor(code: MaterializeErrorCode, message: string) {
    super(message)
    this.name = 'MaterializeError'
    this.code = code
  }
}

export interface JobMaterializerOptions {
  /** The workspace root, or the layout built from it. */
  readonly workspace: string | WorkspaceLayout
  readonly registry: ReferenceRegistry
  /** Injected so tests get a predictable date and job ID. */
  readonly now?: () => Date
  /** Passed to the image inspector; defaults to the 20 MB of spec section 4.2. */
  readonly maxBytes?: number
  /** Defaults to {@link DEFAULT_INSTRUCTION_TEMPLATE_PATH}. */
  readonly instructionTemplatePath?: string
}

/** What the orchestrator of plan Task 3.7 needs in order to start a run. */
export interface MaterializedJob {
  readonly jobId: string
  /** Absolute path of `workspace/jobs/<job-id>`. */
  readonly directory: string
  readonly packet: JobPacket
  /** Exactly the bytes written to `prompt.md`. */
  readonly prompt: string
  /** Absolute paths of the copied inputs, in `-i` order (spec section 5.3). */
  readonly inputPaths: string[]
}

/** One reference with its label, its source file and that file's measurements. */
interface PreparedReference {
  readonly reference: LabelledReference<BuilderReference>
  readonly source: string
  readonly inspected: InspectedImage
}

export class JobMaterializer {
  readonly #layout: WorkspaceLayout
  readonly #registry: ReferenceRegistry
  readonly #now: () => Date
  readonly #maxBytes: number | undefined
  readonly #instructionTemplatePath: string

  constructor(options: JobMaterializerOptions) {
    this.#layout =
      typeof options.workspace === 'string' ? workspaceLayout(options.workspace) : options.workspace
    this.#registry = options.registry
    this.#now = options.now ?? (() => new Date())
    this.#maxBytes = options.maxBytes
    this.#instructionTemplatePath =
      options.instructionTemplatePath ?? DEFAULT_INSTRUCTION_TEMPLATE_PATH
  }

  /**
   * Materializes one job (spec section 5.2).
   *
   * `promptSha256` is the checksum of the prompt the renderer previewed. The
   * prompt is built again here from `state` alone — the same pure function with
   * the same arguments — and a job whose checksum does not match is refused
   * with `INVALID_JOB` (spec section 10): the preview and the state disagree,
   * and the user would otherwise get an image for a prompt they never saw.
   */
  async materialize(state: BuilderStateInput, promptSha256: string): Promise<MaterializedJob> {
    const validated = this.#validate(state)
    const ordered = assignReferenceLabels(validated.references)
    const { markdown, negativeConstraints } = buildPrompt(validated, ordered.map(toPromptReference))

    if ((await sha256Hex(markdown)) !== promptSha256) {
      throw new MaterializeError(
        'INVALID_JOB',
        'The prompt on screen is not the prompt this job would run; refresh the preview and try again.'
      )
    }

    // Measure every source before anything is created, so an unreadable,
    // oversized or symlinked reference refuses the job instead of leaving a
    // half-built directory behind (spec sections 10 and 11).
    const prepared: PreparedReference[] = []

    for (const reference of ordered) {
      prepared.push(await this.#prepare(reference))
    }

    const createdAt = this.#now()
    const { jobId, directory } = await this.#createJobDirectory(createdAt, validated.subject.name)

    await mkdir(join(directory, INPUTS_DIRECTORY))
    await mkdir(join(directory, OUTPUTS_DIRECTORY))

    const references: JobReference[] = []
    const inputPaths: string[] = []

    for (const { reference, source, inspected } of prepared) {
      const fileName = `${reference.role}.${imageExtension(inspected.mimeType)}`
      const target = await safeJoin(directory, INPUTS_DIRECTORY, fileName)

      await copyRegularFile(source, target)

      // Measure the copy rather than the original: job.json describes what is
      // inside the job directory (spec section 6.2).
      const copied = await inspectImage(target, this.#inspectOptions())

      references.push({
        label: reference.label,
        role: reference.role,
        path: `${INPUTS_DIRECTORY}/${fileName}`,
        originalName: reference.originalName,
        mimeType: copied.mimeType,
        sizeBytes: copied.sizeBytes,
        sha256: copied.sha256,
        ...(reference.note === undefined ? {} : { note: reference.note })
      })
      inputPaths.push(target)
    }

    const packet: JobPacket = JobPacketSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      jobId,
      createdAt: createdAt.toISOString(),
      executor: { kind: 'codex-cli', minimumVersion: CODEX_MIN_VERSION, imageTool: 'image_gen' },
      subject: validated.subject,
      references,
      output: validated.output,
      // The same list the prompt printed, so a duplicate of this job gets back
      // exactly the constraints this job ran with (spec section 6.2).
      negativeConstraints,
      source: validated.source,
      promptPath: PROMPT_FILE_NAME,
      promptSha256
    })

    // `wx` makes "written once" (spec section 6) a property of the code.
    await writeOnce(join(directory, JOB_FILE_NAME), `${JSON.stringify(packet, null, 2)}\n`)
    await writeOnce(join(directory, PROMPT_FILE_NAME), markdown)
    await writeOnce(
      join(directory, RUN_INSTRUCTIONS_FILE_NAME),
      await this.#renderInstructions(jobId)
    )

    return { jobId, directory, packet, prompt: markdown, inputPaths }
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /**
   * Step 1 of spec section 5.2.
   *
   * The schema catches a missing subject name or description and a malformed
   * reference; `assignReferenceLabels` catches the same role twice, which no
   * JSON Schema can express (see the note in `src/shared/schemas.ts`). Both
   * happen before a job ID exists.
   *
   * `displayPath` and `thumbnail` never cross IPC (plan decisions Q3 and Q19),
   * so they are put back from the registry, which also proves every reference
   * id belongs to this session. The prompt does not depend on either field,
   * which is why the checksum still matches the renderer's.
   */
  #validate(state: BuilderStateInput): BuilderState {
    const parsed = BuilderStateInputSchema.safeParse(state)

    if (!parsed.success) {
      throw new MaterializeError(
        'INVALID_JOB',
        `The builder state is incomplete: ${firstIssue(parsed.error)}.`
      )
    }

    const references = parsed.data.references.map((reference) => this.#rehydrate(reference))

    try {
      assignReferenceLabels(references)
    } catch (error) {
      if (error instanceof DuplicateReferenceRoleError) {
        throw new MaterializeError('INVALID_JOB', error.message)
      }

      throw error
    }

    return { ...parsed.data, references }
  }

  #rehydrate(reference: BuilderStateInput['references'][number]): BuilderReference {
    const entry = this.#registry.describe(reference.referenceId)

    if (entry === undefined) {
      throw new MaterializeError(
        'MISSING_REFERENCE',
        `The ${reference.role} image is no longer selected; choose it again.`
      )
    }

    return {
      ...reference,
      displayPath: entry.displayPath,
      ...(entry.thumbnail === undefined ? {} : { thumbnail: entry.thumbnail })
    }
  }

  /**
   * Resolves one reference to its file and measures it.
   *
   * The inspector's codes become the two codes spec section 7.4 gives the main
   * process here: a file that is gone is a `MISSING_REFERENCE`, while a
   * symlink, an unsupported format or an oversized file makes the job invalid.
   */
  async #prepare(reference: LabelledReference<BuilderReference>): Promise<PreparedReference> {
    const source = this.#registry.resolve(reference.referenceId)

    if (source === undefined) {
      throw new MaterializeError(
        'MISSING_REFERENCE',
        `The ${reference.role} image is no longer selected; choose it again.`
      )
    }

    try {
      return { reference, source, inspected: await inspectImage(source, this.#inspectOptions()) }
    } catch (error) {
      if (!(error instanceof ImageInspectError)) {
        throw error
      }

      throw new MaterializeError(
        error.code === 'NOT_A_FILE' ? 'MISSING_REFERENCE' : 'INVALID_JOB',
        `The ${reference.role} image cannot be used: ${error.message}`
      )
    }
  }

  /**
   * Steps 2 and 3 of spec section 5.2: the first sequence number of the day
   * whose directory does not exist yet.
   *
   * The directory is created with `mkdir` without `recursive`, so two calls
   * racing for the same number cannot both win: the loser gets `EEXIST` and
   * moves on to the next number.
   */
  async #createJobDirectory(
    createdAt: Date,
    subjectName: string
  ): Promise<{ jobId: string; directory: string }> {
    await mkdir(this.#layout.jobs, { recursive: true })

    for (let sequence = MIN_JOB_SEQUENCE; sequence <= MAX_JOB_SEQUENCE; sequence += 1) {
      const jobId = buildJobId(createdAt, subjectName, sequence)
      const directory = await safeJoin(this.#layout.jobs, jobId)

      try {
        await mkdir(directory)

        return { jobId, directory }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      }
    }

    throw new MaterializeError(
      'INVALID_JOB',
      'There are already 999 jobs for this subject today; try again tomorrow.'
    )
  }

  /** Step 8: `instructions/run-job.md` with the validated job ID filled in. */
  async #renderInstructions(jobId: string): Promise<string> {
    const template = await readFile(this.#instructionTemplatePath, 'utf8')

    return template.split(JOB_ID_PLACEHOLDER).join(jobId)
  }

  #inspectOptions(): { maxBytes?: number } {
    return this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The three fields the prompt needs (spec section 4.3). Projecting explicitly
 * keeps a reference handle out of the pure prompt builder and keeps the
 * optional `note` exactly optional.
 */
function toPromptReference(reference: LabelledReference<BuilderReference>): OrderedReference {
  return {
    label: reference.label,
    role: reference.role,
    originalName: reference.originalName,
    ...(reference.note === undefined ? {} : { note: reference.note })
  }
}

/**
 * Copies a plain file.
 *
 * `lstat` runs immediately before the copy, because `copyFile` follows a
 * symlink and the inspection happened earlier: spec section 11 does not accept
 * a symlink as a job input, and a file that becomes one between the two steps
 * must not slip through.
 */
async function copyRegularFile(source: string, target: string): Promise<void> {
  const stats = await lstat(source)

  if (stats.isSymbolicLink()) {
    throw new MaterializeError('INVALID_JOB', 'A symlink cannot be used as a job input.')
  }

  if (!stats.isFile()) {
    throw new MaterializeError('MISSING_REFERENCE', 'That reference is no longer a file.')
  }

  await copyFile(source, target)
}

/** Writes a file that must not exist yet (spec section 6: written once). */
async function writeOnce(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: 'utf8', flag: 'wx' })
}

function firstIssue(error: {
  issues: readonly { path: PropertyKey[]; message: string }[]
}): string {
  const issue = error.issues[0]

  if (issue === undefined) {
    return 'unknown problem'
  }

  const where = issue.path.map(String).join('.')

  return where === '' ? issue.message : `${where}: ${issue.message}`
}
