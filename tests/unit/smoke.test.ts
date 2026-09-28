import { describe, expect, it } from 'vitest'

describe('test harness', () => {
  it('runs vitest against strict TypeScript sources', () => {
    const roles = ['style', 'identity', 'outfit', 'equipment', 'extra'] as const

    expect(roles).toHaveLength(5)
  })

  it('keeps noUncheckedIndexedAccess honest', () => {
    const values: string[] = []
    const first: string | undefined = values[0]

    expect(first).toBeUndefined()
  })
})
