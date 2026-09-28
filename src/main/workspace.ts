/**
 * Workspace layout and safe path resolution (plan Task 2.1).
 *
 * Every path the main process touches on behalf of the renderer goes through
 * {@link safeJoin}. Spec section 11 requires paths to be normalized, path
 * traversal to be refused and symlinks not to be accepted, so this module is
 * the single gate: it rejects absolute parts, `..` segments and anything that
 * resolves — through a symlink or otherwise — outside the workspace root.
 *
 * The directory tree it owns is the one in spec section 9:
 *
 * ```text
 * workspace/
 *   drafts/    current.json
 *   presets/   <presetId>/preset.json + style.<ext>
 *   anchors/   <anchorId>/v<N>/anchor.json + identity.<ext>
 *   jobs/      <job-id>/...
 * ```
 *
 * This file may use Node built-ins but never Electron: the app object arrives
 * as {@link WorkspaceHost}, so the tests can describe a packaged app without
 * starting one.
 */
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { isValidJobId } from '../shared/job-id.ts'

/**
 * The four directories of spec section 9, created by
 * {@link ensureWorkspaceLayout}.
 */
export const WORKSPACE_DIRECTORIES = ['drafts', 'presets', 'anchors', 'jobs'] as const

export type WorkspaceDirectory = (typeof WORKSPACE_DIRECTORIES)[number]

/**
 * Overrides the workspace root. The Playwright harness of plan Task 6.1 points
 * the packaged app at a temp directory with it, and the integration tests use
 * the same door rather than a second mechanism.
 */
export const WORKSPACE_ENV_VAR = 'STUDIO_WORKSPACE'

/** The workspace directory name inside the app path or inside user data. */
export const WORKSPACE_DIRECTORY_NAME = 'workspace'

/**
 * The part of Electron's `app` this module needs (plan Task 2.1 signature
 * `resolveWorkspaceRoot(app)`). Declaring the shape instead of importing
 * Electron keeps the module testable and keeps `pnpm test` free of a browser.
 */
export interface WorkspaceHost {
  /** `app.isPackaged`: false under `pnpm dev`, true in a built app. */
  readonly isPackaged: boolean
  /** `app.getPath('userData')`, where a packaged app keeps its data. */
  getPath(name: 'userData'): string
  /** `app.getAppPath()`, the project root while developing. */
  getAppPath(): string
}

/** The absolute paths of the workspace tree. */
export interface WorkspaceLayout {
  readonly root: string
  readonly drafts: string
  readonly presets: string
  readonly anchors: string
  readonly jobs: string
}

/** Why {@link safeJoin} refused a path. */
export type UnsafePathReason =
  'empty-part' | 'absolute-part' | 'traversal' | 'separator-in-part' | 'escapes-root'

/**
 * Thrown instead of returning a path the caller must not use. The message names
 * the offending part; it stays inside the main process, because messages that
 * cross to the renderer are sanitized (spec section 11).
 */
export class UnsafePathError extends Error {
  readonly reason: UnsafePathReason

  constructor(reason: UnsafePathReason, message: string) {
    super(message)
    this.name = 'UnsafePathError'
    this.reason = reason
  }
}

/**
 * Where `workspace/` lives (plan Task 6.5).
 *
 * The environment override wins, then a packaged app keeps the workspace in
 * user data, and a development run keeps it in the project so the tree is
 * visible next to the code.
 */
export function resolveWorkspaceRoot(
  host: WorkspaceHost,
  env: Readonly<Partial<Record<string, string>>> = process.env
): string {
  const override = env[WORKSPACE_ENV_VAR]

  if (override !== undefined && override.trim() !== '') {
    return resolve(override)
  }

  const base = host.isPackaged ? host.getPath('userData') : host.getAppPath()

  return resolve(join(base, WORKSPACE_DIRECTORY_NAME))
}

/** The absolute paths under `root`, without touching the filesystem. */
export function workspaceLayout(root: string): WorkspaceLayout {
  const absoluteRoot = resolve(root)

  return {
    root: absoluteRoot,
    drafts: join(absoluteRoot, 'drafts'),
    presets: join(absoluteRoot, 'presets'),
    anchors: join(absoluteRoot, 'anchors'),
    jobs: join(absoluteRoot, 'jobs')
  }
}

/** Creates `root` and the four directories of spec section 9 if they are missing. */
export async function ensureWorkspaceLayout(root: string): Promise<WorkspaceLayout> {
  const layout = workspaceLayout(root)

  await mkdir(layout.root, { recursive: true })

  for (const name of WORKSPACE_DIRECTORIES) {
    await mkdir(layout[name], { recursive: true })
  }

  return layout
}

/**
 * The directory of one job (spec section 9).
 *
 * The job ID is validated first: it is the only user-derived value that becomes
 * a directory name, and spec section 6.1 forbids using one that does not match
 * the pattern.
 */
export function jobDir(root: string, jobId: string): string {
  if (!isValidJobId(jobId)) {
    throw new UnsafePathError(
      'traversal',
      `Refusing to build a job directory for an invalid job ID: ${JSON.stringify(jobId)}.`
    )
  }

  return join(workspaceLayout(root).jobs, jobId)
}

/**
 * Joins `parts` onto `root` with every check {@link safeJoin} makes except the
 * symlink one, which needs the filesystem.
 *
 * Use it only where the result is compared against a path that has already been
 * resolved; otherwise use {@link safeJoin}.
 */
export function safeJoinLexical(root: string, ...parts: readonly string[]): string {
  const absoluteRoot = resolve(root)
  let target = absoluteRoot

  for (const part of parts) {
    target = join(target, checkPart(part))
  }

  assertInside(absoluteRoot, target, parts)

  return target
}

/**
 * Joins `parts` onto `root` and returns the absolute path, or throws
 * {@link UnsafePathError}.
 *
 * Refused (spec section 11):
 *
 * - an empty part, or one holding a path separator;
 * - an absolute part such as `C:\x` or `/etc`;
 * - a `..` segment, before or after normalization;
 * - a path that leaves the root once symlinks are resolved. Both the root and
 *   the deepest existing ancestor of the target go through `realpath` first, so
 *   a symlink anywhere along the way is followed and then compared, and a link
 *   pointing outside the workspace is refused even though its own name looks
 *   harmless.
 *
 * The target does not have to exist: this is also the function that names a
 * file about to be written. `node:path.relative` does the containment check
 * because it compares whole segments and, on Windows, ignores case — a plain
 * `startsWith(root + sep)` would mis-handle both.
 *
 * `root` itself must exist, since a symlinked root has to be resolved before
 * anything can be compared against it. The path returned is built from the
 * `root` the caller passed, not from its resolved form, so it matches the paths
 * {@link workspaceLayout} hands out; only the containment check runs on
 * resolved paths.
 */
export async function safeJoin(root: string, ...parts: readonly string[]): Promise<string> {
  const absoluteRoot = resolve(root)
  const target = safeJoinLexical(absoluteRoot, ...parts)
  const realRoot = await realpath(absoluteRoot)
  const realTarget = await realpathOfNearestExisting(target)

  assertInside(realRoot, realTarget, parts)

  return target
}

/**
 * Whether `target` sits strictly inside `root`. Equal paths are not inside.
 */
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))

  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One path part: a plain file or directory name and nothing else. */
function checkPart(part: string): string {
  if (part === '') {
    throw new UnsafePathError('empty-part', 'Refusing an empty path part.')
  }

  if (isAbsolute(part) || /^[A-Za-z]:/.test(part)) {
    throw new UnsafePathError(
      'absolute-part',
      `Refusing an absolute path part: ${JSON.stringify(part)}.`
    )
  }

  if (part.includes('/') || part.includes('\\')) {
    throw new UnsafePathError(
      'separator-in-part',
      `Refusing a path part containing a separator: ${JSON.stringify(part)}.`
    )
  }

  if (part === '..' || part === '.') {
    throw new UnsafePathError('traversal', `Refusing the path part ${JSON.stringify(part)}.`)
  }

  return part
}

function assertInside(root: string, target: string, parts: readonly string[]): void {
  if (!isInsideRoot(root, target)) {
    throw new UnsafePathError(
      'escapes-root',
      `Refusing a path that leaves the workspace root: ${JSON.stringify(parts.join('/'))}.`
    )
  }
}

/**
 * `realpath` of the deepest ancestor of `target` that exists, with the missing
 * tail appended. A path that does not exist yet still has its existing
 * directories resolved, which is what catches a symlinked parent.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: string[] = []
  let current = target

  for (;;) {
    try {
      const resolved = await realpath(current)

      return missing.length === 0 ? resolved : join(resolved, ...[...missing].reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }

    const parent = dirname(current)

    if (parent === current) {
      return target
    }

    missing.push(basename(current))
    current = parent
  }
}
