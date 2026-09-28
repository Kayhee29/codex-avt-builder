import { describe, expect, it } from 'vitest'

import {
  buildJobId,
  FALLBACK_JOB_SLUG,
  isValidJobId,
  JOB_ID_REGEX,
  MAX_JOB_SEQUENCE,
  MAX_JOB_SLUG_LENGTH,
  slugifySubject
} from '@shared/job-id'

/** 2026-09-28 in machine local time, the date used by the spec examples. */
const SPEC_DATE = new Date(2026, 8, 28, 10, 0, 0)

describe('slugifySubject', () => {
  it('lowercases and hyphenates an ASCII name', () => {
    expect(slugifySubject('Richard Nixon')).toBe('richard-nixon')
  })

  it('strips Vietnamese diacritics', () => {
    expect(slugifySubject('Nguyễn Văn A')).toBe('nguyen-van-a')
    expect(slugifySubject('Trần Hưng Đạo')).toBe('tran-hung-dao')
    expect(slugifySubject('đường')).toBe('duong')
  })

  it('collapses runs of separators and trims the ends', () => {
    expect(slugifySubject('Richard   J.  Nixon')).toBe('richard-j-nixon')
    expect(slugifySubject('  -- Richard --  ')).toBe('richard')
    expect(slugifySubject('a__b//c')).toBe('a-b-c')
  })

  it('falls back to job when nothing usable is left', () => {
    expect(slugifySubject('!!!')).toBe(FALLBACK_JOB_SLUG)
    expect(slugifySubject('###@@@ ***')).toBe(FALLBACK_JOB_SLUG)
    expect(slugifySubject('')).toBe(FALLBACK_JOB_SLUG)
    expect(slugifySubject('   ')).toBe(FALLBACK_JOB_SLUG)
  })

  it('cuts a long slug at 24 characters without leaving a trailing hyphen', () => {
    const slug = slugifySubject('Richard Milhous Nixon the thirty seventh president')

    expect(slug.length).toBeLessThanOrEqual(MAX_JOB_SLUG_LENGTH)
    expect(slug).toBe('richard-milhous-nixon-th')
    expect(slug.endsWith('-')).toBe(false)
  })

  it('never leaves a trailing hyphen when the cut lands on a separator', () => {
    // "abcdefghijklmnopqrstuvw x" is cut right where the hyphen would be.
    const slug = slugifySubject('abcdefghijklmnopqrstuvw x')

    expect(slug).toBe('abcdefghijklmnopqrstuvw')
    expect(slug.endsWith('-')).toBe(false)
  })

  it('is idempotent', () => {
    for (const name of ['Richard Nixon', 'Nguyễn Văn A', '!!!', 'A very long subject name here']) {
      expect(slugifySubject(slugifySubject(name))).toBe(slugifySubject(name))
    }
  })

  it('flattens path separators and traversal instead of preserving them', () => {
    expect(slugifySubject('../../etc/passwd')).toBe('etc-passwd')
    expect(slugifySubject('C:\\Windows\\System32')).toBe('c-windows-system32')
  })
})

describe('buildJobId', () => {
  it('builds the job ID used throughout the spec', () => {
    expect(buildJobId(SPEC_DATE, 'Richard Nixon', 1)).toBe('2026-09-28-richard-nixon-001')
  })

  it('produces a value that matches the pattern of spec section 6.1', () => {
    const jobId = buildJobId(SPEC_DATE, 'Richard Nixon', 1)

    expect(JOB_ID_REGEX.test(jobId)).toBe(true)
    expect(isValidJobId(jobId)).toBe(true)
  })

  it('pads the sequence to three digits', () => {
    expect(buildJobId(SPEC_DATE, 'Richard Nixon', 2)).toBe('2026-09-28-richard-nixon-002')
    expect(buildJobId(SPEC_DATE, 'Richard Nixon', 42)).toBe('2026-09-28-richard-nixon-042')
    expect(buildJobId(SPEC_DATE, 'Richard Nixon', MAX_JOB_SEQUENCE)).toBe(
      '2026-09-28-richard-nixon-999'
    )
  })

  it('uses machine local time, not UTC', () => {
    // 00:30 local on 1 January: a UTC-based formatter would drift by a day in
    // any zone east or west of UTC.
    expect(buildJobId(new Date(2026, 0, 1, 0, 30), 'Nixon', 1)).toBe('2026-01-01-nixon-001')
    expect(buildJobId(new Date(2026, 11, 31, 23, 45), 'Nixon', 1)).toBe('2026-12-31-nixon-001')
  })

  it('slugifies the subject it is given, so raw names cannot slip through', () => {
    expect(buildJobId(SPEC_DATE, '../../etc/passwd', 1)).toBe('2026-09-28-etc-passwd-001')
    expect(buildJobId(SPEC_DATE, 'Nguyễn Văn A', 1)).toBe('2026-09-28-nguyen-van-a-001')
    expect(buildJobId(SPEC_DATE, '!!!', 1)).toBe('2026-09-28-job-001')
  })

  it.each([0, -1, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses sequence %s',
    (sequence) => {
      expect(() => buildJobId(SPEC_DATE, 'Richard Nixon', sequence)).toThrow(RangeError)
    }
  )

  it('refuses an invalid Date', () => {
    expect(() => buildJobId(new Date('not a date'), 'Richard Nixon', 1)).toThrow(RangeError)
  })

  it('only ever returns valid job IDs', () => {
    const hostile = [
      '../..',
      '  ',
      '!!!',
      'A'.repeat(200),
      'Nguyễn Văn A',
      'job',
      '---',
      '2026-09-28-already-an-id-001',
      'C:\\Windows\\System32',
      'name\nwith\nnewlines'
    ]

    for (const subject of hostile) {
      expect(isValidJobId(buildJobId(SPEC_DATE, subject, 7))).toBe(true)
    }
  })
})

describe('isValidJobId', () => {
  it.each([
    '2026-09-28-richard-nixon-001',
    '2026-09-28-job-001',
    '2026-01-01-a-999',
    '2026-09-28-nguyen-van-a-042',
    `2026-09-28-${'a'.repeat(MAX_JOB_SLUG_LENGTH)}-001`
  ])('accepts %s', (jobId) => {
    expect(isValidJobId(jobId)).toBe(true)
  })

  it.each([
    ['../x', 'traversal'],
    ['../../etc/passwd', 'deeper traversal'],
    ['2026-09-28-richard-nixon-001/../..', 'traversal appended to a valid id'],
    ['../2026-09-28-job-001', 'traversal prepended to a valid id'],
    ['2026-09-28-Richard-Nixon-001', 'uppercase'],
    ['2026-09-28-richard nixon-001', 'whitespace inside'],
    [' 2026-09-28-job-001', 'leading space'],
    ['2026-09-28-job-001 ', 'trailing space'],
    ['2026-09-28-job-001\n', 'trailing newline'],
    ['\n2026-09-28-job-001', 'leading newline'],
    ['2026-09-28--001', 'empty slug'],
    ['2026-09-28-job--001', 'doubled hyphen before the sequence'],
    ['2026-09-28--job-001', 'slug starting with a hyphen'],
    ['2026-09-28-job-01', 'two digit sequence'],
    ['2026-09-28-job-0001', 'four digit sequence'],
    ['26-09-28-job-001', 'two digit year'],
    ['2026-09-28-job', 'no sequence'],
    [`2026-09-28-${'a'.repeat(MAX_JOB_SLUG_LENGTH + 1)}-001`, 'slug over 24 characters'],
    ['2026-09-28-job_001-001', 'underscore in the slug'],
    ['2026-09-28-jób-001', 'accent in the slug'],
    ['', 'empty string']
  ])('rejects %s (%s)', (jobId) => {
    expect(isValidJobId(jobId)).toBe(false)
  })

  it.each([null, undefined, 1, {}, [], new Date()])('rejects the non-string %s', (value) => {
    expect(isValidJobId(value)).toBe(false)
  })
})
