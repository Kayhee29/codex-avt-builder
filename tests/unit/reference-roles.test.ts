import { describe, expect, it } from 'vitest'

import {
  assignReferenceLabels,
  dedupeReferenceRoles,
  DuplicateReferenceRoleError,
  isReferenceRole,
  labelFor,
  MAX_REFERENCES,
  REFERENCE_LABELS,
  REFERENCE_ROLES,
  roleOrder,
  sortReferences,
  TooManyReferencesError,
  type ReferenceRole
} from '@shared/reference-roles'

interface TestReference {
  readonly role: ReferenceRole
  readonly file: string
}

function ref(role: ReferenceRole, file = `${role}.png`): TestReference {
  return { role, file }
}

describe('REFERENCE_ROLES', () => {
  it('lists the five roles in the order fixed by spec sections 4.2 and 5.3', () => {
    expect(REFERENCE_ROLES).toEqual(['style', 'identity', 'outfit', 'equipment', 'extra'])
  })

  it('has one label per role', () => {
    expect(REFERENCE_LABELS).toHaveLength(REFERENCE_ROLES.length)
    expect(MAX_REFERENCES).toBe(5)
  })

  it('orders roles by their position in the fixed list', () => {
    expect(roleOrder('style')).toBe(0)
    expect(roleOrder('identity')).toBe(1)
    expect(roleOrder('extra')).toBe(4)
  })

  it('recognises only the five known roles', () => {
    for (const role of REFERENCE_ROLES) {
      expect(isReferenceRole(role)).toBe(true)
    }

    expect(isReferenceRole('background')).toBe(false)
    expect(isReferenceRole('Style')).toBe(false)
    expect(isReferenceRole(undefined)).toBe(false)
    expect(isReferenceRole(0)).toBe(false)
  })
})

describe('labelFor', () => {
  it('returns Image A through Image E', () => {
    expect(labelFor(0)).toBe('Image A')
    expect(labelFor(1)).toBe('Image B')
    expect(labelFor(2)).toBe('Image C')
    expect(labelFor(3)).toBe('Image D')
    expect(labelFor(4)).toBe('Image E')
  })

  it('refuses indexes outside the label range', () => {
    expect(() => labelFor(5)).toThrow(RangeError)
    expect(() => labelFor(-1)).toThrow(RangeError)
  })
})

describe('sortReferences', () => {
  it('sorts into the fixed role order', () => {
    const sorted = sortReferences([ref('extra'), ref('identity'), ref('style'), ref('equipment')])

    expect(sorted.map((reference) => reference.role)).toEqual([
      'style',
      'identity',
      'equipment',
      'extra'
    ])
  })

  it('leaves the input array untouched', () => {
    const input = [ref('outfit'), ref('style')]
    const snapshot = [...input]

    sortReferences(input)

    expect(input).toEqual(snapshot)
  })

  it('rejects a duplicated role and names it', () => {
    const duplicate = [ref('style', 'a.png'), ref('identity'), ref('style', 'b.png')]

    expect(() => sortReferences(duplicate)).toThrow(DuplicateReferenceRoleError)
    expect(() => sortReferences(duplicate)).toThrow(/style/)
  })

  it('accepts an empty list', () => {
    expect(sortReferences([])).toEqual([])
  })
})

describe('assignReferenceLabels', () => {
  it('labels a full set in role order', () => {
    const labelled = assignReferenceLabels(REFERENCE_ROLES.map((role) => ref(role)))

    expect(labelled.map((reference) => [reference.label, reference.role])).toEqual([
      ['Image A', 'style'],
      ['Image B', 'identity'],
      ['Image C', 'outfit'],
      ['Image D', 'equipment'],
      ['Image E', 'extra']
    ])
  })

  it('sorts before labelling, so input order does not matter', () => {
    const labelled = assignReferenceLabels([ref('outfit'), ref('style'), ref('identity')])

    expect(labelled.map((reference) => [reference.label, reference.role])).toEqual([
      ['Image A', 'style'],
      ['Image B', 'identity'],
      ['Image C', 'outfit']
    ])
  })

  // Plan decision Q14. The labels have to line up with the `-i` attachment
  // order of spec section 5.3, and that list only holds references that exist.
  it('assigns labels sequentially, so a missing style slot makes identity Image A', () => {
    const labelled = assignReferenceLabels([ref('equipment'), ref('identity'), ref('outfit')])

    expect(labelled.map((reference) => [reference.label, reference.role])).toEqual([
      ['Image A', 'identity'],
      ['Image B', 'outfit'],
      ['Image C', 'equipment']
    ])
  })

  it('gives the only present reference Image A whatever its role is', () => {
    expect(assignReferenceLabels([ref('extra')])[0]).toEqual({
      role: 'extra',
      file: 'extra.png',
      label: 'Image A'
    })
  })

  it('keeps the other fields of each reference', () => {
    const labelled = assignReferenceLabels([ref('identity', 'nixon-front.jpg')])

    expect(labelled[0]?.file).toBe('nixon-front.jpg')
  })

  it('rejects a duplicated role', () => {
    expect(() => assignReferenceLabels([ref('style'), ref('style')])).toThrow(
      DuplicateReferenceRoleError
    )
  })

  it('rejects more references than there are roles', () => {
    const tooMany = [...REFERENCE_ROLES.map((role) => ref(role)), ref('style', 'sixth.png')]

    expect(() => assignReferenceLabels(tooMany)).toThrow(TooManyReferencesError)
  })

  it('returns an empty list for no references', () => {
    expect(assignReferenceLabels([])).toEqual([])
  })
})

/**
 * Plan decision Q23. `BuilderStateSchema` cannot express "one reference per
 * role" — a zod refinement would disappear from the exported JSON Schema — so a
 * hand-edited `workspace/drafts/current.json` can name a role twice, and
 * `sortReferences` would throw where the prompt preview is built.
 */
describe('dedupeReferenceRoles (plan decision Q23)', () => {
  it('keeps the first reference of a repeated role and drops the rest', () => {
    const deduped = dedupeReferenceRoles([
      ref('style', 'first.png'),
      ref('identity'),
      ref('style', 'second.png')
    ])

    expect(deduped.map((reference) => reference.file)).toEqual(['first.png', 'identity.png'])
  })

  it('makes a list sortReferences accepts', () => {
    const duplicated = [ref('style', 'a.png'), ref('style', 'b.png')]

    expect(() => sortReferences(duplicated)).toThrow(DuplicateReferenceRoleError)
    expect(() => sortReferences(dedupeReferenceRoles(duplicated))).not.toThrow()
  })

  it('leaves a list without duplicates exactly as it was, in order', () => {
    const clean = [ref('identity'), ref('style')]

    expect(dedupeReferenceRoles(clean)).toEqual(clean)
  })

  it('does not mutate the input', () => {
    const input = [ref('style', 'a.png'), ref('style', 'b.png')]

    dedupeReferenceRoles(input)

    expect(input).toHaveLength(2)
  })
})
