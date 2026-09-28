/**
 * The prompt builder (spec section 4.3, plan Task 1.4).
 *
 * The UI builder is the source of truth for the prompt, so exactly one module
 * assembles it: the renderer preview and the job materializer call the same
 * function and therefore produce the same bytes and the same checksum
 * (spec sections 4.3, 5.2 and 10).
 *
 * Pure TypeScript with no Electron and no Node built-ins. `sha256Hex` uses Web
 * Crypto rather than `node:crypto` for the same reason, which makes it async.
 */
import {
  assignReferenceLabels,
  type HasReferenceRole,
  type LabelledReference,
  type ReferenceLabel,
  type ReferenceRole
} from './reference-roles.ts'
import type { BuilderState } from './schemas.ts'

/**
 * What the prompt needs from a reference, shared by the renderer's
 * `BuilderReference` and the packet's `JobReference`: which role it fills, the
 * file name the user recognises, and the note for that role.
 */
export interface PromptReference extends HasReferenceRole {
  readonly role: ReferenceRole
  readonly originalName: string
  readonly note?: string
}

/**
 * A reference carrying the label the model sees. The labels are handed out
 * sequentially over the references that are present, after sorting by role
 * (plan decision Q14), so they line up with the `-i` attachment order of spec
 * section 5.3.
 */
export type OrderedReference = LabelledReference<PromptReference>

/** One row of the mapping table shown next to the prompt (spec section 4.3). */
export interface MappingRow {
  readonly label: ReferenceLabel
  readonly role: ReferenceRole
  readonly originalName: string
  readonly note?: string
}

export interface BuildPromptOptions {
  /**
   * Negative constraints coming from the applied preset. They are merged with
   * the ones the user typed and de-duplicated (spec section 4.4, plan Task
   * 1.4); the preset's come first because preset defaults sort before user
   * values in the merge order of spec section 4.4.
   */
  readonly presetNegativeConstraints?: readonly string[]
}

export interface BuiltPrompt {
  /** The exact contents of `prompt.md`. */
  readonly markdown: string
  /** The same references as rows for the UI mapping table. */
  readonly mapping: MappingRow[]
  /**
   * The negative constraints exactly as the prompt lists them: the preset's and
   * the user's, merged and de-duplicated.
   *
   * `job.json` stores this list (spec section 6.2), and it comes from here so
   * the packet and the text of `prompt.md` cannot disagree.
   */
  readonly negativeConstraints: string[]
}

/** Thrown when the references handed to {@link buildPrompt} are not ordered. */
export class ReferenceOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReferenceOrderError'
  }
}

/** The seven prompt sections, in the fixed order of spec section 4.3. */
export const PROMPT_SECTION_TITLES = [
  'Image goal',
  'Reference map',
  'Subject',
  'Pose, expression and composition',
  'Output constraints',
  'Conflict policy',
  'Negative constraints'
] as const

export type PromptSectionTitle = (typeof PROMPT_SECTION_TITLES)[number]

/** The default conflict policy of spec section 4.3. Always part of the prompt. */
export const DEFAULT_CONFLICT_POLICY = [
  'The identity reference decides facial features.',
  'The style reference decides how the image is rendered.',
  'The outfit reference decides clothing.',
  'The equipment reference decides objects.',
  "The user's latest and most explicit direction has the highest priority."
] as const

/** Stands in for a field the user has not filled in yet. */
export const UNSPECIFIED = '(not specified)'

/** Stands in for the subject name while the builder is still empty. */
export const UNNAMED_SUBJECT = 'the subject'

const HEADING_PREFIX = '## '

/**
 * Sorts by role and hands out labels, the one place labels are derived
 * (plan decision Q14). Callers pass the result to {@link buildPrompt}.
 */
export function orderReferences(references: readonly PromptReference[]): OrderedReference[] {
  return assignReferenceLabels(references)
}

/**
 * Concatenates lists of short phrases, keeping the first occurrence of each one
 * and dropping blanks.
 *
 * Two entries are the same when they only differ in surrounding space, inner
 * runs of space or letter case; the text kept is the first spelling seen.
 * `src/shared/preset-merge.ts` reuses this so that applying the same preset
 * twice does not stack up duplicates.
 */
export function mergeUniqueText(...lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const list of lists) {
    for (const entry of list) {
      const text = entry.trim()
      const key = normalizeForComparison(text)

      if (text === '' || seen.has(key)) {
        continue
      }

      seen.add(key)
      merged.push(text)
    }
  }

  return merged
}

/** The comparison key of {@link mergeUniqueText}: case and spacing folded. */
export function normalizeForComparison(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Merges lists of negative constraints from the preset and from the user,
 * dropping repeats (spec section 4.3, plan Task 1.4).
 */
export function mergeNegativeConstraints(...lists: readonly (readonly string[])[]): string[] {
  return mergeUniqueText(...lists)
}

/**
 * Builds `prompt.md` and the mapping table beside it.
 *
 * `references` must already be ordered and labelled by {@link orderReferences};
 * the labels in the prompt have to match `job.json` and the `-i` attachment
 * order (spec sections 5.3 and 6.2), so a mismatch is an error rather than
 * something this function quietly fixes.
 *
 * The output depends only on the arguments: the same state and references
 * always produce the same markdown, and therefore the same checksum.
 */
export function buildPrompt(
  state: BuilderState,
  references: readonly OrderedReference[],
  options: BuildPromptOptions = {}
): BuiltPrompt {
  assertOrdered(references)

  const negativeConstraints = mergeNegativeConstraints(
    options.presetNegativeConstraints ?? [],
    state.negativeConstraints
  )

  const sections = [
    imageGoalSection(state),
    referenceMapSection(references),
    subjectSection(state),
    compositionSection(state),
    outputSection(state),
    conflictPolicySection(),
    negativeConstraintsSection(negativeConstraints)
  ]

  const markdown = `${sections.map((body, index) => `${HEADING_PREFIX}${PROMPT_SECTION_TITLES[index] ?? ''}\n\n${body}`).join('\n\n')}\n`

  return { markdown, mapping: references.map(toMappingRow), negativeConstraints }
}

/**
 * SHA-256 of `text` as 64 lowercase hex characters, the form `promptSha256`
 * takes in `job.json` (spec section 6.2).
 *
 * Web Crypto rather than `node:crypto`, because this module also runs in the
 * renderer (spec section 4.3), which is why it is asynchronous.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle

  if (subtle === undefined) {
    throw new Error(
      'Web Crypto is unavailable: globalThis.crypto.subtle is required for sha256Hex.'
    )
  }

  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function imageGoalSection(state: BuilderState): string {
  const name = blankToNull(state.subject.name) ?? UNNAMED_SUBJECT
  const count = state.output.count
  const noun = count === 1 ? 'image' : 'images'

  return [
    `Generate ${String(count)} ${noun} of ${name}.`,
    'The attached reference images are the visual source of truth.',
    "Do not reinterpret or expand the user's creative direction."
  ].join('\n')
}

function referenceMapSection(references: readonly OrderedReference[]): string {
  if (references.length === 0) {
    return 'No reference images are attached.'
  }

  const lines = ['The images attached to this job are listed below in attachment order.', '']

  for (const reference of references) {
    lines.push(`- ${reference.label} → ${reference.role} → ${reference.originalName}`)

    const note = blankToNull(reference.note ?? '')

    if (note !== null) {
      lines.push(`  - Note: ${note}`)
    }
  }

  return lines.join('\n')
}

function subjectSection(state: BuilderState): string {
  return [
    `- Name: ${blankToNull(state.subject.name) ?? UNSPECIFIED}`,
    `- Description: ${blankToNull(state.subject.description) ?? UNSPECIFIED}`
  ].join('\n')
}

function compositionSection(state: BuilderState): string {
  const lines: string[] = []
  const pose = blankToNull(state.subject.pose ?? '')
  const expression = blankToNull(state.subject.expression ?? '')
  const notes = blankToNull(state.subject.notes ?? '')

  if (pose !== null) {
    lines.push(`- Pose: ${pose}`)
  }

  if (expression !== null) {
    lines.push(`- Expression: ${expression}`)
  }

  if (notes !== null) {
    lines.push(`- Composition note: ${notes}`)
  }

  return lines.length === 0
    ? 'No pose, expression or composition direction was given.'
    : lines.join('\n')
}

function outputSection(state: BuilderState): string {
  return [
    `- Aspect ratio: ${blankToNull(state.output.aspectRatio) ?? UNSPECIFIED}`,
    `- Background: ${blankToNull(state.output.background) ?? UNSPECIFIED}`,
    `- File format: ${state.output.format}`,
    `- Number of images: ${String(state.output.count)}`
  ].join('\n')
}

function conflictPolicySection(): string {
  return DEFAULT_CONFLICT_POLICY.map((rule) => `- ${rule}`).join('\n')
}

function negativeConstraintsSection(constraints: readonly string[]): string {
  if (constraints.length === 0) {
    return 'None.'
  }

  return constraints.map((constraint) => `- ${constraint}`).join('\n')
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMappingRow(reference: OrderedReference): MappingRow {
  const note = blankToNull(reference.note ?? '')

  return {
    label: reference.label,
    role: reference.role,
    originalName: reference.originalName,
    ...(note === null ? {} : { note })
  }
}

/** Trimmed text, or `null` when there is nothing but space. */
function blankToNull(value: string): string | null {
  const trimmed = value.trim()

  return trimmed === '' ? null : trimmed
}

/**
 * Checks that the references are sorted by role and labelled sequentially,
 * which is what {@link orderReferences} produces. Duplicate roles and
 * over-long lists are rejected by `assignReferenceLabels`.
 */
function assertOrdered(references: readonly OrderedReference[]): void {
  const expected = assignReferenceLabels(references)

  for (const [index, reference] of expected.entries()) {
    const given = references[index]

    if (given === undefined || given.role !== reference.role || given.label !== reference.label) {
      throw new ReferenceOrderError(
        'References must be sorted by role and labelled by orderReferences() before building a prompt.'
      )
    }
  }
}
