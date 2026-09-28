/**
 * The opaque-handle registry (plan Task 2.3, decision Q3).
 *
 * The renderer never sees, holds or sends an absolute path (spec section 11).
 * It holds a `referenceId`, and this registry is the only thing that knows
 * which file that id stands for. Everything the UI needs about the file —
 * name, format, measurements, a shortened display path and the thumbnail of
 * spec section 4.2 — travels in a `BuilderReference`, which by construction has
 * no path field.
 *
 * Four kinds of file become a reference, all through
 * {@link ReferenceRegistry.createReference}:
 *
 * 1. a file the user picked in the file dialog (`./dialog.ts`);
 * 2. the style image stored with a preset (plan decision Q4, Task 2.4);
 * 3. the identity image stored with one anchor version (same);
 * 4. each file in a finished job's `inputs/`, so a job can be duplicated into
 *    a new draft (plan Task 5.5).
 *
 * Node built-ins are allowed here; Electron is not imported at module level, so
 * the tests run without a browser. {@link nativeImageThumbnail} loads Electron
 * lazily and only the packaged app ever calls it.
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, sep } from 'node:path'

import type { ReferenceRole } from '../shared/reference-roles.ts'
import { type BuilderReference } from '../shared/schemas.ts'

import { inspectImage, type InspectImageOptions } from './image-inspect.ts'

/** Width of the preview main renders for a slot (plan Task 2.3). */
export const THUMBNAIL_WIDTH = 256

/** Display paths longer than this are shortened in the middle. */
export const MAX_DISPLAY_PATH_LENGTH = 64

/**
 * Renders the thumbnail for one file, or `null` when the file cannot be
 * decoded. Injected so the tests never need Electron; production passes
 * {@link nativeImageThumbnail}.
 */
export type ThumbnailRenderer = (absPath: string) => Promise<string | null>

/** What the registry knows about one registered file. */
export interface ReferenceEntry {
  /** The absolute path. Never leaves the main process. */
  readonly path: string
  /** The shortened form shown in the UI (spec section 4.2). */
  readonly displayPath: string
  /** The last thumbnail rendered for this file, if any. */
  readonly thumbnail?: string
}

export interface RegisterOptions {
  /**
   * Bind this id instead of minting one. `draft.load` uses it to give a saved
   * draft back the ids it was saved with (plan decision Q3), and a job's
   * inputs reuse the id of the reference they came from.
   */
  readonly referenceId?: string
  /** Remember a thumbnail rendered elsewhere, such as one read back from a draft. */
  readonly thumbnail?: string
}

export interface CreateReferenceOptions extends InspectImageOptions, RegisterOptions {
  readonly role: ReferenceRole
  /** The name the user recognises. Defaults to the file name on disk. */
  readonly originalName?: string
  /** The per-role note of spec section 4.2. */
  readonly note?: string
}

export interface ReferenceRegistryOptions {
  /** Defaults to a renderer that returns `null`, so a headless run has no thumbnails. */
  readonly renderThumbnail?: ThumbnailRenderer
  /** Defaults to {@link randomUUID}. */
  readonly newReferenceId?: () => string
  /** Defaults to {@link shortenPath}. */
  readonly shortenDisplayPath?: (absPath: string) => string
}

/**
 * `referenceId` to absolute path, plus the display data main derived from the
 * file. It lives for one app session: ids are minted again after a restart,
 * which is why `draft.load` re-registers the paths a draft carries.
 */
export class ReferenceRegistry {
  readonly #byId = new Map<string, ReferenceEntry>()
  readonly #idByPath = new Map<string, string>()
  readonly #renderThumbnail: ThumbnailRenderer
  readonly #newReferenceId: () => string
  readonly #shortenDisplayPath: (absPath: string) => string

  constructor(options: ReferenceRegistryOptions = {}) {
    this.#renderThumbnail = options.renderThumbnail ?? (async () => null)
    this.#newReferenceId = options.newReferenceId ?? randomUUID
    this.#shortenDisplayPath = options.shortenDisplayPath ?? shortenPath
  }

  /** How many files are registered. */
  get size(): number {
    return this.#byId.size
  }

  /**
   * Registers `absPath` and returns its id.
   *
   * Registering the same path twice returns the id it already has, so
   * re-registering the references of a draft does not multiply them. Passing
   * `referenceId` binds that id instead, and it becomes the id this path
   * reports from then on.
   */
  register(absPath: string, options: RegisterOptions = {}): string {
    const existing = this.#idByPath.get(absPath)
    const referenceId = options.referenceId ?? existing ?? this.#newReferenceId()
    const previous = this.#byId.get(referenceId)
    const thumbnail =
      options.thumbnail ?? (previous?.path === absPath ? previous.thumbnail : undefined)

    this.#byId.set(referenceId, {
      path: absPath,
      displayPath: this.#shortenDisplayPath(absPath),
      ...(thumbnail === undefined ? {} : { thumbnail })
    })
    this.#idByPath.set(absPath, referenceId)

    return referenceId
  }

  /** Registers several paths at once, in order (plan Task 2.3, for `draft.load`). */
  registerMany(paths: readonly string[]): string[] {
    return paths.map((path) => this.register(path))
  }

  /** The absolute path behind an id, or `undefined` for an id this session never issued. */
  resolve(referenceId: string): string | undefined {
    return this.#byId.get(referenceId)?.path
  }

  /** Everything the registry holds for an id, including the display data. */
  describe(referenceId: string): ReferenceEntry | undefined {
    return this.#byId.get(referenceId)
  }

  /** Drops an id. The path can be registered again and gets a new id. */
  forget(referenceId: string): void {
    const entry = this.#byId.get(referenceId)

    if (entry === undefined) {
      return
    }

    this.#byId.delete(referenceId)

    if (this.#idByPath.get(entry.path) === referenceId) {
      this.#idByPath.delete(entry.path)
    }
  }

  /** Drops everything, for a test or a workspace switch. */
  clear(): void {
    this.#byId.clear()
    this.#idByPath.clear()
  }

  /**
   * Measures the image at `absPath`, registers it and returns the handle the
   * renderer holds.
   *
   * Throws `ImageInspectError` when the file is not a supported image, is a
   * symlink, is too large or is gone (spec sections 4.2 and 11); the caller
   * turns that into the IPC error envelope. A thumbnail that cannot be rendered
   * is left out rather than failing the call.
   */
  async createReference(
    absPath: string,
    options: CreateReferenceOptions
  ): Promise<BuilderReference> {
    const inspected = await inspectImage(absPath, {
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
    })
    const thumbnail = options.thumbnail ?? (await this.#safeThumbnail(absPath))
    const referenceId = this.register(absPath, {
      ...(options.referenceId === undefined ? {} : { referenceId: options.referenceId }),
      ...(thumbnail === null || thumbnail === undefined ? {} : { thumbnail })
    })
    const entry = this.#byId.get(referenceId)

    return {
      referenceId,
      role: options.role,
      originalName: options.originalName ?? basename(absPath),
      displayPath: entry?.displayPath ?? this.#shortenDisplayPath(absPath),
      ...(thumbnail === null || thumbnail === undefined ? {} : { thumbnail }),
      mimeType: inspected.mimeType,
      width: inspected.width,
      height: inspected.height,
      sizeBytes: inspected.sizeBytes,
      sha256: inspected.sha256,
      ...(options.note === undefined ? {} : { note: options.note }),
      missing: false
    }
  }

  /** A thumbnail, or nothing: a preview is never worth failing a call over. */
  async #safeThumbnail(absPath: string): Promise<string | null> {
    try {
      return await this.#renderThumbnail(absPath)
    } catch {
      return null
    }
  }
}

/**
 * The production thumbnail renderer.
 *
 * Electron is imported lazily so that importing this module in a plain Node
 * test does not pull in the browser runtime. `nativeImage` keeps the aspect
 * ratio when only a width is given, and reports an empty image for a file it
 * cannot decode.
 */
export async function nativeImageThumbnail(absPath: string): Promise<string | null> {
  const { nativeImage } = await import('electron')
  const image = nativeImage.createFromPath(absPath)

  if (image.isEmpty()) {
    return null
  }

  return image.resize({ width: THUMBNAIL_WIDTH }).toDataURL()
}

/**
 * The source path as the UI shows it (spec section 4.2).
 *
 * The home directory becomes `~`, and a long path keeps its first and last
 * segments with an ellipsis in between. It is display text: it never comes
 * back from the renderer and is never used to open anything.
 */
export function shortenPath(absPath: string, home: string = homedir()): string {
  const withHome =
    home !== '' && absPath.toLowerCase().startsWith(home.toLowerCase())
      ? `~${absPath.slice(home.length)}`
      : absPath

  if (withHome.length <= MAX_DISPLAY_PATH_LENGTH) {
    return withHome
  }

  const segments = withHome.split(/[\\/]/).filter((segment) => segment !== '')
  const first = segments[0] ?? ''
  const last = segments.slice(-2).join(sep)

  return segments.length <= 3 ? withHome : `${first}${sep}…${sep}${last}`
}
