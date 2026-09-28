import { describe, expect, it } from 'vitest'

import {
  buildPrompt,
  DEFAULT_CONFLICT_POLICY,
  mergeNegativeConstraints,
  orderReferences,
  PROMPT_SECTION_TITLES,
  ReferenceOrderError,
  sha256Hex,
  UNNAMED_SUBJECT,
  UNSPECIFIED,
  type OrderedReference,
  type PromptReference
} from '@shared/prompt-builder'
import { DuplicateReferenceRoleError } from '@shared/reference-roles'
import type { BuilderState } from '@shared/schemas'

/** A builder state with every optional field filled in (spec section 4.1). */
const FULL_STATE: BuilderState = {
  schemaVersion: 1,
  subject: {
    name: 'Richard Nixon',
    description: 'Chibi historical character portrait',
    pose: 'Full body, standing upright',
    expression: 'Serious, no smile',
    notes: 'Clear silhouette'
  },
  references: [],
  output: {
    aspectRatio: '3:4',
    background: 'pale warm paper',
    format: 'png',
    count: 1
  },
  negativeConstraints: ['no text', 'no watermark'],
  source: { preset: 'chibi-master-v1', anchor: 'nixon-v1' }
}

/** The minimum a user can have typed: nothing. The preview still renders. */
const EMPTY_STATE: BuilderState = {
  schemaVersion: 1,
  subject: { name: '', description: '' },
  references: [],
  output: { aspectRatio: '1:1', background: '', format: 'png', count: 1 },
  negativeConstraints: [],
  source: { preset: null, anchor: null }
}

/** The three references of the spec section 4.3 mapping example. */
const SPEC_REFERENCES: PromptReference[] = [
  {
    role: 'style',
    originalName: 'master-style.png',
    note: 'Rough black outline, muted color and warm paper texture'
  },
  {
    role: 'identity',
    originalName: 'nixon-front.jpg',
    note: 'Preserve facial structure, hairline and age cues'
  },
  { role: 'outfit', originalName: 'dark-suit.png' }
]

function headingIndexes(markdown: string): number[] {
  return PROMPT_SECTION_TITLES.map((title) => markdown.indexOf(`## ${title}`))
}

describe('orderReferences', () => {
  it('sorts by role and labels the references that are present', () => {
    const ordered = orderReferences(SPEC_REFERENCES)

    expect(ordered.map((reference) => [reference.label, reference.role])).toEqual([
      ['Image A', 'style'],
      ['Image B', 'identity'],
      ['Image C', 'outfit']
    ])
  })

  it('rejects two references in the same role', () => {
    expect(() =>
      orderReferences([
        { role: 'style', originalName: 'a.png' },
        { role: 'style', originalName: 'b.png' }
      ])
    ).toThrow(DuplicateReferenceRoleError)
  })
})

describe('buildPrompt section order', () => {
  const { markdown } = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))

  it('writes the seven sections of spec section 4.3', () => {
    expect(PROMPT_SECTION_TITLES).toEqual([
      'Image goal',
      'Reference map',
      'Subject',
      'Pose, expression and composition',
      'Output constraints',
      'Conflict policy',
      'Negative constraints'
    ])

    for (const index of headingIndexes(markdown)) {
      expect(index).toBeGreaterThanOrEqual(0)
    }
  })

  it('writes them in that order, checked by heading position', () => {
    const indexes = headingIndexes(markdown)
    const sorted = [...indexes].sort((left, right) => left - right)

    expect(indexes).toEqual(sorted)
  })

  it('writes each heading exactly once', () => {
    for (const title of PROMPT_SECTION_TITLES) {
      expect(markdown.split(`## ${title}`)).toHaveLength(2)
    }
  })

  it('renders every section even when the builder is empty', () => {
    const empty = buildPrompt(EMPTY_STATE, [])

    for (const index of headingIndexes(empty.markdown)) {
      expect(index).toBeGreaterThanOrEqual(0)
    }

    expect(empty.markdown).toContain(`Generate 1 image of ${UNNAMED_SUBJECT}.`)
    expect(empty.markdown).toContain(`- Name: ${UNSPECIFIED}`)
    expect(empty.markdown).toContain('No reference images are attached.')
    expect(empty.markdown).toContain('No pose, expression or composition direction was given.')
  })
})

describe('reference map', () => {
  it('writes the mapping of spec section 4.3', () => {
    const { markdown } = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))

    expect(markdown).toContain('Image A → style → master-style.png')
    expect(markdown).toContain('Image B → identity → nixon-front.jpg')
    expect(markdown).toContain('Image C → outfit → dark-suit.png')
  })

  it('returns the same rows for the UI table', () => {
    const { mapping } = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))

    expect(mapping).toEqual([
      {
        label: 'Image A',
        role: 'style',
        originalName: 'master-style.png',
        note: 'Rough black outline, muted color and warm paper texture'
      },
      {
        label: 'Image B',
        role: 'identity',
        originalName: 'nixon-front.jpg',
        note: 'Preserve facial structure, hairline and age cues'
      },
      { label: 'Image C', role: 'outfit', originalName: 'dark-suit.png' }
    ])
  })

  it('writes the per-role note under its reference', () => {
    const { markdown } = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))

    expect(markdown).toContain(
      '- Image A → style → master-style.png\n  - Note: Rough black outline, muted color and warm paper texture'
    )
    expect(markdown).toContain('- Image C → outfit → dark-suit.png\n')
  })

  // Plan decision Q14: labels follow the `-i` attachment order of spec section
  // 5.3, and that list only holds the references that exist.
  it('makes identity Image A when the style slot is empty', () => {
    const withoutStyle = orderReferences([
      { role: 'equipment', originalName: 'briefcase.png' },
      { role: 'identity', originalName: 'nixon-front.jpg' }
    ])
    const { markdown, mapping } = buildPrompt(FULL_STATE, withoutStyle)
    const map = markdown.slice(markdown.indexOf('## Reference map'), markdown.indexOf('## Subject'))

    expect(map).toContain('Image A → identity → nixon-front.jpg')
    expect(map).toContain('Image B → equipment → briefcase.png')
    expect(map).not.toContain('style')
    expect(mapping.map((row) => [row.label, row.role])).toEqual([
      ['Image A', 'identity'],
      ['Image B', 'equipment']
    ])
  })

  it('refuses references that were not ordered and labelled first', () => {
    const unsorted: OrderedReference[] = [
      { label: 'Image A', role: 'outfit', originalName: 'dark-suit.png' },
      { label: 'Image B', role: 'style', originalName: 'master-style.png' }
    ]

    expect(() => buildPrompt(FULL_STATE, unsorted)).toThrow(ReferenceOrderError)
  })

  it('refuses labels that do not match the attachment order', () => {
    const misLabelled: OrderedReference[] = [
      { label: 'Image B', role: 'style', originalName: 'master-style.png' }
    ]

    expect(() => buildPrompt(FULL_STATE, misLabelled)).toThrow(ReferenceOrderError)
  })
})

describe('conflict policy', () => {
  it('always carries the default policy of spec section 4.3', () => {
    for (const state of [FULL_STATE, EMPTY_STATE]) {
      const { markdown } = buildPrompt(state, [])

      for (const rule of DEFAULT_CONFLICT_POLICY) {
        expect(markdown).toContain(`- ${rule}`)
      }
    }
  })

  it('names the four roles and gives the user the last word', () => {
    expect(DEFAULT_CONFLICT_POLICY.join('\n')).toMatch(/identity/)
    expect(DEFAULT_CONFLICT_POLICY.join('\n')).toMatch(/style/)
    expect(DEFAULT_CONFLICT_POLICY.join('\n')).toMatch(/outfit/)
    expect(DEFAULT_CONFLICT_POLICY.join('\n')).toMatch(/equipment/)
    expect(DEFAULT_CONFLICT_POLICY.at(-1)).toMatch(/highest priority/)
  })
})

describe('negative constraints', () => {
  it('merges the preset list with the user list without repeating one', () => {
    const state: BuilderState = {
      ...FULL_STATE,
      negativeConstraints: ['no text', 'no extra fingers']
    }
    const { markdown } = buildPrompt(state, [], {
      presetNegativeConstraints: ['no text', 'no modern clothing']
    })

    const section = markdown.slice(markdown.indexOf('## Negative constraints'))

    expect(section.split('- no text')).toHaveLength(2)
    expect(section).toContain('- no modern clothing')
    expect(section).toContain('- no extra fingers')
  })

  it('puts preset constraints before user constraints (spec section 4.4)', () => {
    const { markdown } = buildPrompt({ ...FULL_STATE, negativeConstraints: ['from user'] }, [], {
      presetNegativeConstraints: ['from preset']
    })

    expect(markdown.indexOf('- from preset')).toBeLessThan(markdown.indexOf('- from user'))
  })

  it('says so when there are none', () => {
    const { markdown } = buildPrompt(EMPTY_STATE, [])

    expect(markdown.slice(markdown.indexOf('## Negative constraints'))).toContain('None.')
  })
})

describe('mergeNegativeConstraints', () => {
  it('keeps the first spelling and ignores case and spacing when comparing', () => {
    expect(mergeNegativeConstraints(['No Text'], ['  no   text  ', 'no watermark'])).toEqual([
      'No Text',
      'no watermark'
    ])
  })

  it('drops blank entries', () => {
    expect(mergeNegativeConstraints(['', '   '], ['no text'])).toEqual(['no text'])
  })

  it('accepts no lists at all', () => {
    expect(mergeNegativeConstraints()).toEqual([])
  })
})

describe('determinism', () => {
  it('produces the same markdown for the same input', () => {
    const first = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))
    const second = buildPrompt(structuredClone(FULL_STATE), orderReferences([...SPEC_REFERENCES]))

    expect(second.markdown).toBe(first.markdown)
    expect(second.mapping).toEqual(first.mapping)
  })

  it('produces the same checksum for the same input', async () => {
    const first = buildPrompt(FULL_STATE, orderReferences(SPEC_REFERENCES))
    const second = buildPrompt(FULL_STATE, orderReferences([...SPEC_REFERENCES].reverse()))

    expect(await sha256Hex(second.markdown)).toBe(await sha256Hex(first.markdown))
  })

  it('changes the checksum when the direction changes', async () => {
    const before = buildPrompt(FULL_STATE, [])
    const after = buildPrompt(
      { ...FULL_STATE, subject: { ...FULL_STATE.subject, pose: 'Seated' } },
      []
    )

    expect(await sha256Hex(after.markdown)).not.toBe(await sha256Hex(before.markdown))
  })

  it('does not mutate the state or the references it is given', () => {
    const state = structuredClone(FULL_STATE)
    const references = orderReferences(SPEC_REFERENCES)
    const referencesBefore = structuredClone(references)

    buildPrompt(state, references)

    expect(state).toEqual(FULL_STATE)
    expect(references).toEqual(referencesBefore)
  })
})

describe('sha256Hex', () => {
  it('matches the published digests', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    )
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('returns the 64 lowercase hex characters job.json expects', async () => {
    const digest = await sha256Hex(buildPrompt(FULL_STATE, []).markdown)

    expect(digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it('hashes UTF-8 bytes, so Vietnamese text is stable', async () => {
    expect(await sha256Hex('Nguyễn')).toBe(await sha256Hex('Nguyễn'.normalize('NFC')))
    expect(await sha256Hex('Nguyễn')).not.toBe(await sha256Hex('Nguyen'))
  })
})

describe('snapshot', () => {
  it('renders a fully populated state', () => {
    const state: BuilderState = {
      ...FULL_STATE,
      negativeConstraints: ['no text', 'no watermark', 'no modern clothing']
    }
    const references = orderReferences([
      ...SPEC_REFERENCES,
      { role: 'equipment', originalName: 'briefcase.png', note: 'Held in the left hand' },
      { role: 'extra', originalName: 'flag.png', note: 'Small flag pin on the lapel' }
    ])

    expect(
      buildPrompt(state, references, { presetNegativeConstraints: ['no photo realism'] }).markdown
    ).toMatchSnapshot()
  })
})
