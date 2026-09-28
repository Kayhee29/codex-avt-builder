/**
 * Reference roles, their fixed order and the Image A…E labels.
 *
 * Spec sections 4.2 (five independent slots), 4.3 (prompt reference map),
 * 5.3 (`-i` attachment order) and 6.2 (`references` in job.json).
 *
 * Pure TypeScript with no Electron and no Node built-ins, so the renderer
 * preview and the main process materializer share one implementation
 * (spec section 4.3).
 */

/**
 * The five reference slots in the single fixed order used by prompt.md, by
 * `references` in job.json and by the repeated `-i` arguments handed to
 * `codex exec`.
 */
export const REFERENCE_ROLES = ['style', 'identity', 'outfit', 'equipment', 'extra'] as const

export type ReferenceRole = (typeof REFERENCE_ROLES)[number]

/** The labels the model sees, one per attached reference (spec section 4.3). */
export const REFERENCE_LABELS = ['Image A', 'Image B', 'Image C', 'Image D', 'Image E'] as const

export type ReferenceLabel = (typeof REFERENCE_LABELS)[number]

/** Each role holds at most one active reference (spec section 4.2). */
export const MAX_REFERENCES = REFERENCE_ROLES.length

/** Minimal shape shared by builder references and job packet references. */
export interface HasReferenceRole {
  readonly role: ReferenceRole
}

/** A reference carrying the label it was given by {@link assignReferenceLabels}. */
export type LabelledReference<T extends HasReferenceRole> = T & { label: ReferenceLabel }

/** Thrown when a reference list carries the same role twice (spec section 4.2). */
export class DuplicateReferenceRoleError extends Error {
  readonly role: ReferenceRole

  constructor(role: ReferenceRole) {
    super(`Duplicate reference role "${role}": each role holds at most one reference.`)
    this.name = 'DuplicateReferenceRoleError'
    this.role = role
  }
}

/** Thrown when more references are supplied than there are roles or labels. */
export class TooManyReferencesError extends Error {
  readonly count: number

  constructor(count: number) {
    super(`Got ${count} references but only ${MAX_REFERENCES} roles exist.`)
    this.name = 'TooManyReferencesError'
    this.count = count
  }
}

export function isReferenceRole(value: unknown): value is ReferenceRole {
  return typeof value === 'string' && (REFERENCE_ROLES as readonly string[]).includes(value)
}

/** Position of `role` in the fixed order. Lower values sort first. */
export function roleOrder(role: ReferenceRole): number {
  return REFERENCE_ROLES.indexOf(role)
}

/**
 * The label at `index` of the attachment order: 0 is "Image A", 4 is "Image E".
 * The index is a position in the attachment list, never a role position.
 */
export function labelFor(index: number): ReferenceLabel {
  const label = REFERENCE_LABELS[index]

  if (label === undefined) {
    throw new RangeError(
      `No reference label for index ${index}; expected 0 to ${REFERENCE_LABELS.length - 1}.`
    )
  }

  return label
}

/**
 * Sort references into the fixed role order.
 *
 * Throws {@link DuplicateReferenceRoleError} if a role appears twice. The input
 * array is not mutated and the returned array is a copy.
 */
export function sortReferences<T extends HasReferenceRole>(references: readonly T[]): T[] {
  const seen = new Set<ReferenceRole>()

  for (const reference of references) {
    if (seen.has(reference.role)) {
      throw new DuplicateReferenceRoleError(reference.role)
    }

    seen.add(reference.role)
  }

  return [...references].sort((left, right) => roleOrder(left.role) - roleOrder(right.role))
}

/**
 * Sort by role, then hand out labels **sequentially over the references that
 * are actually present** (plan decision Q14).
 *
 * The labels in prompt.md have to line up with the order in which the main
 * process attaches the images with `-i` (spec section 5.3). That attachment
 * list only contains the references that exist, so an empty `style` slot makes
 * `identity` "Image A". Labels are not fixed per role.
 */
export function assignReferenceLabels<T extends HasReferenceRole>(
  references: readonly T[]
): LabelledReference<T>[] {
  if (references.length > MAX_REFERENCES) {
    throw new TooManyReferencesError(references.length)
  }

  return sortReferences(references).map((reference, index) => ({
    ...reference,
    label: labelFor(index)
  }))
}
