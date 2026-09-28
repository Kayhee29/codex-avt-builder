import { describe, expect, it } from 'vitest'

import {
  CODEX_MIN_VERSION,
  compareCodexVersions,
  isCodexVersionSupported,
  parseCodexVersion
} from '../../src/shared/codex-version.ts'

describe('CODEX_MIN_VERSION', () => {
  it('is the value spec section 5.3 fixed', () => {
    expect(CODEX_MIN_VERSION).toBe('0.158.0')
  })
})

describe('parseCodexVersion', () => {
  it('reads what the installed 0.27.0 binary prints', () => {
    expect(parseCodexVersion('codex-cli 0.27.0\n')).toBe('0.27.0')
  })

  it('reads a version surrounded by other output', () => {
    expect(parseCodexVersion('some banner\ncodex-cli 0.158.0\nmore\n')).toBe('0.158.0')
  })

  it('returns null for output with no version in it', () => {
    expect(parseCodexVersion('usage: codex [options]')).toBeNull()
    expect(parseCodexVersion('')).toBeNull()
  })

  it('does not accept a bare number without the codex-cli prefix', () => {
    expect(parseCodexVersion('0.158.0')).toBeNull()
  })
})

describe('compareCodexVersions', () => {
  it('compares numerically, not as strings', () => {
    // The whole reason this exists: "0.27.0" > "0.158.0" as strings.
    expect(compareCodexVersions('0.27.0', '0.158.0')).toBe(-1)
    expect(compareCodexVersions('0.158.0', '0.27.0')).toBe(1)
  })

  it('treats equal versions as equal', () => {
    expect(compareCodexVersions('0.158.0', '0.158.0')).toBe(0)
  })

  it('orders by major, then minor, then patch', () => {
    expect(compareCodexVersions('1.0.0', '0.999.999')).toBe(1)
    expect(compareCodexVersions('0.158.1', '0.158.0')).toBe(1)
    expect(compareCodexVersions('0.158.0', '0.158.1')).toBe(-1)
  })

  it('refuses anything that is not <major>.<minor>.<patch>', () => {
    expect(() => compareCodexVersions('0.158', '0.158.0')).toThrow(TypeError)
    expect(() => compareCodexVersions('0.158.0-rc.1', '0.158.0')).toThrow(TypeError)
    expect(() => compareCodexVersions('v0.158.0', '0.158.0')).toThrow(TypeError)
  })
})

describe('isCodexVersionSupported', () => {
  it('rejects the 0.27.0 installed on the development machine', () => {
    expect(isCodexVersionSupported('0.27.0')).toBe(false)
  })

  it('accepts the minimum itself and anything newer', () => {
    expect(isCodexVersionSupported(CODEX_MIN_VERSION)).toBe(true)
    expect(isCodexVersionSupported('0.159.0')).toBe(true)
    expect(isCodexVersionSupported('2.0.0')).toBe(true)
  })

  it('takes an explicit minimum', () => {
    expect(isCodexVersionSupported('0.27.0', '0.1.0')).toBe(true)
  })
})
