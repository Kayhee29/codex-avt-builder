import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IMAGE_FILE_EXTENSIONS,
  REFERENCE_DIALOG_TEXT,
  selectReference,
  type OpenDialogAnswer,
  type OpenDialogRequest
} from '../../src/main/dialog.ts'
import {
  MAX_DISPLAY_PATH_LENGTH,
  ReferenceRegistry,
  shortenPath
} from '../../src/main/reference-registry.ts'
import { BuilderReferenceSchema } from '../../src/shared/schemas.ts'
import { createTempDir } from '../helpers/tmp-workspace.ts'

const FIXTURE_IMAGES_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

const STYLE_IMAGE = join(FIXTURE_IMAGES_DIR, 'style-2x3.png')
const IDENTITY_IMAGE = join(FIXTURE_IMAGES_DIR, 'identity-4x2.jpg')
const NOT_AN_IMAGE = join(FIXTURE_IMAGES_DIR, 'text-pretending-to-be.png')

const THUMBNAIL = `data:image/png;base64,${Buffer.from('thumb').toString('base64')}`

/** A registry with a predictable renderer, so the tests assert on real values. */
function registry(renderThumbnail: () => Promise<string | null> = async () => THUMBNAIL) {
  return new ReferenceRegistry({ renderThumbnail })
}

let temp: { path: string; remove(): Promise<void> }

beforeEach(async () => {
  temp = await createTempDir()
})

afterEach(async () => {
  await temp.remove()
})

describe('register and resolve', () => {
  it('mints a uuid and maps it back to the path', () => {
    const store = registry()
    const id = store.register(STYLE_IMAGE)

    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(BuilderReferenceSchema.shape.referenceId.safeParse(id).success).toBe(true)
    expect(store.resolve(id)).toBe(STYLE_IMAGE)
  })

  it('returns undefined for an id it never issued', () => {
    expect(registry().resolve('11111111-1111-4111-8111-111111111111')).toBeUndefined()
    expect(registry().resolve('not-a-uuid')).toBeUndefined()
  })

  // Plan Task 2.3: registerMany keeps the id a path already has.
  it('keeps the same id for the same path', () => {
    const store = registry()
    const first = store.register(STYLE_IMAGE)

    expect(store.register(STYLE_IMAGE)).toBe(first)
    expect(store.registerMany([STYLE_IMAGE, IDENTITY_IMAGE])[0]).toBe(first)
    expect(store.size).toBe(2)
  })

  it('registers several paths in order', () => {
    const store = registry()
    const [styleId, identityId] = store.registerMany([STYLE_IMAGE, IDENTITY_IMAGE])

    expect(store.resolve(styleId ?? '')).toBe(STYLE_IMAGE)
    expect(store.resolve(identityId ?? '')).toBe(IDENTITY_IMAGE)
  })

  // Plan decision Q3: draft.load gives a saved draft back the ids it was saved with.
  it('binds an id a draft carried', () => {
    const store = registry()
    const savedId = '11111111-1111-4111-8111-111111111111'

    expect(store.register(STYLE_IMAGE, { referenceId: savedId })).toBe(savedId)
    expect(store.resolve(savedId)).toBe(STYLE_IMAGE)
    expect(store.register(STYLE_IMAGE)).toBe(savedId)
  })

  it('remembers a thumbnail handed to it, so a reloaded draft keeps its preview', () => {
    const store = registry()
    const id = store.register(STYLE_IMAGE, { thumbnail: THUMBNAIL })

    expect(store.describe(id)?.thumbnail).toBe(THUMBNAIL)
    expect(store.register(STYLE_IMAGE)).toBe(id)
    expect(store.describe(id)?.thumbnail).toBe(THUMBNAIL)
  })

  it('forgets an id and mints a new one afterwards', () => {
    const store = registry()
    const id = store.register(STYLE_IMAGE)

    store.forget(id)

    expect(store.resolve(id)).toBeUndefined()
    expect(store.size).toBe(0)
    expect(store.register(STYLE_IMAGE)).not.toBe(id)
  })

  it('ignores forgetting an unknown id and clears everything on demand', () => {
    const store = registry()

    store.forget('11111111-1111-4111-8111-111111111111')
    store.registerMany([STYLE_IMAGE, IDENTITY_IMAGE])
    store.clear()

    expect(store.size).toBe(0)
  })
})

describe('createReference', () => {
  it('returns a handle with the measurements and no path field', async () => {
    const store = registry()
    const reference = await store.createReference(STYLE_IMAGE, { role: 'style' })

    expect(BuilderReferenceSchema.safeParse(reference).success).toBe(true)
    expect(reference).toMatchObject({
      role: 'style',
      originalName: 'style-2x3.png',
      mimeType: 'image/png',
      width: 2,
      height: 3,
      missing: false,
      thumbnail: THUMBNAIL
    })
    expect(Object.keys(reference)).not.toContain('path')
    expect(store.resolve(reference.referenceId)).toBe(STYLE_IMAGE)
  })

  // Spec section 11: the handle is the only thing the renderer sees.
  it('describes a shape that has no path field at all', () => {
    expect(Object.keys(BuilderReferenceSchema.shape)).not.toContain('path')
    expect(Object.keys(BuilderReferenceSchema.shape)).toContain('displayPath')
  })

  it('shows a shortened source path rather than the real one', async () => {
    const store = new ReferenceRegistry({ shortenDisplayPath: () => '~/refs/style-2x3.png' })
    const reference = await store.createReference(STYLE_IMAGE, { role: 'style' })

    expect(reference.displayPath).toBe('~/refs/style-2x3.png')
    expect(reference.displayPath).not.toBe(STYLE_IMAGE)
  })

  it('takes the original name from the caller for a stored library image', async () => {
    const stored = join(temp.path, 'style.png')

    await copyFile(STYLE_IMAGE, stored)

    const reference = await registry().createReference(stored, {
      role: 'style',
      originalName: 'master-style.png',
      note: 'Rough black outline'
    })

    expect(reference.originalName).toBe('master-style.png')
    expect(reference.note).toBe('Rough black outline')
  })

  it('reuses the id of the reference a job input came from', async () => {
    const store = registry()
    const savedId = '22222222-2222-4222-8222-222222222222'
    const reference = await store.createReference(IDENTITY_IMAGE, {
      role: 'identity',
      referenceId: savedId
    })

    expect(reference.referenceId).toBe(savedId)
  })

  it('leaves the thumbnail out when none can be rendered', async () => {
    const reference = await registry(async () => null).createReference(STYLE_IMAGE, {
      role: 'style'
    })

    expect(reference.thumbnail).toBeUndefined()
    expect(BuilderReferenceSchema.safeParse(reference).success).toBe(true)
  })

  it('survives a thumbnail renderer that throws', async () => {
    const reference = await registry(async () => {
      throw new Error('nativeImage exploded')
    }).createReference(STYLE_IMAGE, { role: 'style' })

    expect(reference.thumbnail).toBeUndefined()
    expect(reference.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses a file that is not a supported image and registers nothing', async () => {
    const store = registry()

    await expect(store.createReference(NOT_AN_IMAGE, { role: 'extra' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT'
    })
    expect(store.size).toBe(0)
  })

  it('passes the size limit through to the inspector', async () => {
    await expect(
      registry().createReference(STYLE_IMAGE, { role: 'style', maxBytes: 10 })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })
})

describe('shortenPath', () => {
  it('replaces the home directory with a tilde', () => {
    expect(shortenPath('C:\\Users\\kay\\refs\\a.png', 'C:\\Users\\kay')).toBe('~\\refs\\a.png')
  })

  it('leaves a short path alone', () => {
    expect(shortenPath('C:\\refs\\a.png', 'C:\\Users\\kay')).toBe('C:\\refs\\a.png')
  })

  it('elides the middle of a long path and keeps the file name', () => {
    const long = `C:\\Users\\kay\\${'deeply\\nested\\'.repeat(6)}master-style.png`
    const short = shortenPath(long, 'C:\\Users\\kay')

    expect(short.length).toBeLessThan(long.length)
    expect(short).toContain('…')
    expect(short).toContain('master-style.png')
  })

  it('never returns an empty string, so the schema minimum holds', () => {
    expect(shortenPath('C:\\a.png', '').length).toBeGreaterThan(0)
    expect(MAX_DISPLAY_PATH_LENGTH).toBeGreaterThan(16)
  })
})

describe('selectReference', () => {
  function picker(answer: OpenDialogAnswer) {
    return vi.fn<(request: OpenDialogRequest) => Promise<OpenDialogAnswer>>(async () => answer)
  }

  it('offers only PNG, JPEG and WebP, single select (spec section 4.2)', async () => {
    const showOpenDialog = picker({ canceled: false, filePaths: [STYLE_IMAGE] })

    await selectReference('style', { registry: registry(), showOpenDialog })

    expect(showOpenDialog).toHaveBeenCalledWith({
      title: REFERENCE_DIALOG_TEXT.title,
      buttonLabel: REFERENCE_DIALOG_TEXT.buttonLabel,
      properties: ['openFile'],
      filters: [{ name: REFERENCE_DIALOG_TEXT.filterName, extensions: IMAGE_FILE_EXTENSIONS }]
    })
    expect([...IMAGE_FILE_EXTENSIONS]).toEqual(['png', 'jpg', 'jpeg', 'webp'])
  })

  it('returns the handle for the chosen file and registers it', async () => {
    const store = registry()
    const reference = await selectReference('identity', {
      registry: store,
      showOpenDialog: picker({ canceled: false, filePaths: [IDENTITY_IMAGE] })
    })

    expect(reference).toMatchObject({ role: 'identity', mimeType: 'image/jpeg', width: 4 })
    expect(store.resolve(reference?.referenceId ?? '')).toBe(IDENTITY_IMAGE)
  })

  it('returns null when the user cancels', async () => {
    const store = registry()

    await expect(
      selectReference('style', {
        registry: store,
        showOpenDialog: picker({ canceled: true, filePaths: [] })
      })
    ).resolves.toBeNull()
    expect(store.size).toBe(0)
  })

  it('returns null when the dialog answers with no file', async () => {
    await expect(
      selectReference('style', {
        registry: registry(),
        showOpenDialog: picker({ canceled: false, filePaths: [] })
      })
    ).resolves.toBeNull()
  })

  it('lets the image inspector refuse an unsupported file', async () => {
    await expect(
      selectReference('extra', {
        registry: registry(),
        showOpenDialog: picker({ canceled: false, filePaths: [NOT_AN_IMAGE] })
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })

  it('shows Vietnamese dialog strings (plan decision Q10)', () => {
    expect(REFERENCE_DIALOG_TEXT.title).toBe('Chọn ảnh tham chiếu')
  })
})
