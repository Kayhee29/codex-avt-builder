import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_INSTRUCTION_TEMPLATE_PATH,
  JOB_ID_PLACEHOLDER,
  JobMaterializer,
  MaterializeError
} from '../../src/main/job-materializer.ts'
import { ReferenceRegistry } from '../../src/main/reference-registry.ts'
import { CODEX_MIN_VERSION } from '../../src/shared/codex-version.ts'
import type { BuilderStateInput } from '../../src/shared/ipc-contract.ts'
import { buildPrompt, sha256Hex, type OrderedReference } from '../../src/shared/prompt-builder.ts'
import { assignReferenceLabels } from '../../src/shared/reference-roles.ts'
import {
  JobPacketSchema,
  SCHEMA_VERSION,
  type BuilderReference,
  type BuilderState
} from '../../src/shared/schemas.ts'
import { createTempWorkspace, linkFile, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const FIXTURE_IMAGES_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))
const STYLE_IMAGE = join(FIXTURE_IMAGES_DIR, 'style-2x3.png')
const IDENTITY_IMAGE = join(FIXTURE_IMAGES_DIR, 'identity-4x2.jpg')
const OUTFIT_IMAGE = join(FIXTURE_IMAGES_DIR, 'outfit-6x5.webp')
const NOT_AN_IMAGE = join(FIXTURE_IMAGES_DIR, 'text-pretending-to-be.png')

const NOW = new Date('2026-09-28T10:00:00.000Z')
const THUMBNAIL = `data:image/png;base64,${Buffer.from('thumb').toString('base64')}`

let workspace: TempWorkspace
let registry: ReferenceRegistry
let materializer: JobMaterializer
let sources: Record<'style' | 'identity' | 'outfit' | 'text', string>

beforeEach(async () => {
  workspace = await createTempWorkspace()
  registry = new ReferenceRegistry({ renderThumbnail: async () => THUMBNAIL })
  materializer = new JobMaterializer({ workspace, registry, now: () => NOW })

  const pictures = join(workspace.base, 'pictures')

  await mkdir(pictures, { recursive: true })

  sources = {
    style: join(pictures, 'master-style.png'),
    identity: join(pictures, 'nixon-front.jpg'),
    outfit: join(pictures, 'dark-suit.webp'),
    text: join(pictures, 'not-an-image.png')
  }

  await copyFile(STYLE_IMAGE, sources.style)
  await copyFile(IDENTITY_IMAGE, sources.identity)
  await copyFile(OUTFIT_IMAGE, sources.outfit)
  await copyFile(NOT_AN_IMAGE, sources.text)
})

afterEach(async () => {
  await workspace.remove()
})

async function handle(
  path: string,
  role: BuilderReference['role'],
  note?: string
): Promise<BuilderReference> {
  return registry.createReference(path, {
    role,
    ...(note === undefined ? {} : { note })
  })
}

/** The builder state the renderer holds, handles and all. */
function builderState(
  references: BuilderReference[],
  overrides: Partial<BuilderState> = {}
): BuilderState {
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: {
      name: 'Richard Nixon',
      description: 'Chibi historical character portrait',
      pose: 'Full body, standing upright'
    },
    references,
    output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png', count: 1 },
    negativeConstraints: ['no text'],
    source: { preset: 'chibi-master-v1', anchor: 'nixon' },
    ...overrides
  }
}

/** The same state as it crosses IPC: no displayPath, no thumbnail (Q3, Q19). */
function toInput(state: BuilderState): BuilderStateInput {
  return {
    ...state,
    references: state.references.map(
      ({ displayPath: _displayPath, thumbnail: _thumbnail, ...rest }) => rest
    )
  }
}

/**
 * The checksum the renderer computes, over the state it holds, with the same
 * pure prompt builder the materializer calls (spec sections 4.3 and 10).
 */
async function previewChecksum(state: BuilderState): Promise<string> {
  const references = assignReferenceLabels(state.references).map((reference): OrderedReference => ({
    label: reference.label,
    role: reference.role,
    originalName: reference.originalName,
    ...(reference.note === undefined ? {} : { note: reference.note })
  }))
  const { markdown } = buildPrompt(state, references)

  return sha256Hex(markdown)
}

async function materialize(state: BuilderState) {
  return materializer.materialize(toInput(state), await previewChecksum(state))
}

async function sha256Of(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

describe('materialize', () => {
  it('writes every file spec section 5.2 lists', async () => {
    const state = builderState([
      await handle(sources.style, 'style', 'Rough black outline'),
      await handle(sources.identity, 'identity')
    ])
    const job = await materialize(state)

    expect(job.jobId).toBe('2026-09-28-richard-nixon-001')
    expect((await readdir(job.directory)).sort()).toEqual([
      'inputs',
      'job.json',
      'outputs',
      'prompt.md',
      'run-instructions.md'
    ])
    expect((await readdir(join(job.directory, 'inputs'))).sort()).toEqual([
      'identity.jpg',
      'style.png'
    ])
    expect(await readdir(join(job.directory, 'outputs'))).toEqual([])
  })

  it('writes a job.json that validates against the schema', async () => {
    const job = await materialize(builderState([await handle(sources.style, 'style')]))
    const written: unknown = JSON.parse(await readFile(join(job.directory, 'job.json'), 'utf8'))
    const parsed = JobPacketSchema.safeParse(written)

    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual(job.packet)
    expect(job.packet.executor).toEqual({
      kind: 'codex-cli',
      minimumVersion: CODEX_MIN_VERSION,
      imageTool: 'image_gen'
    })
    expect(job.packet.createdAt).toBe(NOW.toISOString())
    expect(job.packet.source).toEqual({ preset: 'chibi-master-v1', anchor: 'nixon' })
  })

  // Spec section 6.2: every number in the packet is measured from the copy.
  it('records the sha256 of the file in inputs/, not of the original', async () => {
    const job = await materialize(
      builderState([
        await handle(sources.style, 'style'),
        await handle(sources.outfit, 'outfit'),
        await handle(sources.identity, 'identity')
      ])
    )

    for (const reference of job.packet.references) {
      const copied = join(job.directory, ...reference.path.split('/'))

      expect(reference.sha256).toBe(await sha256Of(copied))
      expect(reference.sizeBytes).toBe((await readFile(copied)).byteLength)
    }
  })

  // Plan decision Q14 and spec section 5.3: labels follow attachment order.
  it('sorts references by role and labels them in that order', async () => {
    const job = await materialize(
      builderState([
        await handle(sources.outfit, 'outfit'),
        await handle(sources.identity, 'identity')
      ])
    )

    expect(job.packet.references.map((reference) => [reference.label, reference.role])).toEqual([
      ['Image A', 'identity'],
      ['Image B', 'outfit']
    ])
    expect(job.inputPaths).toEqual([
      join(job.directory, 'inputs', 'identity.jpg'),
      join(job.directory, 'inputs', 'outfit.webp')
    ])
  })

  it('names the copy after the role and the measured format', async () => {
    const misnamed = join(workspace.base, 'pictures', 'identity.png')

    await copyFile(IDENTITY_IMAGE, misnamed)

    const job = await materialize(builderState([await handle(misnamed, 'identity')]))

    expect(job.packet.references[0]).toMatchObject({
      path: 'inputs/identity.jpg',
      originalName: 'identity.png',
      mimeType: 'image/jpeg'
    })
  })

  it('keeps the per-role note in the packet and in the prompt', async () => {
    const job = await materialize(
      builderState([await handle(sources.style, 'style', 'Rough black outline')])
    )

    expect(job.packet.references[0]?.note).toBe('Rough black outline')
    expect(await readFile(join(job.directory, 'prompt.md'), 'utf8')).toContain(
      'Rough black outline'
    )
  })

  it('stores the negative constraints as their own field (spec section 6.2)', async () => {
    const job = await materialize(
      builderState([], { negativeConstraints: ['no text', ' No  Text ', 'no watermark'] })
    )

    // De-duplicated the way the prompt de-duplicates them, so the packet and
    // the text of prompt.md list the same constraints in the same order.
    expect(job.packet.negativeConstraints).toEqual(['no text', 'no watermark'])
    expect(await readFile(join(job.directory, 'prompt.md'), 'utf8')).toContain('- no watermark')
  })

  it('writes the previewed prompt and records its checksum', async () => {
    const state = builderState([await handle(sources.style, 'style')])
    const checksum = await previewChecksum(state)
    const job = await materializer.materialize(toInput(state), checksum)
    const written = await readFile(join(job.directory, 'prompt.md'), 'utf8')

    expect(written).toBe(job.prompt)
    expect(await sha256Hex(written)).toBe(checksum)
    expect(job.packet.promptSha256).toBe(checksum)
    expect(job.packet.promptPath).toBe('prompt.md')
  })

  it('materializes run-instructions.md from the template with the job ID', async () => {
    const job = await materialize(builderState([]))
    const instructions = await readFile(join(job.directory, 'run-instructions.md'), 'utf8')
    const template = await readFile(DEFAULT_INSTRUCTION_TEMPLATE_PATH, 'utf8')

    expect(instructions).not.toContain(JOB_ID_PLACEHOLDER)
    expect(instructions).toContain(job.jobId)
    expect(instructions.split(job.jobId)).toHaveLength(template.split(JOB_ID_PLACEHOLDER).length)
  })

  it('takes the template from wherever it is told to', async () => {
    const template = join(workspace.base, 'template.md')

    await writeFile(template, `Job ${JOB_ID_PLACEHOLDER}.\n`, 'utf8')

    const custom = new JobMaterializer({
      workspace,
      registry,
      now: () => NOW,
      instructionTemplatePath: template
    })
    const state = builderState([])
    const job = await custom.materialize(toInput(state), await previewChecksum(state))

    expect(await readFile(join(job.directory, 'run-instructions.md'), 'utf8')).toBe(
      `Job ${job.jobId}.\n`
    )
  })

  // Spec section 5.2: the copy is what makes a run reproducible.
  it('is unaffected by the source being renamed or deleted afterwards', async () => {
    const job = await materialize(builderState([await handle(sources.style, 'style')]))
    const copied = join(job.directory, 'inputs', 'style.png')
    const before = await sha256Of(copied)

    await rename(sources.style, join(workspace.base, 'pictures', 'renamed.png'))
    await rm(join(workspace.base, 'pictures', 'renamed.png'))

    expect(await sha256Of(copied)).toBe(before)
    expect(await sha256Of(copied)).toBe(job.packet.references[0]?.sha256)
  })

  it('gives the second job of the day the next sequence number', async () => {
    const state = builderState([await handle(sources.style, 'style')])
    const first = await materializer.materialize(toInput(state), await previewChecksum(state))
    const second = await materializer.materialize(toInput(state), await previewChecksum(state))

    expect(first.jobId).toBe('2026-09-28-richard-nixon-001')
    expect(second.jobId).toBe('2026-09-28-richard-nixon-002')
    expect((await readdir(workspace.jobs)).sort()).toEqual([first.jobId, second.jobId])
  })

  it('skips a sequence number whose directory already exists', async () => {
    await mkdir(join(workspace.jobs, '2026-09-28-richard-nixon-001'), { recursive: true })

    const job = await materialize(builderState([]))

    expect(job.jobId).toBe('2026-09-28-richard-nixon-002')
  })

  it('never modifies job.json once written (spec section 6)', async () => {
    const job = await materialize(builderState([]))

    await expect(
      writeFile(join(job.directory, 'job.json'), '{}', { encoding: 'utf8', flag: 'wx' })
    ).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('materializes a job with no references at all', async () => {
    const job = await materialize(builderState([]))

    expect(job.packet.references).toEqual([])
    expect(await readdir(join(job.directory, 'inputs'))).toEqual([])
    expect(job.prompt).toContain('No reference images are attached.')
  })
})

describe('refusals', () => {
  async function jobDirectories(): Promise<string[]> {
    return readdir(workspace.jobs)
  }

  it('refuses a state with no subject name before creating anything', async () => {
    const state = builderState([], { subject: { name: '', description: 'x' } })

    await expect(materializer.materialize(toInput(state), 'a'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_JOB'
    })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  it('refuses a state with no description', async () => {
    const state = builderState([], { subject: { name: 'Richard Nixon', description: '' } })

    await expect(
      materializer.materialize(toInput(state), await previewChecksum(state))
    ).rejects.toBeInstanceOf(MaterializeError)
    await expect(jobDirectories()).resolves.toEqual([])
  })

  // Spec section 10: the preview and the job must be the same prompt.
  it('refuses a checksum that does not match the prompt it rebuilt', async () => {
    const state = builderState([await handle(sources.style, 'style')])

    await expect(materializer.materialize(toInput(state), 'f'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_JOB'
    })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  it('refuses two references in the same role', async () => {
    const style = await handle(sources.style, 'style')
    const other = await handle(sources.outfit, 'style')
    const state = builderState([style, other])

    await expect(materializer.materialize(toInput(state), 'a'.repeat(64))).rejects.toMatchObject({
      code: 'INVALID_JOB'
    })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  it('refuses a reference id this session never issued', async () => {
    const style = await handle(sources.style, 'style')

    registry.forget(style.referenceId)

    await expect(
      materializer.materialize(toInput(builderState([style])), 'a'.repeat(64))
    ).rejects.toMatchObject({ code: 'MISSING_REFERENCE' })
  })

  it('refuses a reference whose file disappeared after it was picked', async () => {
    const style = await handle(sources.style, 'style')
    const state = builderState([style])
    const checksum = await previewChecksum(state)

    await rm(sources.style)

    await expect(materializer.materialize(toInput(state), checksum)).rejects.toMatchObject({
      code: 'MISSING_REFERENCE'
    })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  it('refuses a reference that is no longer a supported image', async () => {
    const style = await handle(sources.style, 'style')
    const state = builderState([style])
    const checksum = await previewChecksum(state)

    await writeFile(sources.style, 'not an image any more', 'utf8')

    await expect(materializer.materialize(toInput(state), checksum)).rejects.toMatchObject({
      code: 'INVALID_JOB'
    })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  // Spec section 11: a symlink is not accepted as a job input.
  it('refuses a source that is a symlink', async (context) => {
    const linkPath = join(workspace.base, 'pictures', 'linked-style.png')
    const kind = await linkFile(sources.style, linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating file symlinks without elevation')

      return
    }

    const style = await registry.createReference(linkPath, { role: 'style' }).catch(() => null)

    // The inspector refuses the link outright, so no handle is ever minted.
    expect(style).toBeNull()

    const id = registry.register(linkPath)
    const state = builderState([
      {
        referenceId: id,
        role: 'style',
        originalName: 'linked-style.png',
        displayPath: linkPath,
        mimeType: 'image/png',
        sizeBytes: 75,
        width: 2,
        height: 3,
        sha256: await sha256Of(sources.style),
        missing: false
      }
    ])

    await expect(
      materializer.materialize(toInput(state), await previewChecksum(state))
    ).rejects.toMatchObject({ code: 'INVALID_JOB' })
    await expect(jobDirectories()).resolves.toEqual([])
  })

  it('refuses an image over the size limit', async () => {
    const small = new JobMaterializer({ workspace, registry, now: () => NOW, maxBytes: 10 })
    const style = await registry.createReference(sources.style, { role: 'style' })
    const state = builderState([style])

    await expect(
      small.materialize(toInput(state), await previewChecksum(state))
    ).rejects.toMatchObject({
      code: 'INVALID_JOB'
    })
  })
})
