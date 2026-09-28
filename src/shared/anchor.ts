/**
 * Anchors: character continuity across jobs (spec section 4.5, plan Task 1.5).
 *
 * An anchor pins what must stay the same about a character — the identity
 * reference and the immutable traits — and nothing else. Outfit, equipment,
 * pose and expression stay mutable and are left empty for the user to fill in,
 * which spec sections 4.5 and 14.5 require. Updating an anchor adds a version
 * and never overwrites an existing one.
 *
 * Pure TypeScript with no Electron and no Node built-ins.
 */
import { applyPreset, NOTE_SEPARATOR, type ApplyPresetOptions } from './preset-merge.ts'
import { mergeUniqueText, normalizeForComparison } from './prompt-builder.ts'
import {
  SCHEMA_VERSION,
  type Anchor,
  type BuilderReference,
  type BuilderState,
  type OutputRequest,
  type Preset
} from './schemas.ts'

/**
 * What a brand new builder state asks for before a preset or the user says
 * otherwise. The spec fixes no default, so this is a neutral square PNG.
 */
export const DEFAULT_OUTPUT_REQUEST: OutputRequest = {
  aspectRatio: '1:1',
  background: '',
  format: 'png',
  count: 1
}

/** The first version number an anchor gets (spec section 4.5). */
export const FIRST_ANCHOR_VERSION = 1

export interface NewDraftOptions extends ApplyPresetOptions {
  /**
   * The handle the main process resolved for `anchor.identityReference`.
   *
   * The renderer only holds opaque handles (plan decision Q3), so the identity
   * image has to be supplied by the caller. Without it the new state carries
   * the anchor's direction but an empty identity slot.
   */
  readonly identityReference?: BuilderReference | null
}

/**
 * An empty builder state: nothing entered, no references, no preset and no
 * anchor. It is deliberately not valid against `BuilderStateSchema` yet, since
 * the subject name and description are still empty; the builder store reports
 * that as `invalid` (spec section 12).
 */
export function createEmptyBuilderState(): BuilderState {
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: { name: '', description: '' },
    references: [],
    output: { ...DEFAULT_OUTPUT_REQUEST },
    negativeConstraints: [],
    source: { preset: null, anchor: null }
  }
}

/**
 * The version number the next save of this anchor gets (spec section 4.5).
 *
 * `existing` is every stored version of one anchor. Saving never overwrites, so
 * this is always one past the highest version on disk, even if a version in the
 * middle was deleted by hand.
 */
export function nextAnchorVersion(existing: readonly Anchor[]): number {
  const ids = new Set(existing.map((anchor) => anchor.id))

  if (ids.size > 1) {
    throw new RangeError(
      `nextAnchorVersion expects the versions of one anchor, got ${String(ids.size)} different ids.`
    )
  }

  return existing.reduce(
    (highest, anchor) => Math.max(highest, anchor.version + 1),
    FIRST_ANCHOR_VERSION
  )
}

/**
 * Builds a new builder state from an anchor, optionally on top of a preset.
 *
 * Merge order is the one in spec section 4.4: preset defaults, then anchor
 * defaults, then whatever the user types afterwards. The anchor contributes the
 * character name, the stable identity description, its immutable traits as the
 * note on the identity slot, and the identity image when the caller supplies a
 * handle for it.
 *
 * What the anchor deliberately does not set (spec sections 4.5 and 14.5):
 * pose, expression, the outfit slot and the equipment slot. Its
 * `mutableTraits` are informational for the UI, and its `approvedOutput` is a
 * stored image for comparison, not a builder reference — the five slots of spec
 * section 4.2 are the only references a job ever has.
 */
export function newDraftFromAnchor(
  preset: Preset | null,
  anchor: Anchor,
  options: NewDraftOptions = {}
): BuilderState {
  const identityReference = options.identityReference ?? null

  if (identityReference !== null && identityReference.role !== 'identity') {
    throw new RangeError(
      `newDraftFromAnchor was given a "${identityReference.role}" reference as the identity reference.`
    )
  }

  const empty = createEmptyBuilderState()
  const base =
    preset === null
      ? empty
      : applyPreset(empty, preset, {
          ...(options.styleReference === undefined
            ? {}
            : { styleReference: options.styleReference })
        })

  // Anchor defaults beat preset defaults (spec section 4.4): the anchor owns
  // identity, so its immutable traits replace the preset's default identity
  // note rather than being appended to it.
  const identityNote =
    anchor.immutableTraits.length > 0
      ? mergeUniqueText(anchor.immutableTraits).join(NOTE_SEPARATOR)
      : (preset?.roleNotes.identity ?? '').trim()

  const references =
    identityReference === null
      ? base.references
      : [
          ...base.references.filter((reference) => reference.role !== 'identity'),
          identityNote === '' ? identityReference : { ...identityReference, note: identityNote }
        ]

  return {
    ...base,
    subject: {
      ...base.subject,
      name: anchor.name,
      description: anchor.identityDescription
    },
    references,
    source: { ...base.source, anchor: anchor.id }
  }
}

/**
 * The immutable traits of `anchor` that the current state contradicts
 * (plan Task 1.5).
 *
 * A trait is reported when a negative constraint asks to leave it out: the
 * anchor says the trait is fixed, the draft says to remove it, and the user has
 * to decide. The comparison folds case, spacing and punctuation and matches
 * whole words, so "no wire-rimmed glasses" conflicts with the trait
 * "wire rimmed glasses" while "no hatred" does not conflict with "hat".
 *
 * This is a warning for the UI, never a reason to block a job: an anchor pins
 * identity, and the latest explicit user direction still has the highest
 * priority (spec section 4.3).
 */
export function anchorImmutableTraitsConflict(anchor: Anchor, state: BuilderState): string[] {
  const constraints = state.negativeConstraints.map((constraint) => pad(constraint))

  return anchor.immutableTraits.filter((trait) => {
    const needle = pad(trait)

    return needle !== '  ' && constraints.some((constraint) => constraint.includes(needle))
  })
}

/** Folds case, spacing and punctuation, then pads so matches end on a word. */
function pad(value: string): string {
  return ` ${normalizeForComparison(value.replace(/[^\p{L}\p{N}]+/gu, ' '))} `
}
