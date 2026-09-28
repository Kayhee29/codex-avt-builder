import { describe, expect, it } from 'vitest'

import {
  anchorImmutableTraitsConflict,
  createEmptyBuilderState,
  DEFAULT_OUTPUT_REQUEST,
  newDraftFromAnchor,
  nextAnchorVersion
} from '@shared/anchor'
import {
  BuilderStateSchema,
  type Anchor,
  type BuilderReference,
  type BuilderState,
  type Preset
} from '@shared/schemas'

const SHA = '0123456789abcdef'.repeat(4)

function handle(role: BuilderReference['role'], originalName: string): BuilderReference {
  return {
    referenceId: '11111111-1111-4111-8111-111111111111',
    role,
    originalName,
    displayPath: `C:\\refs\\${originalName}`,
    mimeType: 'image/jpeg',
    sizeBytes: 412880,
    width: 800,
    height: 1000,
    sha256: SHA,
    missing: false
  }
}

const IDENTITY_HANDLE = handle('identity', 'nixon-front.jpg')

const ANCHOR: Anchor = {
  schemaVersion: 1,
  id: 'nixon',
  name: 'Richard Nixon',
  version: 1,
  createdAt: '2026-09-28T10:00:00Z',
  identityReference: {
    path: 'identity.jpg',
    originalName: 'nixon-front.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 412880,
    sha256: SHA
  },
  approvedOutput: null,
  identityDescription: 'Chibi historical character portrait, late fifties',
  immutableTraits: ['receding hairline', 'heavy jowls'],
  mutableTraits: ['outfit', 'equipment'],
  sourceJobId: '2026-09-28-richard-nixon-001'
}

const PRESET: Preset = {
  schemaVersion: 1,
  id: 'chibi-master-v1',
  name: 'Chibi master',
  createdAt: '2026-09-28T09:00:00Z',
  updatedAt: '2026-09-28T09:00:00Z',
  styleReference: null,
  roleNotes: { identity: 'Preserve facial structure', style: 'Rough black outline' },
  promptConventions: [],
  negativeConstraints: ['no text'],
  composition: { pose: 'Full body, standing upright' },
  output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png' }
}

function anchorVersion(id: string, version: number): Anchor {
  return { ...ANCHOR, id, version }
}

describe('createEmptyBuilderState', () => {
  it('starts with nothing entered and no library source', () => {
    const state = createEmptyBuilderState()

    expect(state).toEqual({
      schemaVersion: 1,
      subject: { name: '', description: '' },
      references: [],
      output: DEFAULT_OUTPUT_REQUEST,
      negativeConstraints: [],
      source: { preset: null, anchor: null }
    })
  })

  it('returns a fresh object every time', () => {
    const first = createEmptyBuilderState()

    first.output.count = 4

    expect(createEmptyBuilderState().output.count).toBe(1)
  })
})

describe('nextAnchorVersion', () => {
  it('starts at 1', () => {
    expect(nextAnchorVersion([])).toBe(1)
  })

  it('increases past the highest stored version', () => {
    expect(nextAnchorVersion([anchorVersion('nixon', 1)])).toBe(2)
    expect(nextAnchorVersion([anchorVersion('nixon', 1), anchorVersion('nixon', 2)])).toBe(3)
  })

  // Spec section 4.5: saving an anchor never overwrites an existing version.
  it('never returns a version that already exists, even after a gap', () => {
    const existing = [anchorVersion('nixon', 1), anchorVersion('nixon', 3)]
    const next = nextAnchorVersion(existing)

    expect(next).toBe(4)
    expect(existing.map((anchor) => anchor.version)).not.toContain(next)
  })

  it('does not depend on the order it is given', () => {
    expect(nextAnchorVersion([anchorVersion('nixon', 3), anchorVersion('nixon', 1)])).toBe(4)
  })

  it('refuses a list that mixes different anchors', () => {
    expect(() =>
      nextAnchorVersion([anchorVersion('nixon', 1), anchorVersion('kennedy', 5)])
    ).toThrow(RangeError)
  })
})

describe('newDraftFromAnchor', () => {
  it('takes the character name and the stable description from the anchor', () => {
    const state = newDraftFromAnchor(null, ANCHOR)

    expect(state.subject.name).toBe('Richard Nixon')
    expect(state.subject.description).toBe('Chibi historical character portrait, late fifties')
    expect(state.source).toEqual({ preset: null, anchor: 'nixon' })
  })

  // Spec sections 4.5 and 14.5: an anchor must not lock outfit, equipment,
  // pose or expression.
  it('leaves pose, expression, outfit and equipment free for the user', () => {
    const state = newDraftFromAnchor(null, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(state.subject.pose).toBeUndefined()
    expect(state.subject.expression).toBeUndefined()
    expect(state.references.map((reference) => reference.role)).toEqual(['identity'])
  })

  it('puts the identity image in the identity slot with the immutable traits as its note', () => {
    const state = newDraftFromAnchor(null, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(state.references[0]).toEqual({
      ...IDENTITY_HANDLE,
      note: 'receding hairline; heavy jowls'
    })
  })

  it('leaves the identity slot empty when the caller resolved no handle', () => {
    expect(newDraftFromAnchor(null, ANCHOR).references).toEqual([])
  })

  it('refuses a handle that is not an identity reference', () => {
    expect(() =>
      newDraftFromAnchor(null, ANCHOR, { identityReference: handle('style', 'master-style.png') })
    ).toThrow(RangeError)
  })

  it('applies the preset defaults underneath the anchor', () => {
    const state = newDraftFromAnchor(PRESET, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(state.output).toEqual({
      aspectRatio: '3:4',
      background: 'pale warm paper',
      format: 'png',
      count: 1
    })
    expect(state.negativeConstraints).toEqual(['no text'])
    expect(state.subject.pose).toBe('Full body, standing upright')
    expect(state.source).toEqual({ preset: 'chibi-master-v1', anchor: 'nixon' })
  })

  // Spec section 4.4: preset defaults < anchor defaults < user values.
  it('lets the anchor win where both carry a default', () => {
    const state = newDraftFromAnchor(PRESET, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(state.references[0]?.note).toBe('receding hairline; heavy jowls')
  })

  it('falls back to the preset identity note when the anchor pins no traits', () => {
    const untraited: Anchor = { ...ANCHOR, immutableTraits: [] }
    const state = newDraftFromAnchor(PRESET, untraited, { identityReference: IDENTITY_HANDLE })

    expect(state.references[0]?.note).toBe('Preserve facial structure')
  })

  it('produces a state that validates once the anchor has a description', () => {
    const state = newDraftFromAnchor(PRESET, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(BuilderStateSchema.safeParse(state).success).toBe(true)
  })

  it('does not modify the anchor or the preset', () => {
    const anchorSnapshot = structuredClone(ANCHOR)
    const presetSnapshot = structuredClone(PRESET)

    newDraftFromAnchor(PRESET, ANCHOR, { identityReference: IDENTITY_HANDLE })

    expect(ANCHOR).toEqual(anchorSnapshot)
    expect(PRESET).toEqual(presetSnapshot)
  })
})

describe('anchorImmutableTraitsConflict', () => {
  function withConstraints(constraints: string[]): BuilderState {
    return { ...createEmptyBuilderState(), negativeConstraints: constraints }
  }

  it('reports a trait the draft asks to leave out', () => {
    expect(anchorImmutableTraitsConflict(ANCHOR, withConstraints(['no heavy jowls']))).toEqual([
      'heavy jowls'
    ])
  })

  it('ignores case, spacing and punctuation', () => {
    const anchor: Anchor = { ...ANCHOR, immutableTraits: ['wire-rimmed glasses'] }

    expect(
      anchorImmutableTraitsConflict(anchor, withConstraints(['No   Wire Rimmed Glasses!']))
    ).toEqual(['wire-rimmed glasses'])
  })

  it('matches whole words, so "hat" does not conflict with "no hatred"', () => {
    const anchor: Anchor = { ...ANCHOR, immutableTraits: ['hat'] }

    expect(anchorImmutableTraitsConflict(anchor, withConstraints(['no hatred']))).toEqual([])
  })

  it('returns nothing when the constraints are unrelated', () => {
    expect(anchorImmutableTraitsConflict(ANCHOR, withConstraints(['no text']))).toEqual([])
  })

  it('returns nothing when there are no constraints or no traits', () => {
    expect(anchorImmutableTraitsConflict(ANCHOR, createEmptyBuilderState())).toEqual([])
    expect(
      anchorImmutableTraitsConflict(
        { ...ANCHOR, immutableTraits: [] },
        withConstraints(['no heavy jowls'])
      )
    ).toEqual([])
  })

  it('reports every conflicting trait in anchor order', () => {
    const state = withConstraints(['no heavy jowls', 'remove the receding hairline'])

    expect(anchorImmutableTraitsConflict(ANCHOR, state)).toEqual([
      'receding hairline',
      'heavy jowls'
    ])
  })
})
