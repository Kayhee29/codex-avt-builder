/**
 * Draft, preset and anchor storage (plan Task 2.4).
 *
 * Everything the app keeps between sessions except jobs lives here:
 *
 * ```text
 * workspace/drafts/current.json
 * workspace/presets/<presetId>/preset.json + style.<ext>
 * workspace/anchors/<anchorId>/v<N>/anchor.json + identity.<ext> [+ approved.<ext>]
 * ```
 *
 * Two rules shape the whole module.
 *
 * Plan decision Q4: a preset or an anchor that points at an image copies that
 * image next to its metadata, for the same reason a job copies its references
 * (spec section 5.2) — the library has to keep working after the user renames,
 * edits or deletes the original.
 *
 * Plan decision Q3: what arrives from the renderer carries opaque reference ids
 * and no paths, so `displayPath` and `thumbnail` are put back from the registry
 * before a draft is written, and `draft.load` registers the stored paths again
 * and marks anything that has vanished (spec section 4.2).
 *
 * Spec section 4.5: saving an anchor writes a new version directory and never
 * touches an existing one.
 */
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, join } from 'node:path'

import { nextAnchorVersion } from '../shared/anchor.ts'
import type { AnchorEntry, AnchorInput, PresetEntry, PresetInput } from '../shared/ipc-contract.ts'
import { type BuilderStateInput } from '../shared/ipc-contract.ts'
import { slugifySubject } from '../shared/job-id.ts'
import {
  AnchorSchema,
  DraftSchema,
  LIBRARY_ID_REGEX,
  PresetSchema,
  ResultSchema,
  SCHEMA_VERSION,
  type Anchor,
  type BuilderReference,
  type BuilderState,
  type Draft,
  type ImageFormat,
  type ImageMimeType,
  type Preset
} from '../shared/schemas.ts'

import { imageExtension, inspectImage, type InspectedImage } from './image-inspect.ts'
import type { ReferenceRegistry } from './reference-registry.ts'
import { safeJoin, workspaceLayout, type WorkspaceLayout } from './workspace.ts'

/** `workspace/drafts/current.json` (spec section 4.6). */
export const DRAFT_FILE_NAME = 'current.json'

export const PRESET_FILE_NAME = 'preset.json'
export const ANCHOR_FILE_NAME = 'anchor.json'

/** `v1`, `v2`, … one directory per anchor version (spec section 4.5). */
export const ANCHOR_VERSION_PREFIX = 'v'

const ANCHOR_VERSION_DIRECTORY = /^v(\d+)$/

/** `LIBRARY_ID_REGEX` allows 64 characters; leave room for a `-2` suffix. */
const MAX_LIBRARY_ID_LENGTH = 48

/** Why a library call failed. These map straight onto the IPC error codes. */
export type LibraryErrorCode = 'NOT_FOUND' | 'MISSING_REFERENCE' | 'IO_ERROR'

export class LibraryError extends Error {
  readonly code: LibraryErrorCode

  constructor(code: LibraryErrorCode, message: string) {
    super(message)
    this.name = 'LibraryError'
    this.code = code
  }
}

export interface LibraryOptions {
  /** The workspace root, or the layout {@link workspaceLayout} built from it. */
  readonly workspace: string | WorkspaceLayout
  readonly registry: ReferenceRegistry
  /** Injected so tests get predictable timestamps. */
  readonly now?: () => Date
  /** Passed to the image inspector; defaults to the 20 MB of spec section 4.2. */
  readonly maxBytes?: number
}

/** A loaded draft, in the shape `draft.load` answers with. */
export interface LoadedDraft {
  readonly state: BuilderState
  readonly savedAt: string
}

export class Library {
  readonly #layout: WorkspaceLayout
  readonly #registry: ReferenceRegistry
  readonly #now: () => Date
  readonly #maxBytes: number | undefined

  constructor(options: LibraryOptions) {
    this.#layout =
      typeof options.workspace === 'string' ? workspaceLayout(options.workspace) : options.workspace
    this.#registry = options.registry
    this.#now = options.now ?? (() => new Date())
    this.#maxBytes = options.maxBytes
  }

  // -------------------------------------------------------------------------
  // Draft
  // -------------------------------------------------------------------------

  /**
   * Writes the builder state to `workspace/drafts/current.json` (spec 4.6).
   *
   * The write is atomic: a temporary file next to the target, then a rename, so
   * an autosave interrupted halfway never leaves a truncated draft behind.
   *
   * The state arrives without `displayPath` and without `thumbnail`, which the
   * renderer is not allowed to send back (plan decision Q3); both are put back
   * from the registry, together with the absolute path of every reference, so
   * the next `draft.load` can register them again.
   */
  async saveDraft(state: BuilderStateInput): Promise<{ savedAt: string }> {
    const savedAt = this.#timestamp()
    const references: BuilderReference[] = []
    const referencePaths: Record<string, string> = {}

    for (const reference of state.references) {
      const entry = this.#registry.describe(reference.referenceId)

      if (entry === undefined) {
        throw new LibraryError(
          'MISSING_REFERENCE',
          `The ${reference.role} reference is not registered in this session and cannot be saved.`
        )
      }

      references.push({
        ...reference,
        displayPath: entry.displayPath,
        ...(entry.thumbnail === undefined ? {} : { thumbnail: entry.thumbnail })
      })
      referencePaths[reference.referenceId] = entry.path
    }

    const draft: Draft = DraftSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      savedAt,
      state: { ...state, references },
      referencePaths
    })

    await mkdir(this.#layout.drafts, { recursive: true })
    await writeJsonAtomically(join(this.#layout.drafts, DRAFT_FILE_NAME), draft)

    return { savedAt }
  }

  /**
   * Reads the draft back, registers its reference paths again and marks every
   * reference whose file has gone as `missing` (spec section 4.2).
   *
   * The stored measurements are kept as they were; a reference is re-measured
   * when a job is materialized (spec section 5.2), which is the only place the
   * numbers have to be current.
   */
  async loadDraft(): Promise<LoadedDraft | null> {
    const path = join(this.#layout.drafts, DRAFT_FILE_NAME)
    const raw = await readOptionalFile(path)

    if (raw === null) {
      return null
    }

    const parsed = DraftSchema.safeParse(parseJson(raw, path))

    if (!parsed.success) {
      throw new LibraryError('IO_ERROR', 'The saved draft is not readable and was left untouched.')
    }

    const draft = parsed.data
    const references: BuilderReference[] = []

    for (const reference of draft.state.references) {
      const storedPath = draft.referencePaths[reference.referenceId]

      if (storedPath === undefined) {
        references.push({ ...reference, missing: true })

        continue
      }

      this.#registry.register(storedPath, {
        referenceId: reference.referenceId,
        ...(reference.thumbnail === undefined ? {} : { thumbnail: reference.thumbnail })
      })

      references.push({ ...reference, missing: !(await isReadableFile(storedPath)) })
    }

    return { state: { ...draft.state, references }, savedAt: draft.savedAt }
  }

  // -------------------------------------------------------------------------
  // Presets
  // -------------------------------------------------------------------------

  /** Every stored preset with a handle for its copied style image (decision Q18). */
  async listPresets(): Promise<PresetEntry[]> {
    const entries: PresetEntry[] = []

    for (const id of await listDirectories(this.#layout.presets)) {
      const preset = await this.#readPreset(id)

      if (preset === null) {
        continue
      }

      entries.push({
        preset,
        styleReference:
          preset.styleReference === null
            ? null
            : await this.#handleFor(
                join(this.#layout.presets, id, preset.styleReference.path),
                'style',
                preset.styleReference.originalName
              )
      })
    }

    return entries.sort((left, right) => left.preset.id.localeCompare(right.preset.id))
  }

  /**
   * Saves a preset and copies its style image into
   * `workspace/presets/<id>/style.<ext>` (plan decision Q4).
   *
   * `id: null` means a new preset and the id is derived from the name; saving
   * over an existing id keeps its `createdAt` and replaces the image, including
   * the case where the new image has a different extension.
   */
  async savePreset(input: PresetInput): Promise<PresetEntry> {
    const existing = input.id === null ? null : await this.#readPreset(input.id)
    const id = input.id ?? (await this.#freeLibraryId(this.#layout.presets, input.name, 'preset'))
    const directory = await this.#ensureDirectory(this.#layout.presets, id)
    const now = this.#timestamp()

    const styleReference =
      input.styleReferenceId === null
        ? null
        : await this.#storeImage(directory, 'style', this.#resolveReference(input.styleReferenceId))

    if (styleReference === null) {
      await removeStoredImages(directory, 'style')
    }

    const preset: Preset = PresetSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      name: input.name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      styleReference: styleReference?.stored ?? null,
      roleNotes: input.roleNotes,
      promptConventions: input.promptConventions,
      negativeConstraints: input.negativeConstraints,
      composition: input.composition,
      output: input.output
    })

    await writeJsonAtomically(join(directory, PRESET_FILE_NAME), preset)

    return {
      preset,
      styleReference:
        styleReference === null
          ? null
          : await this.#handleFor(styleReference.path, 'style', styleReference.stored.originalName)
    }
  }

  /** Removes `workspace/presets/<id>/` and the image inside it (decision Q7). */
  async deletePreset(id: string): Promise<void> {
    const directory = await this.#libraryDirectory(this.#layout.presets, id)

    if (!(await exists(directory))) {
      throw new LibraryError('NOT_FOUND', 'That preset no longer exists.')
    }

    await rm(directory, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // Anchors
  // -------------------------------------------------------------------------

  /**
   * Every stored anchor version with a handle for its identity image
   * (decision Q18), ordered by anchor and then by version.
   *
   * Versions are listed rather than collapsed: spec section 4.5 keeps every one
   * of them, and the UI decides which to show.
   */
  async listAnchors(): Promise<AnchorEntry[]> {
    const entries: AnchorEntry[] = []

    for (const id of await listDirectories(this.#layout.anchors)) {
      for (const anchor of await this.#readAnchorVersions(id)) {
        entries.push({
          anchor,
          identityReference: await this.#handleFor(
            join(
              this.#layout.anchors,
              id,
              versionDirectory(anchor.version),
              anchor.identityReference.path
            ),
            'identity',
            anchor.identityReference.originalName
          )
        })
      }
    }

    return entries.sort(
      (left, right) =>
        left.anchor.id.localeCompare(right.anchor.id) || left.anchor.version - right.anchor.version
    )
  }

  /**
   * Writes a new anchor version (spec section 4.5).
   *
   * The version number comes from `nextAnchorVersion`, so it is always past
   * every version on disk and an existing directory is never written into. The
   * identity image is copied in, and so is the approved output when one is
   * named — by job ID and output index, never by file name (plan Task 1.6), so
   * it is read out of that job's verified `result.json`.
   */
  async saveAnchor(input: AnchorInput): Promise<AnchorEntry> {
    const id = input.id ?? (await this.#freeLibraryId(this.#layout.anchors, input.name, 'anchor'))
    const anchorDirectory = await this.#ensureDirectory(this.#layout.anchors, id)
    const existing = await this.#readAnchorVersions(id)
    const version = nextAnchorVersion(existing.map((anchor) => ({ ...anchor, id })))
    const directory = join(anchorDirectory, versionDirectory(version))

    if (await exists(directory)) {
      throw new LibraryError(
        'IO_ERROR',
        `Anchor version ${String(version)} already exists and is never overwritten.`
      )
    }

    await mkdir(directory, { recursive: true })

    const identity = await this.#storeImage(
      directory,
      'identity',
      this.#resolveReference(input.identityReferenceId)
    )
    const approved =
      input.approvedOutput === null
        ? null
        : await this.#storeImage(
            directory,
            'approved',
            await this.#approvedOutputPath(
              input.approvedOutput.jobId,
              input.approvedOutput.outputIndex
            )
          )

    const anchor: Anchor = AnchorSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      name: input.name,
      version,
      createdAt: this.#timestamp(),
      identityReference: identity.stored,
      approvedOutput: approved?.stored ?? null,
      identityDescription: input.identityDescription,
      immutableTraits: input.immutableTraits,
      mutableTraits: input.mutableTraits,
      sourceJobId: input.sourceJobId
    })

    await writeJsonAtomically(join(directory, ANCHOR_FILE_NAME), anchor)

    return {
      anchor,
      identityReference: await this.#handleFor(
        identity.path,
        'identity',
        identity.stored.originalName
      )
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #timestamp(): string {
    return this.#now().toISOString()
  }

  /** The absolute path behind a reference id, or `MISSING_REFERENCE`. */
  #resolveReference(referenceId: string): string {
    const path = this.#registry.resolve(referenceId)

    if (path === undefined) {
      throw new LibraryError(
        'MISSING_REFERENCE',
        'That image is no longer selected; choose it again before saving.'
      )
    }

    return path
  }

  /**
   * Copies `source` into `directory` as `<name>.<ext>`, with the extension the
   * measured format asks for, and measures the copy rather than the original —
   * the copy is what the metadata describes.
   */
  async #storeImage(
    directory: string,
    name: 'style' | 'identity' | 'approved',
    source: string
  ): Promise<{ path: string; stored: StoredImage }> {
    const inspected = await this.#inspect(source)
    const extension: ImageFormat = imageExtension(inspected.mimeType)

    await removeStoredImages(directory, name)

    const fileName = `${name}.${extension}`
    const target = join(directory, fileName)

    await copyFile(source, target)

    const copied = await this.#inspect(target)

    return {
      path: target,
      stored: {
        path: fileName,
        originalName: basename(source),
        mimeType: copied.mimeType,
        sizeBytes: copied.sizeBytes,
        sha256: copied.sha256
      }
    }
  }

  async #inspect(path: string): Promise<InspectedImage> {
    return inspectImage(path, this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes })
  }

  /** A handle for a stored library image, or `null` when it cannot be read. */
  async #handleFor(
    path: string,
    role: 'style' | 'identity',
    originalName: string
  ): Promise<BuilderReference | null> {
    try {
      return await this.#registry.createReference(path, {
        role,
        originalName,
        ...(this.#maxBytes === undefined ? {} : { maxBytes: this.#maxBytes })
      })
    } catch {
      return null
    }
  }

  /**
   * The absolute path of one verified output of a finished job.
   *
   * `result.json` is the only result the app reads (spec section 7), so the
   * index names an entry there; the path it holds is joined through
   * {@link safeJoin} and therefore cannot leave the job directory.
   */
  async #approvedOutputPath(jobId: string, outputIndex: number): Promise<string> {
    const directory = join(this.#layout.jobs, jobId)
    const raw = await readOptionalFile(join(directory, 'result.json'))

    if (raw === null) {
      throw new LibraryError('NOT_FOUND', 'That job has no result to take an approved image from.')
    }

    const result = ResultSchema.safeParse(parseJson(raw, 'result.json'))

    if (!result.success) {
      throw new LibraryError('IO_ERROR', 'That job has an unreadable result file.')
    }

    const output = result.data.outputs[outputIndex]

    if (output === undefined) {
      throw new LibraryError('NOT_FOUND', 'That job has no image at the position given.')
    }

    return safeJoin(directory, ...output.path.split('/'))
  }

  async #readPreset(id: string): Promise<Preset | null> {
    const directory = await this.#libraryDirectory(this.#layout.presets, id)
    const raw = await readOptionalFile(join(directory, PRESET_FILE_NAME))
    const parsed = raw === null ? null : PresetSchema.safeParse(parseJson(raw, PRESET_FILE_NAME))

    return parsed !== null && parsed.success ? parsed.data : null
  }

  /** Every stored version of one anchor, oldest first. */
  async #readAnchorVersions(id: string): Promise<Anchor[]> {
    const directory = await this.#libraryDirectory(this.#layout.anchors, id)
    const versions: Anchor[] = []

    for (const name of await listDirectories(directory)) {
      if (!ANCHOR_VERSION_DIRECTORY.test(name)) {
        continue
      }

      const raw = await readOptionalFile(join(directory, name, ANCHOR_FILE_NAME))
      const parsed = raw === null ? null : AnchorSchema.safeParse(parseJson(raw, ANCHOR_FILE_NAME))

      if (parsed !== null && parsed.success) {
        versions.push(parsed.data)
      }
    }

    return versions.sort((left, right) => left.version - right.version)
  }

  /** `<parent>/<id>`, refusing an id that is not a library slug. */
  async #libraryDirectory(parent: string, id: string): Promise<string> {
    if (!LIBRARY_ID_REGEX.test(id) || id.length > 64) {
      throw new LibraryError('NOT_FOUND', `${JSON.stringify(id)} is not a library identifier.`)
    }

    await mkdir(parent, { recursive: true })

    return safeJoin(parent, id)
  }

  async #ensureDirectory(parent: string, id: string): Promise<string> {
    const directory = await this.#libraryDirectory(parent, id)

    await mkdir(directory, { recursive: true })

    return directory
  }

  /** The id a new preset or anchor gets: a slug of its name, then `-2`, `-3`… */
  async #freeLibraryId(parent: string, name: string, fallback: string): Promise<string> {
    const base = slugifySubject(name, { fallback, maxLength: MAX_LIBRARY_ID_LENGTH })

    for (let suffix = 1; suffix < 1000; suffix += 1) {
      const id = suffix === 1 ? base : `${base}-${String(suffix)}`

      if (!(await exists(join(parent, id)))) {
        return id
      }
    }

    throw new LibraryError(
      'IO_ERROR',
      `Could not find a free identifier for ${JSON.stringify(name)}.`
    )
  }
}

/** The stored-image metadata a preset or an anchor holds (plan decision Q4). */
interface StoredImage {
  readonly path: string
  readonly originalName: string
  readonly mimeType: ImageMimeType
  readonly sizeBytes: number
  readonly sha256: string
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** `v1`, `v2`, … (spec section 4.5). */
export function versionDirectory(version: number): string {
  return `${ANCHOR_VERSION_PREFIX}${String(version)}`
}

/**
 * Writes JSON through a temporary file and a rename, so a reader never sees a
 * half-written file and an interrupted write leaves the previous one in place.
 */
export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`

  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
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

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new LibraryError('IO_ERROR', `${basename(path)} is not valid JSON.`)
  }
}

async function listDirectories(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true })

    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }

    throw error
  }
}

/** Removes `<name>.png`, `<name>.jpg` and `<name>.webp`, whichever is there. */
async function removeStoredImages(directory: string, name: string): Promise<void> {
  for (const extension of ['png', 'jpg', 'webp']) {
    await rm(join(directory, `${name}.${extension}`), { force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)

    return true
  } catch {
    return false
  }
}

/** A regular file that is still there. A symlink does not count (spec 11). */
async function isReadableFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)

    return stats.isFile()
  } catch {
    return false
  }
}
