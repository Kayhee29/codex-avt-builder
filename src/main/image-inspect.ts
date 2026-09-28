/**
 * Image inspection by magic bytes (plan Task 2.2, decision Q11).
 *
 * Every image the app accepts passes through here: the file the user picks
 * (plan Task 2.3), the copy written into a job's `inputs/` (spec section 5.2)
 * and every generated file in `outputs/` (spec section 7.3). The values it
 * returns are the measured ones that go into `job.json` and `result.json`;
 * nothing is taken from a file extension or from what Codex claimed
 * (spec sections 6.2 and 7.2).
 *
 * Only PNG, JPEG and WebP are accepted (spec section 4.2). The format is
 * decided by the first bytes of the file, so a text file named `.png` is
 * refused. Dimensions come from the `image-size` package; the size and the
 * SHA-256 come from the bytes themselves.
 */
import { createHash } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'

import { imageSize } from 'image-size'

import type { ImageFormat, ImageMimeType } from '../shared/schemas.ts'

/** Spec section 4.2: 20 MB per file, configured in one place. */
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Why {@link inspectImage} refused a file. */
export type ImageInspectErrorCode = 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'NOT_A_FILE' | 'IS_SYMLINK'

/**
 * Thrown instead of returning half-measured metadata.
 *
 * `message` never contains the absolute path; the path rides along as a
 * property for the main-process log, because messages crossing to the renderer
 * are sanitized (spec section 11).
 */
export class ImageInspectError extends Error {
  readonly code: ImageInspectErrorCode
  readonly path: string

  constructor(code: ImageInspectErrorCode, path: string, message: string) {
    super(message)
    this.name = 'ImageInspectError'
    this.code = code
    this.path = path
  }
}

/** What an accepted image measures (spec sections 6.2 and 7.2). */
export interface InspectedImage {
  readonly mimeType: ImageMimeType
  readonly width: number
  readonly height: number
  readonly sizeBytes: number
  readonly sha256: string
}

export interface InspectImageOptions {
  /** Refuse anything larger. Defaults to {@link DEFAULT_MAX_IMAGE_BYTES}. */
  readonly maxBytes?: number
}

/** The three accepted formats, their magic bytes and their file extension. */
const SIGNATURES = [
  {
    mimeType: 'image/png',
    extension: 'png',
    /** `image-size` names the format this way. */
    sizeType: 'png',
    matches: (bytes: Uint8Array) =>
      startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  },
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    sizeType: 'jpg',
    matches: (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff])
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    sizeType: 'webp',
    // RIFF container whose form type is WEBP: "RIFF" ␣␣␣␣ "WEBP".
    matches: (bytes: Uint8Array) =>
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  }
] as const satisfies readonly {
  mimeType: ImageMimeType
  extension: ImageFormat
  sizeType: string
  matches: (bytes: Uint8Array) => boolean
}[]

/** The MIME type of `bytes`, or `null` when it is not one of the three formats. */
export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  return SIGNATURES.find((signature) => signature.matches(bytes))?.mimeType ?? null
}

/**
 * The extension a copy of this image gets: `inputs/<role>.<ext>` in a job
 * (spec section 5.2) and `style.<ext>` or `identity.<ext>` in the library
 * (plan decision Q4). It follows the measured MIME type, never the source file
 * name, so `photo.jpeg` and a `.png` holding JPEG bytes both land on `.jpg`.
 */
export function imageExtension(mimeType: ImageMimeType): ImageFormat {
  const signature = SIGNATURES.find((candidate) => candidate.mimeType === mimeType)

  if (signature === undefined) {
    throw new RangeError(`No file extension is defined for ${mimeType}.`)
  }

  return signature.extension
}

/**
 * Measures the image at `absPath`.
 *
 * Refused, in this order:
 *
 * - a symlink, with `IS_SYMLINK`. Spec section 11 does not accept symlinks as
 *   job inputs or outputs, and the check is `lstat` so the link itself is seen
 *   rather than what it points at;
 * - anything that is not a regular file, and a file that is not there at all,
 *   with `NOT_A_FILE`;
 * - a file over `maxBytes`, with `TOO_LARGE`, before the bytes are read;
 * - bytes that are not PNG, JPEG or WebP, or whose header carries no usable
 *   dimensions, with `UNSUPPORTED_FORMAT`.
 */
export async function inspectImage(
  absPath: string,
  options: InspectImageOptions = {}
): Promise<InspectedImage> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const stats = await statOrThrow(absPath)

  if (stats.isSymbolicLink()) {
    throw new ImageInspectError('IS_SYMLINK', absPath, 'A symlink cannot be used as an image.')
  }

  if (!stats.isFile()) {
    throw new ImageInspectError('NOT_A_FILE', absPath, 'This path is not a regular file.')
  }

  assertWithinLimit(stats.size, maxBytes, absPath)

  const bytes = await readFile(absPath)

  assertWithinLimit(bytes.byteLength, maxBytes, absPath)

  const mimeType = detectImageMimeType(bytes)

  if (mimeType === null) {
    throw new ImageInspectError(
      'UNSUPPORTED_FORMAT',
      absPath,
      'Only PNG, JPEG and WebP images are supported, and the file does not start like one.'
    )
  }

  const { width, height } = measure(bytes, mimeType, absPath)

  return {
    mimeType,
    width,
    height,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function statOrThrow(absPath: string): Promise<Stats> {
  try {
    return await lstat(absPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ImageInspectError('NOT_A_FILE', absPath, 'This file no longer exists.')
    }

    throw error
  }
}

function assertWithinLimit(sizeBytes: number, maxBytes: number, absPath: string): void {
  if (sizeBytes > maxBytes) {
    throw new ImageInspectError(
      'TOO_LARGE',
      absPath,
      `This image is ${formatMegabytes(sizeBytes)} MB and the limit is ${formatMegabytes(maxBytes)} MB.`
    )
  }
}

function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}

/**
 * Width and height from the image header.
 *
 * `image-size` decides the format again from the bytes, so a mismatch with the
 * magic bytes read here means the file is malformed rather than merely
 * unusual, and it is refused for the same reason an unknown format is.
 */
function measure(
  bytes: Uint8Array,
  mimeType: ImageMimeType,
  absPath: string
): { width: number; height: number } {
  const expected = SIGNATURES.find((signature) => signature.mimeType === mimeType)?.sizeType

  let width: number | undefined
  let height: number | undefined
  let type: string | undefined

  try {
    ;({ width, height, type } = imageSize(bytes))
  } catch {
    throw new ImageInspectError(
      'UNSUPPORTED_FORMAT',
      absPath,
      'The image header could not be read.'
    )
  }

  if (type !== expected) {
    throw new ImageInspectError(
      'UNSUPPORTED_FORMAT',
      absPath,
      'The image header does not match the format its first bytes announce.'
    )
  }

  if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
    throw new ImageInspectError(
      'UNSUPPORTED_FORMAT',
      absPath,
      'The image header carries no usable dimensions.'
    )
  }

  return { width, height }
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0
}

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) {
    return false
  }

  return magic.every((byte, index) => bytes[index] === byte)
}
