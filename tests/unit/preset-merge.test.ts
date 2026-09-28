import { describe, expect, it } from 'vitest'

import {
  applyPreset,
  describePresetFields,
  mergeNote,
  PRESET_FIELDS,
  PRESET_NOTE_ROLES,
  previewPresetApply,
  type FieldChange
} from '@shared/preset-merge'
import type { BuilderReference, BuilderState, Preset } from '@shared/schemas'

const SHA = '0123456789abcdef'.repeat(4)

function reference(role: BuilderReference['role'], overrides: Partial<BuilderReference> = {}) {
  return {
    referenceId: `00000000-0000-4000-8000-00000000000${PRESET_ROLE_DIGIT[role]}`,
    role,
    originalName: `${role}.png`,
    displayPath: `C:\\refs\\${role}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 512,
    height: 512,
    sha256: SHA,
    missing: false,
    ...overrides
  } satisfies BuilderReference
}

const PRESET_ROLE_DIGIT: Record<BuilderReference['role'], string> = {
  style: '1',
  identity: '2',
  outfit: '3',
  equipment: '4',
  extra: '5'
}

const PRESET: Preset = {
  schemaVersion: 1,
  id: 'chibi-master-v1',
  name: 'Chibi master',
  createdAt: '2026-09-28T09:00:00Z',
  updatedAt: '2026-09-28T09:00:00Z',
  styleReference: {
    path: 'style.png',
    originalName: 'master-style.png',
    mimeType: 'image/png',
    sizeBytes: 1834022,
    sha256: SHA
  },
  roleNotes: {
    style: 'Rough black outline, muted color',
    identity: 'Preserve facial structure',
    outfit: 'Keep the silhouette readable'
  },
  promptConventions: ['Name the camera angle first'],
  negativeConstraints: ['no text', 'no watermark'],
  composition: { pose: 'Full body, standing upright', notes: 'Clear silhouette' },
  output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png' }
}

/** A draft the user has already worked on (spec section 4.4). */
const POPULATED: BuilderState = {
  schemaVersion: 1,
  subject: {
    name: 'Richard Nixon',
    description: 'Chibi historical character portrait',
    pose: 'Seated at a desk',
    expression: 'Serious, no smile'
  },
  references: [
    reference('identity', { originalName: 'nixon-front.jpg', note: 'Keep the hairline' }),
    reference('outfit', { originalName: 'dark-suit.png' })
  ],
  output: { aspectRatio: '1:1', background: '', format: 'webp', count: 2 },
  negativeConstraints: ['no extra fingers'],
  source: { preset: null, anchor: 'nixon-v1' }
}

const PRESET_STYLE_HANDLE = reference('style', { originalName: 'master-style.png' })

function fields(changes: readonly FieldChange[]): string[] {
  return changes.map((change) => change.field)
}

describe('previewPresetApply', () => {
  it('lists exactly the fields that will change', () => {
    const changes = previewPresetApply(POPULATED, PRESET)

    expect(fields(changes)).toEqual([
      'output.aspectRatio',
      'output.background',
      'output.format',
      'subject.pose',
      'subject.notes',
      'negativeConstraints',
      'references.outfit.note',
      'source.preset'
    ])
  })

  it('reports the value before and after', () => {
    const changes = previewPresetApply(POPULATED, PRESET)
    const aspectRatio = changes.find((change) => change.field === 'output.aspectRatio')

    expect(aspectRatio).toEqual({ field: 'output.aspectRatio', from: '1:1', to: '3:4' })
    expect(changes.find((change) => change.field === 'output.background')).toEqual({
      field: 'output.background',
      from: null,
      to: 'pale warm paper'
    })
  })

  it('skips a field that already holds the preset value', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(previewPresetApply(applied, PRESET)).toEqual([])
  })

  it('never lists a field of the identity reference', () => {
    const changes = previewPresetApply(POPULATED, PRESET)

    for (const change of changes) {
      expect(change.field).not.toContain('identity')
    }

    expect(PRESET_FIELDS.filter((field) => field.includes('identity'))).toEqual([])
    expect(PRESET_NOTE_ROLES).not.toContain('identity')
  })

  it('lists the style reference only when the caller resolved a handle for it', () => {
    expect(fields(previewPresetApply(POPULATED, PRESET))).not.toContain('references.style')

    const withHandle = previewPresetApply(POPULATED, PRESET, {
      styleReference: PRESET_STYLE_HANDLE
    })

    expect(fields(withHandle)).toContain('references.style')
    expect(withHandle.find((change) => change.field === 'references.style')).toEqual({
      field: 'references.style',
      from: null,
      to: 'master-style.png'
    })
  })

  it('does not modify the draft it previews', () => {
    const snapshot = structuredClone(POPULATED)

    previewPresetApply(POPULATED, PRESET, { styleReference: PRESET_STYLE_HANDLE })

    expect(POPULATED).toEqual(snapshot)
  })
})

describe('applyPreset', () => {
  // Spec section 4.4: a preset stores no identity reference and no generated
  // output, so applying one can touch neither.
  it('leaves the identity reference exactly as it was', () => {
    const applied = applyPreset(POPULATED, PRESET, { styleReference: PRESET_STYLE_HANDLE })
    const before = POPULATED.references.find((entry) => entry.role === 'identity')
    const after = applied.references.find((entry) => entry.role === 'identity')

    expect(after).toEqual(before)
    expect(after?.note).toBe('Keep the hairline')
  })

  it('adds no field that could hold a generated output', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(Object.keys(applied).sort()).toEqual(Object.keys(POPULATED).sort())
  })

  it('does not modify the state it was given', () => {
    const snapshot = structuredClone(POPULATED)

    applyPreset(POPULATED, PRESET, { styleReference: PRESET_STYLE_HANDLE })

    expect(POPULATED).toEqual(snapshot)
  })

  it('takes aspect ratio, background and format from the preset but keeps count', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(applied.output).toEqual({
      aspectRatio: '3:4',
      background: 'pale warm paper',
      format: 'png',
      count: 2
    })
  })

  it('overwrites a composition default the preset carries', () => {
    expect(applyPreset(POPULATED, PRESET).subject.pose).toBe('Full body, standing upright')
  })

  it('keeps a composition value the preset leaves empty', () => {
    expect(applyPreset(POPULATED, PRESET).subject.expression).toBe('Serious, no smile')
  })

  it('never touches the subject name or description', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(applied.subject.name).toBe(POPULATED.subject.name)
    expect(applied.subject.description).toBe(POPULATED.subject.description)
  })

  it('merges negative constraints instead of replacing what the user typed', () => {
    expect(applyPreset(POPULATED, PRESET).negativeConstraints).toEqual([
      'no extra fingers',
      'no text',
      'no watermark'
    ])
  })

  it('does not stack up duplicates when the same preset is applied twice', () => {
    const once = applyPreset(POPULATED, PRESET, { styleReference: PRESET_STYLE_HANDLE })
    const twice = applyPreset(once, PRESET, { styleReference: PRESET_STYLE_HANDLE })

    expect(twice).toEqual(once)
  })

  it('carries prompt conventions as clauses of the composition note', () => {
    expect(applyPreset(POPULATED, PRESET).subject.notes).toBe(
      'Clear silhouette; Name the camera angle first'
    )
  })

  it('sets the default role note on the slots that have a reference', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(applied.references.find((entry) => entry.role === 'outfit')?.note).toBe(
      'Keep the silhouette readable'
    )
  })

  it('records which preset was applied and leaves the anchor alone', () => {
    const applied = applyPreset(POPULATED, PRESET)

    expect(applied.source).toEqual({ preset: 'chibi-master-v1', anchor: 'nixon-v1' })
  })

  it('puts the preset style image in the style slot without disturbing the others', () => {
    const applied = applyPreset(POPULATED, PRESET, { styleReference: PRESET_STYLE_HANDLE })
    const roles = applied.references.map((entry) => entry.role)

    expect(roles).toContain('style')
    expect(roles).toHaveLength(3)
    expect(applied.references.find((entry) => entry.role === 'style')?.note).toBe(
      'Rough black outline, muted color'
    )
    expect(applied.references.find((entry) => entry.role === 'outfit')?.originalName).toBe(
      'dark-suit.png'
    )
  })

  it('replaces an existing style reference rather than adding a second one', () => {
    const withStyle: BuilderState = {
      ...POPULATED,
      references: [...POPULATED.references, reference('style', { originalName: 'old-style.png' })]
    }
    const applied = applyPreset(withStyle, PRESET, { styleReference: PRESET_STYLE_HANDLE })

    expect(applied.references.filter((entry) => entry.role === 'style')).toHaveLength(1)
    expect(applied.references.find((entry) => entry.role === 'style')?.originalName).toBe(
      'master-style.png'
    )
  })

  it('leaves the style slot alone when the preset has no style image', () => {
    const withoutStyle: Preset = { ...PRESET, styleReference: null }
    const applied = applyPreset(POPULATED, withoutStyle, {
      styleReference: PRESET_STYLE_HANDLE
    })

    expect(applied.references.map((entry) => entry.role)).toEqual(['identity', 'outfit'])
  })

  it('refuses a handle that is not a style reference', () => {
    expect(() => applyPreset(POPULATED, PRESET, { styleReference: reference('outfit') })).toThrow(
      RangeError
    )
  })
})

describe('describePresetFields', () => {
  it('describes every field the preview can list', () => {
    expect(Object.keys(describePresetFields(POPULATED)).sort()).toEqual([...PRESET_FIELDS].sort())
  })
})

describe('mergeNote', () => {
  it('leaves a note untouched when the preset has no conventions', () => {
    expect(mergeNote('a;b', [])).toBe('a;b')
  })

  it('drops a note that is only space', () => {
    expect(mergeNote('   ', [])).toBeUndefined()
    expect(mergeNote(undefined, [])).toBeUndefined()
  })

  it('appends conventions that are not already there', () => {
    expect(mergeNote('Clear silhouette', ['Clear silhouette', 'Camera angle first'])).toBe(
      'Clear silhouette; Camera angle first'
    )
  })
})
