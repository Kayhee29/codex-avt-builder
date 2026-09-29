/**
 * The predefined choices behind the builder's dropdowns.
 *
 * The lists are data, and the point of pinning them down here is that picking
 * from a dropdown must never be able to produce a draft the builder refuses to
 * generate. A free-text box could always hold something invalid; a closed list
 * should not, and this asserts it against the schemas rather than by eye.
 */
import { describe, expect, it } from 'vitest'

import {
  ASPECT_RATIO_OPTIONS,
  BACKGROUND_OPTIONS,
  COUNT_OPTIONS,
  EXPRESSION_OPTIONS,
  findOptionByValue,
  POSE_OPTIONS,
  type DirectionOption
} from '../../src/shared/direction-options.ts'
import { OutputRequestSchema, SubjectSchema } from '../../src/shared/schemas.ts'

const LISTS: Record<string, readonly DirectionOption[]> = {
  pose: POSE_OPTIONS,
  expression: EXPRESSION_OPTIONS,
  aspectRatio: ASPECT_RATIO_OPTIONS,
  background: BACKGROUND_OPTIONS
}

describe('every option list', () => {
  it('has unique ids', () => {
    for (const [name, options] of Object.entries(LISTS)) {
      const ids = options.map((option) => option.id)

      expect(new Set(ids).size, `${name} repeats an id`).toBe(ids.length)
    }
  })

  it('has unique, non-blank values', () => {
    for (const [name, options] of Object.entries(LISTS)) {
      const values = options.map((option) => option.value)

      expect(new Set(values).size, `${name} repeats a value`).toBe(values.length)

      for (const value of values) {
        expect(value.trim(), `${name} has a blank value`).not.toBe('')
      }
    }
  })

  it('writes its value in English, because prompt.md is an English document', () => {
    // The prompt builder drops these straight into `- Pose: …`. A Vietnamese
    // value would land inside an otherwise English prompt; the Vietnamese
    // belongs on the label, in `src/renderer/i18n/vi.ts`.
    const vietnamese = /[ăâđêôơưàáảãạèéẻẽẹìíỉĩịòóỏõọùúủũụỳýỷỹỵ]/i

    for (const [name, options] of Object.entries(LISTS)) {
      for (const option of options) {
        expect(vietnamese.test(option.value), `${name}.${option.id} is not English`).toBe(false)
      }
    }
  })
})

describe('pose and expression', () => {
  // The builder is for character work, where these two carry most of the
  // direction. A short list would push people straight to "Khác…" and defeat
  // the dropdown.
  it('offer enough range to be worth choosing from', () => {
    expect(POSE_OPTIONS.length).toBeGreaterThanOrEqual(18)
    expect(EXPRESSION_OPTIONS.length).toBeGreaterThanOrEqual(18)
  })
})

describe('output options', () => {
  it('states every aspect ratio as width:height', () => {
    for (const option of ASPECT_RATIO_OPTIONS) {
      expect(option.value).toMatch(/^\d+:\d+$/)
    }
  })

  it('offers counts that are positive whole numbers', () => {
    expect(COUNT_OPTIONS.length).toBeGreaterThan(0)

    for (const count of COUNT_OPTIONS) {
      expect(Number.isInteger(count)).toBe(true)
      expect(count).toBeGreaterThan(0)
    }
  })
})

describe('any combination of choices', () => {
  it('produces a subject the schema accepts', () => {
    for (const pose of POSE_OPTIONS) {
      for (const expression of EXPRESSION_OPTIONS) {
        const parsed = SubjectSchema.safeParse({
          name: 'A',
          description: 'B',
          pose: pose.value,
          expression: expression.value
        })

        expect(parsed.success, `${pose.id} + ${expression.id} was rejected`).toBe(true)
      }
    }
  })

  it('produces an output request the schema accepts', () => {
    for (const ratio of ASPECT_RATIO_OPTIONS) {
      for (const background of BACKGROUND_OPTIONS) {
        for (const count of COUNT_OPTIONS) {
          const parsed = OutputRequestSchema.safeParse({
            aspectRatio: ratio.value,
            background: background.value,
            format: 'png',
            count
          })

          expect(parsed.success, `${ratio.id} + ${background.id} + ${count}`).toBe(true)
        }
      }
    }
  })
})

describe('findOptionByValue', () => {
  it('finds a value that came from the list', () => {
    const first = POSE_OPTIONS[0]

    expect(findOptionByValue(POSE_OPTIONS, first?.value ?? '')).toBe(first)
  })

  it('returns undefined for anything else, which is what selects "Khác…"', () => {
    // A draft saved before these lists existed, or one typed by hand, holds a
    // value no list knows. The form has to notice and show the text box with
    // the value still in it rather than silently dropping it.
    expect(findOptionByValue(POSE_OPTIONS, 'ngồi xổm trên nóc tủ')).toBeUndefined()
    expect(findOptionByValue(POSE_OPTIONS, '')).toBeUndefined()
  })
})
