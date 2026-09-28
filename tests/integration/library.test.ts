import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  Library,
  LibraryError,
  versionDirectory,
  type LoadedDraft
} from '../../src/main/library.ts'
import { ReferenceRegistry } from '../../src/main/reference-registry.ts'
import type { AnchorInput, DraftStateInput, PresetInput } from '../../src/shared/ipc-contract.ts'
import { sortReferences } from '../../src/shared/reference-roles.ts'
import {
  AnchorSchema,
  BuilderStateSchema,
  PresetSchema,
  SCHEMA_VERSION,
  type BuilderReference
} from '../../src/shared/schemas.ts'
import { createTempWorkspace, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const FIXTURE_IMAGES_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))
const STYLE_IMAGE = join(FIXTURE_IMAGES_DIR, 'style-2x3.png')
const IDENTITY_IMAGE = join(FIXTURE_IMAGES_DIR, 'identity-4x2.jpg')
const OUTFIT_IMAGE = join(FIXTURE_IMAGES_DIR, 'outfit-6x5.webp')

const THUMBNAIL = `data:image/png;base64,${Buffer.from('thumb').toString('base64')}`
const NOW = new Date('2026-09-28T10:00:00.000Z')

let workspace: TempWorkspace
let registry: ReferenceRegistry
let library: Library
/** Copies of the fixtures the tests may rename or delete. */
let sources: { style: string; identity: string; outfit: string }

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  registry = new ReferenceRegistry({ renderThumbnail: async () => THUMBNAIL })
  library = new Library({ workspace, registry, now: () => NOW })

  const outside = join(workspace.base, 'pictures')

  await mkdir(outside, { recursive: true })

  sources = {
    style: join(outside, 'master-style.png'),
    identity: join(outside, 'nixon-front.jpg'),
    outfit: join(outside, 'dark-suit.webp')
  }

  await copyFile(STYLE_IMAGE, sources.style)
  await copyFile(IDENTITY_IMAGE, sources.identity)
  await copyFile(OUTFIT_IMAGE, sources.outfit)
})

afterEach(async () => {
  await workspace.remove()
})

async function reference(path: string, role: BuilderReference['role']): Promise<BuilderReference> {
  return registry.createReference(path, { role })
}

/** A builder state as the renderer sends it: no displayPath, no thumbnail. */
function stateInput(references: BuilderReference[]): DraftStateInput {
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: { name: 'Richard Nixon', description: 'Chibi historical character portrait' },
    references: references.map(
      ({ displayPath: _displayPath, thumbnail: _thumbnail, ...rest }) => rest
    ),
    output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png', count: 1 },
    negativeConstraints: ['no text'],
    source: { preset: null, anchor: null }
  }
}

function presetInput(overrides: Partial<PresetInput> = {}): PresetInput {
  return {
    id: null,
    name: 'Chibi master',
    styleReferenceId: null,
    roleNotes: { style: 'Rough black outline' },
    promptConventions: ['keep the silhouette readable'],
    negativeConstraints: ['no text'],
    composition: { pose: 'Full body, standing upright' },
    output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png' },
    ...overrides
  }
}

function anchorInput(
  identityReferenceId: string,
  overrides: Partial<AnchorInput> = {}
): AnchorInput {
  return {
    id: null,
    name: 'Richard Nixon',
    identityReferenceId,
    approvedOutput: null,
    identityDescription: 'Chibi historical character portrait, late fifties',
    immutableTraits: ['receding hairline'],
    mutableTraits: ['outfit'],
    sourceJobId: null,
    ...overrides
  }
}

describe('draft round trip', () => {
  it('saves and loads the builder state (spec section 4.6)', async () => {
    const style = await reference(sources.style, 'style')
    const saved = await library.saveDraft(stateInput([style]))

    expect(saved.savedAt).toBe(NOW.toISOString())

    const loaded = await library.loadDraft()

    expect(loaded?.savedAt).toBe(NOW.toISOString())
    expect(loaded?.state.subject.name).toBe('Richard Nixon')
    expect(BuilderStateSchema.safeParse(loaded?.state).success).toBe(true)
  })

  it('returns null when nothing has been saved yet', async () => {
    await expect(library.loadDraft()).resolves.toBeNull()
  })

  // Plan decision Q3: the renderer never sends displayPath or the thumbnail
  // back, so main puts both back from the registry before writing.
  it('restores displayPath and the thumbnail from the registry', async () => {
    const style = await reference(sources.style, 'style')

    await library.saveDraft(stateInput([style]))

    const draft: unknown = JSON.parse(
      await readFile(join(workspace.drafts, 'current.json'), 'utf8')
    )

    expect(draft).toMatchObject({
      state: { references: [{ displayPath: style.displayPath, thumbnail: THUMBNAIL }] },
      referencePaths: { [style.referenceId]: sources.style }
    })
  })

  it('writes the draft atomically and leaves no temporary file behind', async () => {
    await library.saveDraft(stateInput([]))
    await library.saveDraft(stateInput([]))

    const files = await readdirNames(workspace.drafts)

    expect(files).toEqual(['current.json'])
  })

  it('registers the stored paths again on load, keeping the ids', async () => {
    const style = await reference(sources.style, 'style')

    await library.saveDraft(stateInput([style]))
    registry.clear()

    const loaded = await library.loadDraft()

    expect(registry.resolve(style.referenceId)).toBe(sources.style)
    expect(loaded?.state.references[0]?.referenceId).toBe(style.referenceId)
    expect(loaded?.state.references[0]?.thumbnail).toBe(THUMBNAIL)
  })

  // Spec section 4.2: warn when a reference file is gone.
  it('marks a reference missing once its file is deleted', async () => {
    const style = await reference(sources.style, 'style')
    const identity = await reference(sources.identity, 'identity')

    await library.saveDraft(stateInput([style, identity]))
    await rm(sources.style)

    const loaded = await library.loadDraft()
    const byRole = byRoleOf(loaded)

    expect(byRole.style?.missing).toBe(true)
    expect(byRole.identity?.missing).toBe(false)
  })

  it('clears the missing flag when the file comes back', async () => {
    const style = await reference(sources.style, 'style')
    const bytes = await readFile(sources.style)

    await library.saveDraft(stateInput([{ ...style, missing: true }]))
    await writeFile(sources.style, bytes)

    expect(byRoleOf(await library.loadDraft()).style?.missing).toBe(false)
  })

  it('keeps a missing reference across a save and load round trip', async () => {
    const style = await reference(sources.style, 'style')

    await library.saveDraft(stateInput([style]))
    await rm(sources.style)

    const loaded = await library.loadDraft()

    await library.saveDraft(stateInput(loaded?.state.references ?? []))

    expect(byRoleOf(await library.loadDraft()).style?.missing).toBe(true)
  })

  it('refuses to save a reference this session never registered', async () => {
    const style = await reference(sources.style, 'style')

    registry.forget(style.referenceId)

    await expect(library.saveDraft(stateInput([style]))).rejects.toMatchObject({
      code: 'MISSING_REFERENCE'
    })
  })

  it('refuses a draft file that is not readable rather than guessing', async () => {
    await writeFile(join(workspace.drafts, 'current.json'), '{ not json', 'utf8')

    await expect(library.loadDraft()).rejects.toBeInstanceOf(LibraryError)
  })

  /**
   * Plan decision Q22. Spec section 4.6 saves the draft as the user edits, so
   * the state a subject is halfway through being typed into has to survive the
   * window closing. `BuilderStateSchema` refuses it and `DraftStateSchema`
   * does not, which is the whole difference between the two.
   */
  it('stores a half-typed subject and reads it back (plan decision Q22)', async () => {
    const halfTyped = {
      ...stateInput([]),
      subject: { name: 'Ngu', description: '' },
      output: { ...stateInput([]).output, aspectRatio: '' }
    }

    expect(BuilderStateSchema.safeParse(halfTyped).success).toBe(false)

    await library.saveDraft(halfTyped)

    const loaded = await library.loadDraft()

    expect(loaded?.state.subject).toEqual({ name: 'Ngu', description: '' })
    expect(loaded?.state.output.aspectRatio).toBe('')
  })

  /**
   * Plan decision Q23: a `current.json` edited by hand can name one role twice,
   * which `sortReferences` would throw on where the renderer builds the prompt.
   * The extras are dropped instead.
   */
  it('drops a repeated reference role when loading (plan decision Q23)', async () => {
    const style = await reference(sources.style, 'style')
    const second = await reference(sources.outfit, 'style')

    await library.saveDraft(stateInput([style, second]))

    const loaded = await library.loadDraft()

    expect(loaded?.state.references).toHaveLength(1)
    expect(loaded?.state.references[0]?.referenceId).toBe(style.referenceId)
    expect(() => sortReferences(loaded?.state.references ?? [])).not.toThrow()
  })
})

describe('presets', () => {
  it('copies the style image next to the metadata (plan decision Q4)', async () => {
    const style = await reference(sources.style, 'style')
    const entry = await library.savePreset(presetInput({ styleReferenceId: style.referenceId }))

    expect(entry.preset.id).toBe('chibi-master')
    expect(entry.preset.styleReference).toMatchObject({
      path: 'style.png',
      originalName: 'master-style.png',
      mimeType: 'image/png'
    })

    const copied = join(workspace.presets, 'chibi-master', 'style.png')

    expect(await sha256Of(copied)).toBe(await sha256Of(sources.style))
    expect(entry.preset.styleReference?.sha256).toBe(await sha256Of(sources.style))
  })

  it('survives the source image being deleted afterwards', async () => {
    const style = await reference(sources.style, 'style')

    await library.savePreset(presetInput({ styleReferenceId: style.referenceId }))
    await rm(sources.style)

    const [entry] = await library.listPresets()

    expect(entry?.styleReference).toMatchObject({ originalName: 'master-style.png', width: 2 })
  })

  it('lists what it saved, with a handle for the stored image (decision Q18)', async () => {
    const style = await reference(sources.style, 'style')

    await library.savePreset(presetInput({ styleReferenceId: style.referenceId }))

    const [entry] = await library.listPresets()

    expect(PresetSchema.safeParse(entry?.preset).success).toBe(true)
    expect(entry?.styleReference?.role).toBe('style')
    expect(entry?.styleReference?.thumbnail).toBe(THUMBNAIL)
    expect(registry.resolve(entry?.styleReference?.referenceId ?? '')).toBe(
      join(workspace.presets, 'chibi-master', 'style.png')
    )
  })

  it('saves a preset with no style image', async () => {
    const entry = await library.savePreset(presetInput())

    expect(entry.preset.styleReference).toBeNull()
    expect(entry.styleReference).toBeNull()
  })

  it('gives a second preset of the same name its own directory', async () => {
    const first = await library.savePreset(presetInput())
    const second = await library.savePreset(presetInput())

    expect(first.preset.id).toBe('chibi-master')
    expect(second.preset.id).toBe('chibi-master-2')
    expect((await library.listPresets()).map((entry) => entry.preset.id)).toEqual([
      'chibi-master',
      'chibi-master-2'
    ])
  })

  it('keeps createdAt and replaces the image when saving over an id', async () => {
    const style = await reference(sources.style, 'style')
    const outfit = await reference(sources.outfit, 'outfit')
    const first = await library.savePreset(presetInput({ styleReferenceId: style.referenceId }))

    const later = new Library({ workspace, registry, now: () => new Date('2026-09-29T11:00:00Z') })
    const second = await later.savePreset(
      presetInput({ id: first.preset.id, styleReferenceId: outfit.referenceId })
    )

    expect(second.preset.createdAt).toBe(first.preset.createdAt)
    expect(second.preset.updatedAt).toBe('2026-09-29T11:00:00.000Z')
    expect(second.preset.styleReference?.path).toBe('style.webp')
    expect(await readdirNames(join(workspace.presets, first.preset.id))).toEqual([
      'preset.json',
      'style.webp'
    ])
  })

  it('deletes the directory and the image with it (decision Q7)', async () => {
    const style = await reference(sources.style, 'style')
    const entry = await library.savePreset(presetInput({ styleReferenceId: style.referenceId }))

    await library.deletePreset(entry.preset.id)

    expect(await library.listPresets()).toEqual([])
    await expect(library.deletePreset(entry.preset.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an id that could escape the presets directory', async () => {
    for (const id of ['../jobs', 'Chibi', 'a/b']) {
      await expect(library.deletePreset(id)).rejects.toBeInstanceOf(LibraryError)
    }
  })

  it('refuses a style image whose handle is unknown', async () => {
    await expect(
      library.savePreset(presetInput({ styleReferenceId: '11111111-1111-4111-8111-111111111111' }))
    ).rejects.toMatchObject({ code: 'MISSING_REFERENCE' })
  })
})

describe('anchors', () => {
  it('writes v1 and then v2 without touching the older version (spec 4.5)', async () => {
    const identity = await reference(sources.identity, 'identity')
    const first = await library.saveAnchor(anchorInput(identity.referenceId))

    expect(first.anchor.version).toBe(1)

    const other = await reference(sources.outfit, 'identity')
    const second = await library.saveAnchor(
      anchorInput(other.referenceId, { id: first.anchor.id, identityDescription: 'changed' })
    )

    expect(second.anchor.version).toBe(2)
    expect(await readdirNames(join(workspace.anchors, first.anchor.id))).toEqual(['v1', 'v2'])

    const v1: unknown = JSON.parse(
      await readFile(join(workspace.anchors, first.anchor.id, 'v1', 'anchor.json'), 'utf8')
    )

    expect(v1).toMatchObject({ version: 1, identityDescription: first.anchor.identityDescription })
    expect(await sha256Of(join(workspace.anchors, first.anchor.id, 'v1', 'identity.jpg'))).toBe(
      await sha256Of(sources.identity)
    )
    expect(await sha256Of(join(workspace.anchors, first.anchor.id, 'v2', 'identity.webp'))).toBe(
      await sha256Of(sources.outfit)
    )
  })

  it('copies the identity image and validates against the schema', async () => {
    const identity = await reference(sources.identity, 'identity')
    const entry = await library.saveAnchor(anchorInput(identity.referenceId))

    expect(AnchorSchema.safeParse(entry.anchor).success).toBe(true)
    expect(entry.anchor.identityReference).toMatchObject({
      path: 'identity.jpg',
      originalName: 'nixon-front.jpg',
      mimeType: 'image/jpeg'
    })
    expect(entry.identityReference?.role).toBe('identity')
  })

  it('lists every version of every anchor, oldest first (decision Q18)', async () => {
    const identity = await reference(sources.identity, 'identity')
    const first = await library.saveAnchor(anchorInput(identity.referenceId))

    await library.saveAnchor(anchorInput(identity.referenceId, { id: first.anchor.id }))
    await library.saveAnchor(anchorInput(identity.referenceId, { name: 'John Kennedy' }))

    expect(
      (await library.listAnchors()).map(
        (entry) => `${entry.anchor.id}/v${String(entry.anchor.version)}`
      )
    ).toEqual(['john-kennedy/v1', 'richard-nixon/v1', 'richard-nixon/v2'])
  })

  it('keeps the version numbering past a deleted version', async () => {
    const identity = await reference(sources.identity, 'identity')
    const first = await library.saveAnchor(anchorInput(identity.referenceId))

    await library.saveAnchor(anchorInput(identity.referenceId, { id: first.anchor.id }))
    await rm(join(workspace.anchors, first.anchor.id, versionDirectory(1)), {
      recursive: true,
      force: true
    })

    const third = await library.saveAnchor(
      anchorInput(identity.referenceId, { id: first.anchor.id })
    )

    expect(third.anchor.version).toBe(3)
  })

  // Plan Task 1.6: an approved output is named by job and index, not by file name.
  it('copies the approved output named by job and output index', async () => {
    const jobId = '2026-09-28-richard-nixon-001'
    const outputPath = await writeFinishedJob(jobId)
    const identity = await reference(sources.identity, 'identity')
    const entry = await library.saveAnchor(
      anchorInput(identity.referenceId, {
        approvedOutput: { jobId, outputIndex: 0 },
        sourceJobId: jobId
      })
    )

    expect(entry.anchor.approvedOutput).toMatchObject({ path: 'approved.png' })
    expect(await sha256Of(join(workspace.anchors, entry.anchor.id, 'v1', 'approved.png'))).toBe(
      await sha256Of(outputPath)
    )
  })

  it('refuses an approved output index that does not exist', async () => {
    const jobId = '2026-09-28-richard-nixon-001'

    await writeFinishedJob(jobId)

    const identity = await reference(sources.identity, 'identity')

    await expect(
      library.saveAnchor(
        anchorInput(identity.referenceId, { approvedOutput: { jobId, outputIndex: 3 } })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an approved output from a job that never finished', async () => {
    const identity = await reference(sources.identity, 'identity')

    await expect(
      library.saveAnchor(
        anchorInput(identity.referenceId, {
          approvedOutput: { jobId: '2026-09-28-nobody-009', outputIndex: 0 }
        })
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses an identity handle the registry does not know', async () => {
    await expect(
      library.saveAnchor(anchorInput('11111111-1111-4111-8111-111111111111'))
    ).rejects.toMatchObject({ code: 'MISSING_REFERENCE' })
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readdirNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).sort()
}

function byRoleOf(loaded: LoadedDraft | null): Partial<Record<string, BuilderReference>> {
  return Object.fromEntries(
    (loaded?.state.references ?? []).map((entry) => [entry.role, entry])
  ) as Partial<Record<string, BuilderReference>>
}

/** A job directory with one verified output, as plan Task 3.6 would leave it. */
async function writeFinishedJob(jobId: string): Promise<string> {
  const directory = join(workspace.jobs, jobId)
  const outputPath = join(directory, 'outputs', '001.png')

  await mkdir(join(directory, 'outputs'), { recursive: true })
  await copyFile(STYLE_IMAGE, outputPath)

  const bytes = await readFile(outputPath)

  await writeFile(
    join(directory, 'result.json'),
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      jobId,
      status: 'succeeded',
      startedAt: '2026-09-28T10:00:02Z',
      completedAt: '2026-09-28T10:01:12Z',
      executor: { codexVersion: '0.158.0', executable: 'codex.exe', exitCode: 0, signal: null },
      outputs: [
        {
          path: 'outputs/001.png',
          mimeType: 'image/png',
          width: 2,
          height: 3,
          sizeBytes: bytes.byteLength,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      ],
      warnings: [],
      promptPath: 'prompt.md',
      error: null
    }),
    'utf8'
  )

  return outputPath
}
