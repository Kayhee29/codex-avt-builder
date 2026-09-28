/**
 * Applying a preset to the state the user is editing (spec section 4.4, plan
 * Task 1.5 and decision Q5).
 *
 * Applying a preset is an explicit action: the UI first shows which fields
 * would change ({@link previewPresetApply}), the user confirms, and only then
 * is the preset applied ({@link applyPreset}). Later user edits win, because
 * they happen after the apply.
 *
 * The plan calls the value being edited a "draft". On disk a `Draft` wraps a
 * `BuilderState` together with `savedAt` and the reference paths the main
 * process owns (plan decision Q3); neither of those is affected by applying a
 * preset, so these pure functions take and return the `BuilderState` inside the
 * draft and the renderer never sees a path.
 *
 * Two things a preset never touches (spec section 4.4):
 *
 * - the identity reference, including its note: a preset stores no identity
 *   image, and the note on that slot is the user's own direction. Anchors, not
 *   presets, carry identity continuity (spec section 4.5).
 * - generated output: a preset stores none, and a builder state holds none —
 *   generated images live in the immutable job directory (spec sections 4.6
 *   and 6).
 *
 * Pure TypeScript with no Electron and no Node built-ins.
 */
import { mergeUniqueText } from './prompt-builder.ts'
import { type ReferenceRole } from './reference-roles.ts'
import type { BuilderReference, BuilderState, Preset } from './schemas.ts'

/**
 * Every field a preset may change, in the order the preview lists them.
 *
 * Nothing under `references.identity` appears here, and that is the point: see
 * the module comment.
 */
export const PRESET_FIELDS = [
  'output.aspectRatio',
  'output.background',
  'output.format',
  'subject.pose',
  'subject.expression',
  'subject.notes',
  'negativeConstraints',
  'references.style',
  'references.style.note',
  'references.outfit.note',
  'references.equipment.note',
  'references.extra.note',
  'source.preset'
] as const

export type PresetField = (typeof PRESET_FIELDS)[number]

/** Roles whose note a preset may set. `identity` is deliberately absent. */
export const PRESET_NOTE_ROLES = [
  'style',
  'outfit',
  'equipment',
  'extra'
] as const satisfies readonly ReferenceRole[]

/**
 * One row of the "these fields will change" dialog (spec section 4.4).
 * `from` and `to` are display strings; `null` means the field is empty.
 */
export interface FieldChange {
  readonly field: PresetField
  readonly from: string | null
  readonly to: string | null
}

export interface ApplyPresetOptions {
  /**
   * The handle the main process resolved for `preset.styleReference`.
   *
   * The renderer cannot turn the preset's stored image into a reference by
   * itself: it only ever holds opaque handles (plan decision Q3). Without a
   * handle the style slot is left alone, and the preview says the same, so the
   * two never disagree.
   */
  readonly styleReference?: BuilderReference | null
}

/** Separator used when preset phrases are merged into a single note. */
export const NOTE_SEPARATOR = '; '

/**
 * Lists the fields {@link applyPreset} would change, skipping fields that
 * already hold the same value (plan Task 1.5).
 *
 * It diffs the real result of `applyPreset`, so the dialog can never promise
 * something the apply does not do.
 */
export function previewPresetApply(
  state: BuilderState,
  preset: Preset,
  options: ApplyPresetOptions = {}
): FieldChange[] {
  const before = describePresetFields(state)
  const after = describePresetFields(applyPreset(state, preset, options))

  return PRESET_FIELDS.flatMap((field) =>
    before[field] === after[field] ? [] : [{ field, from: before[field], to: after[field] }]
  )
}

/**
 * Returns a new state with the preset applied. The input is not modified.
 *
 * A preset value overwrites the field it owns, which is why the UI shows the
 * diff first. A field the preset leaves empty is not cleared, negative
 * constraints are merged rather than replaced so nothing the user typed is
 * lost, and the identity reference is never touched.
 */
export function applyPreset(
  state: BuilderState,
  preset: Preset,
  options: ApplyPresetOptions = {}
): BuilderState {
  const styleReference = options.styleReference ?? null

  if (styleReference !== null && styleReference.role !== 'style') {
    throw new RangeError(
      `applyPreset was given a "${styleReference.role}" reference as the preset style reference.`
    )
  }

  const references = applyStyleReference(
    state.references,
    preset.styleReference === null ? null : styleReference
  ).map((reference) => applyRoleNote(reference, preset))

  return {
    ...state,
    subject: applySubject(state, preset),
    references,
    output: {
      ...state.output,
      aspectRatio: preset.output.aspectRatio,
      background: preset.output.background,
      format: preset.output.format
    },
    negativeConstraints: mergeUniqueText(state.negativeConstraints, preset.negativeConstraints),
    source: { ...state.source, preset: preset.id }
  }
}

/**
 * The display values of every field a preset owns, used to diff a state
 * against the same state with the preset applied.
 */
export function describePresetFields(state: BuilderState): Record<PresetField, string | null> {
  const byRole = new Map(state.references.map((reference) => [reference.role, reference]))

  return {
    'output.aspectRatio': blankToNull(state.output.aspectRatio),
    'output.background': blankToNull(state.output.background),
    'output.format': state.output.format,
    'subject.pose': blankToNull(state.subject.pose ?? ''),
    'subject.expression': blankToNull(state.subject.expression ?? ''),
    'subject.notes': blankToNull(state.subject.notes ?? ''),
    negativeConstraints:
      state.negativeConstraints.length === 0
        ? null
        : state.negativeConstraints.join(NOTE_SEPARATOR),
    'references.style': byRole.get('style')?.originalName ?? null,
    'references.style.note': blankToNull(byRole.get('style')?.note ?? ''),
    'references.outfit.note': blankToNull(byRole.get('outfit')?.note ?? ''),
    'references.equipment.note': blankToNull(byRole.get('equipment')?.note ?? ''),
    'references.extra.note': blankToNull(byRole.get('extra')?.note ?? ''),
    'source.preset': state.source.preset
  }
}

/**
 * Merges a composition note with the preset's prompt conventions.
 *
 * Spec section 4.4 gives a preset "prompt conventions" but the fixed prompt of
 * spec section 4.3 has no section of its own for them and `BuilderState` has no
 * field for them, so they are carried as extra clauses of the composition note,
 * which is where the prompt renders free direction. Merging de-duplicates, so
 * applying the same preset twice changes nothing the second time. A preset
 * without conventions leaves the note exactly as it was.
 */
export function mergeNote(
  note: string | undefined,
  conventions: readonly string[]
): string | undefined {
  if (conventions.length === 0) {
    return blankToNull(note ?? '') ?? undefined
  }

  const merged = mergeUniqueText((note ?? '').split(';'), conventions)

  return merged.length === 0 ? undefined : merged.join(NOTE_SEPARATOR)
}

/** Replaces the style slot, keeping every other slot exactly as it was. */
function applyStyleReference(
  references: readonly BuilderReference[],
  styleReference: BuilderReference | null
): BuilderReference[] {
  if (styleReference === null) {
    return [...references]
  }

  const others = references.filter((reference) => reference.role !== 'style')

  return [styleReference, ...others]
}

/** Sets the preset's default note on a slot, except on the identity slot. */
function applyRoleNote(reference: BuilderReference, preset: Preset): BuilderReference {
  if (!isPresetNoteRole(reference.role)) {
    return reference
  }

  const note = blankToNull(preset.roleNotes[reference.role] ?? '')

  return note === null ? reference : { ...reference, note }
}

function isPresetNoteRole(role: ReferenceRole): role is (typeof PRESET_NOTE_ROLES)[number] {
  return (PRESET_NOTE_ROLES as readonly ReferenceRole[]).includes(role)
}

/**
 * Composition defaults overwrite the fields they carry; a field the preset
 * leaves empty keeps whatever the user typed.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * property, so an absent value has to stay an absent key.
 */
function applySubject(state: BuilderState, preset: Preset): BuilderState['subject'] {
  const subject: BuilderState['subject'] = { ...state.subject }
  const pose = blankToNull(preset.composition.pose ?? state.subject.pose ?? '')
  const expression = blankToNull(preset.composition.expression ?? state.subject.expression ?? '')
  const notes = mergeNote(preset.composition.notes ?? state.subject.notes, preset.promptConventions)

  if (pose === null) {
    delete subject.pose
  } else {
    subject.pose = pose
  }

  if (expression === null) {
    delete subject.expression
  } else {
    subject.expression = expression
  }

  if (notes === undefined) {
    delete subject.notes
  } else {
    subject.notes = notes
  }

  return subject
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim()

  return trimmed === '' ? null : trimmed
}
