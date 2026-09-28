/**
 * The throwaway workspace one end-to-end test runs against (plan Task 6.1).
 *
 * Every test gets its own directory under the OS temp directory, handed to the
 * app as `STUDIO_WORKSPACE` (plan Task 2.1). The repository's own `workspace/`
 * is never touched, and a test never sees a draft, preset, anchor or job that
 * another test wrote.
 *
 * The same directory holds the two files the harness scripts the app with:
 *
 * - `open-dialog.json`, read by the main process every time the renderer opens
 *   the reference picker (`src/main/test-hooks.ts`), because Playwright drives
 *   the renderer and cannot click a native file dialog;
 * - `sources/`, where the fixture images are copied before they are offered, so
 *   each slot gets a file with its own name and its own dimensions and a test
 *   can tell the five apart.
 *
 * Reading back from disk is part of the assertions: spec section 14.7 is about
 * a job directory being materialized, and the only honest way to check that is
 * to look at it.
 */
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Draft, JobPacket, Result } from '../../src/shared/schemas.ts'

const PREFIX = 'reference-image-studio-e2e-'

/**
 * `tests/fixtures/images/`, the three readable images the app accepts.
 *
 * `__dirname` rather than `import.meta.url`, because Playwright transpiles this
 * suite to CommonJS; see the note in `../fixtures.ts`.
 */
export const IMAGE_FIXTURE_DIR = resolve(__dirname, '..', '..', 'tests', 'fixtures', 'images')

/**
 * The fixture behind each role, and the dimensions `inspectImage` reads out of
 * it. They are all different, so an assertion about one slot cannot pass with
 * another slot's file in it.
 */
export const ROLE_FIXTURES = {
  style: { fixture: 'style-2x3.png', width: 2, height: 3 },
  identity: { fixture: 'identity-4x2.jpg', width: 4, height: 2 },
  outfit: { fixture: 'outfit-6x5.webp', width: 6, height: 5 },
  equipment: { fixture: 'style-2x3.png', width: 2, height: 3 },
  extra: { fixture: 'identity-4x2.jpg', width: 4, height: 2 }
} as const

export type FixtureRole = keyof typeof ROLE_FIXTURES

/** The file the app reads to learn what the reference picker answered. */
export const OPEN_DIALOG_FILE_NAME = 'open-dialog.json'

export class E2eWorkspace {
  /** The temp directory that holds everything this test owns. */
  readonly base: string
  /** `STUDIO_WORKSPACE`: the four directories of spec section 9 live under it. */
  readonly root: string
  /** `STUDIO_TEST_OPEN_DIALOG`: what the scripted file picker answers with. */
  readonly dialogScript: string
  /** Where the source images the user "chooses" are copied to. */
  readonly sources: string

  private constructor(base: string) {
    this.base = base
    this.root = join(base, 'workspace')
    this.dialogScript = join(base, OPEN_DIALOG_FILE_NAME)
    this.sources = join(base, 'sources')
  }

  static async create(): Promise<E2eWorkspace> {
    const workspace = new E2eWorkspace(await mkdtemp(join(tmpdir(), PREFIX)))

    await mkdir(workspace.root, { recursive: true })
    await mkdir(workspace.sources, { recursive: true })
    await workspace.cancelNextPick()

    return workspace
  }

  async remove(): Promise<void> {
    await rm(this.base, { recursive: true, force: true })
  }

  // -------------------------------------------------------------------------
  // Scripting the file picker
  // -------------------------------------------------------------------------

  /**
   * Copies the fixture for `role` under `name` and points the next pick at it.
   *
   * `name` becomes `originalName` in the builder, in `job.json` and in the
   * prompt's reference map, so giving each pick its own name is what lets a
   * test say which file ended up in which slot.
   */
  async offerImage(role: FixtureRole, name = defaultSourceName(role)): Promise<string> {
    const target = join(this.sources, name)

    await copyFile(join(IMAGE_FIXTURE_DIR, ROLE_FIXTURES[role].fixture), target)
    await this.offerPath(target)

    return target
  }

  /** Points the next pick at a file that already exists. */
  async offerPath(absPath: string): Promise<void> {
    await writeFile(
      this.dialogScript,
      JSON.stringify({ canceled: false, filePaths: [absPath] }),
      'utf8'
    )
  }

  /** Makes the next pick look like the user closing the picker. */
  async cancelNextPick(): Promise<void> {
    await writeFile(this.dialogScript, JSON.stringify({ canceled: true, filePaths: [] }), 'utf8')
  }

  // -------------------------------------------------------------------------
  // Reading the workspace back
  // -------------------------------------------------------------------------

  /** Every job directory name, oldest first. */
  async listJobIds(): Promise<string[]> {
    return (await this.entries(join(this.root, 'jobs'))).sort()
  }

  async readJobPacket(jobId: string): Promise<JobPacket> {
    return this.readJson<JobPacket>(join(this.root, 'jobs', jobId, 'job.json'))
  }

  async readResult(jobId: string): Promise<Result> {
    return this.readJson<Result>(join(this.root, 'jobs', jobId, 'result.json'))
  }

  /** The files in one job's `outputs/`, or an empty list when it has none. */
  async listOutputs(jobId: string): Promise<string[]> {
    return (await this.entries(join(this.root, 'jobs', jobId, 'outputs'))).sort()
  }

  /** `workspace/drafts/current.json`, or `null` when nothing has been saved. */
  async readDraft(): Promise<Draft | null> {
    try {
      return await this.readJson<Draft>(join(this.root, 'drafts', 'current.json'))
    } catch {
      return null
    }
  }

  async listPresetIds(): Promise<string[]> {
    return (await this.entries(join(this.root, 'presets'))).sort()
  }

  /** The version directories of one anchor, e.g. `['v1', 'v2']`. */
  async listAnchorVersions(anchorId: string): Promise<string[]> {
    return (await this.entries(join(this.root, 'anchors', anchorId))).sort()
  }

  async listAnchorIds(): Promise<string[]> {
    return (await this.entries(join(this.root, 'anchors'))).sort()
  }

  private async entries(directory: string): Promise<string[]> {
    try {
      return (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name)
    } catch {
      return []
    }
  }

  private async readJson<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(path, 'utf8')) as T
  }
}

/** `style-source.png` and friends: one recognisable name per role. */
export function defaultSourceName(role: FixtureRole): string {
  const extension = ROLE_FIXTURES[role].fixture.split('.').pop() ?? 'png'

  return `${role}-source.${extension}`
}
