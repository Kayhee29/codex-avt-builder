/**
 * Job ID generation and validation (spec section 6.1).
 *
 * The job ID is the only user-derived value that ever reaches a command line
 * (spec sections 5.4 and 11) and it doubles as a directory name, so nothing
 * that fails {@link isValidJobId} may be used for either.
 *
 * Pure TypeScript with no Electron and no Node built-ins (spec section 4.3).
 */
import { JOB_ID_REGEX } from './schemas.ts'

/**
 * The single job ID pattern, shared with the zod schemas.
 *
 * It lives in `./schemas.ts` because the schemas there need it, and is
 * re-exported here so callers reach for it next to the functions that build
 * and check job IDs.
 *
 * Spec section 6.1 prints the slug part as `[a-z0-9]{1,24}`, which cannot
 * match the spec's own example `2026-09-28-richard-nixon-001`. The pattern
 * follows the prose of that same section instead: 1 to 24 characters of
 * lowercase alphanumerics and hyphens, never starting or ending with a hyphen.
 */
export { JOB_ID_REGEX }

/** Spec section 6.1: the slug is cut to at most 24 characters. */
export const MAX_JOB_SLUG_LENGTH = 24

/** Spec section 6.1: an empty slug becomes `job`. */
export const FALLBACK_JOB_SLUG = 'job'

/** The sequence is three digits and increases within a day (spec section 6.1). */
export const MIN_JOB_SEQUENCE = 1
export const MAX_JOB_SEQUENCE = 999

/** Combining accents left over after NFD normalisation. */
const COMBINING_MARKS = /[̀-ͯ]/g

/** NFD does not decompose the Vietnamese letter đ, so it is folded by hand. */
const VIETNAMESE_D = /[đĐ]/g

const NON_SLUG_CHARACTERS = /[^a-z0-9]+/g
const REPEATED_HYPHENS = /-{2,}/g
const EDGE_HYPHENS = /^-+|-+$/g

export interface SlugifyOptions {
  /** Used when nothing survives the fold. Defaults to {@link FALLBACK_JOB_SLUG}. */
  readonly fallback?: string
  /** Defaults to {@link MAX_JOB_SLUG_LENGTH}. */
  readonly maxLength?: number
}

/**
 * Turns a subject name into the slug part of a job ID (spec section 6.1):
 * strip Vietnamese accents, fold to lowercase ASCII, replace anything that is
 * not a letter or a digit with a hyphen, collapse runs of hyphens, trim the
 * ends, cut to 24 characters, and fall back to `job` when nothing is left.
 *
 * Preset and anchor identifiers are the same kind of slug over a longer budget
 * (`LIBRARY_ID_REGEX` in `./schemas.ts`), so `src/main/library.ts` calls this
 * with its own fallback and length rather than repeating the accent folding.
 */
export function slugifySubject(name: string, options: SlugifyOptions = {}): string {
  const fallback = options.fallback ?? FALLBACK_JOB_SLUG
  const maxLength = options.maxLength ?? MAX_JOB_SLUG_LENGTH

  const ascii = name
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(VIETNAMESE_D, 'd')
    .toLowerCase()

  const slug = ascii
    .replace(NON_SLUG_CHARACTERS, '-')
    .replace(REPEATED_HYPHENS, '-')
    .replace(EDGE_HYPHENS, '')
    .slice(0, maxLength)
    .replace(EDGE_HYPHENS, '')

  return slug === '' ? fallback : slug
}

/** `YYYY-MM-DD` in machine local time, as spec section 6.1 requires. */
function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

/**
 * Builds `<YYYY-MM-DD>-<slug>-<NNN>`.
 *
 * `subject` is slugified again on the way in, which is a no-op for an already
 * valid slug, so a caller can never smuggle an unslugified name through. The
 * result is checked against {@link JOB_ID_REGEX} before it is returned, so
 * this function either yields a valid job ID or throws.
 */
export function buildJobId(date: Date, subject: string, sequence: number): string {
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('Cannot build a job ID from an invalid Date.')
  }

  if (!Number.isInteger(sequence) || sequence < MIN_JOB_SEQUENCE || sequence > MAX_JOB_SEQUENCE) {
    throw new RangeError(
      `Job sequence must be an integer between ${MIN_JOB_SEQUENCE} and ${MAX_JOB_SEQUENCE}, got ${String(sequence)}.`
    )
  }

  const jobId = `${formatLocalDate(date)}-${slugifySubject(subject)}-${String(sequence).padStart(3, '0')}`

  if (!isValidJobId(jobId)) {
    throw new RangeError(`Built an invalid job ID: ${JSON.stringify(jobId)}.`)
  }

  return jobId
}

/**
 * The only gate before a job ID becomes a directory name or a command line
 * argument (spec sections 6.1 and 11).
 */
export function isValidJobId(value: unknown): value is string {
  return typeof value === 'string' && JOB_ID_REGEX.test(value)
}
