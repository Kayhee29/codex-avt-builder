import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_IMAGE_BYTES,
  detectImageMimeType,
  imageExtension,
  ImageInspectError,
  inspectImage
} from '../../src/main/image-inspect.ts'
import { createTempDir, linkFile } from '../helpers/tmp-workspace.ts'

/** `tests/fixtures/images`, described by the README next to the files. */
export const FIXTURE_IMAGES_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

const FIXTURES = [
  { file: 'style-2x3.png', mimeType: 'image/png', width: 2, height: 3 },
  { file: 'identity-4x2.jpg', mimeType: 'image/jpeg', width: 4, height: 2 },
  { file: 'outfit-6x5.webp', mimeType: 'image/webp', width: 6, height: 5 }
] as const

function fixture(name: string): string {
  return join(FIXTURE_IMAGES_DIR, name)
}

let temp: { path: string; remove(): Promise<void> }

beforeEach(async () => {
  temp = await createTempDir()
})

afterEach(async () => {
  await temp.remove()
})

describe('detectImageMimeType', () => {
  it.each(FIXTURES)('recognises $file by its first bytes', async ({ file, mimeType }) => {
    expect(detectImageMimeType(await readFile(fixture(file)))).toBe(mimeType)
  })

  it('does not go by the file name', async () => {
    expect(detectImageMimeType(await readFile(fixture('text-pretending-to-be.png')))).toBeNull()
  })

  it('refuses a RIFF container that is not WebP', () => {
    const riff = Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'ascii')

    expect(detectImageMimeType(riff)).toBeNull()
  })

  it('refuses a truncated header rather than reading past the end', () => {
    expect(detectImageMimeType(new Uint8Array([0x89, 0x50]))).toBeNull()
    expect(detectImageMimeType(new Uint8Array())).toBeNull()
  })
})

describe('imageExtension', () => {
  it('maps each MIME type to the extension a copy gets (spec section 5.2)', () => {
    expect(imageExtension('image/png')).toBe('png')
    expect(imageExtension('image/jpeg')).toBe('jpg')
    expect(imageExtension('image/webp')).toBe('webp')
  })
})

describe('inspectImage', () => {
  it.each(FIXTURES)(
    'measures $file as $width by $height',
    async ({ file, mimeType, width, height }) => {
      const path = fixture(file)
      const inspected = await inspectImage(path)
      const bytes = await readFile(path)

      expect(inspected).toEqual({
        mimeType,
        width,
        height,
        sizeBytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    }
  )

  it('returns a sha256 of 64 lowercase hex characters', async () => {
    const { sha256 } = await inspectImage(fixture('style-2x3.png'))

    expect(sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports the same hash for a copy and a different one after an edit', async () => {
    const copy = join(temp.path, 'copy.png')

    await copyFile(fixture('style-2x3.png'), copy)

    const original = await inspectImage(fixture('style-2x3.png'))

    expect((await inspectImage(copy)).sha256).toBe(original.sha256)

    await writeFile(copy, await readFile(fixture('identity-4x2.jpg')))

    expect((await inspectImage(copy)).sha256).not.toBe(original.sha256)
  })

  // Spec section 6.2: the MIME type comes from the magic bytes, not the name.
  it('refuses a .png file whose bytes are text', async () => {
    await expect(inspectImage(fixture('text-pretending-to-be.png'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT'
    })
  })

  it('accepts JPEG bytes stored under a .png name and reports image/jpeg', async () => {
    const misnamed = join(temp.path, 'identity.png')

    await copyFile(fixture('identity-4x2.jpg'), misnamed)

    const inspected = await inspectImage(misnamed)

    expect(inspected.mimeType).toBe('image/jpeg')
    expect(imageExtension(inspected.mimeType)).toBe('jpg')
  })

  it('refuses a file whose header is cut off', async () => {
    const truncated = join(temp.path, 'truncated.png')
    const bytes = await readFile(fixture('style-2x3.png'))

    await writeFile(truncated, bytes.subarray(0, 12))

    await expect(inspectImage(truncated)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' })
  })

  it('refuses a file over the limit before reading it', async () => {
    const big = join(temp.path, 'big.png')

    await copyFile(fixture('style-2x3.png'), big)

    await expect(inspectImage(big, { maxBytes: 10 })).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })

  it('accepts a file exactly at the limit', async () => {
    const path = fixture('style-2x3.png')
    const { byteLength } = await readFile(path)

    await expect(inspectImage(path, { maxBytes: byteLength })).resolves.toMatchObject({
      sizeBytes: byteLength
    })
  })

  it('defaults to the 20 MB limit of spec section 4.2', () => {
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  })

  it('refuses a directory', async () => {
    const directory = join(temp.path, 'a-directory.png')

    await mkdir(directory)

    await expect(inspectImage(directory)).rejects.toMatchObject({ code: 'NOT_A_FILE' })
  })

  it('refuses a file that is not there', async () => {
    await expect(inspectImage(join(temp.path, 'gone.png'))).rejects.toMatchObject({
      code: 'NOT_A_FILE'
    })
  })

  // Spec section 11: symlinks are not accepted as job inputs or outputs.
  it('refuses a symlink even when it points at a real image', async (context) => {
    const linkPath = join(temp.path, 'link.png')
    const kind = await linkFile(fixture('style-2x3.png'), linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating file symlinks without elevation')

      return
    }

    await expect(inspectImage(linkPath)).rejects.toMatchObject({ code: 'IS_SYMLINK' })
  })

  it('throws ImageInspectError carrying the path, and keeps it out of the message', async () => {
    const missing = join(temp.path, 'gone.png')
    const error = await inspectImage(missing).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ImageInspectError)
    expect((error as ImageInspectError).path).toBe(missing)
    expect((error as ImageInspectError).message).not.toContain(temp.path)
  })
})
