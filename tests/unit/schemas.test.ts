import { describe, expect, it } from 'vitest'

// The run-state vocabulary and the progress payload moved to
// `src/shared/progress.ts` with plan Task 1.6; `tests/unit/ipc-contract.test.ts`
// covers them.
import { TERMINAL_RUN_STATES } from '@shared/progress'
import {
  AnchorSchema,
  BuilderStateSchema,
  CODEX_ERROR_CODES,
  CodexResultSchema,
  DraftSchema,
  JobPacketSchema,
  PresetSchema,
  RESULT_ERROR_CODES,
  ResultSchema,
  SettingsSchema,
  SHA256_REGEX
} from '@shared/schemas'

/**
 * Spec sections 6.2 and 7.2 print `<64 lowercase hex characters>` where a
 * checksum belongs. That placeholder is prose, not a value, and cannot satisfy
 * the `^[a-f0-9]{64}$` pattern plan Task 1.2 makes mandatory, so the examples
 * below use a real digest everywhere the spec wrote the placeholder. Every
 * other field is the spec example verbatim.
 */
const SPEC_SHA256 = '0123456789abcdef'.repeat(4)

/** The job.json example from spec section 6.2. */
const SPEC_JOB_PACKET = {
  schemaVersion: 1,
  jobId: '2026-09-28-richard-nixon-001',
  createdAt: '2026-09-28T10:00:00Z',
  executor: {
    kind: 'codex-cli',
    minimumVersion: '0.158.0',
    imageTool: 'image_gen'
  },
  subject: {
    name: 'Richard Nixon',
    description: 'Chibi historical character portrait',
    pose: 'Full body, standing upright',
    expression: 'Serious, no smile',
    notes: 'Clear silhouette'
  },
  references: [
    {
      label: 'Image A',
      role: 'style',
      path: 'inputs/style.png',
      originalName: 'master-style.png',
      mimeType: 'image/png',
      sizeBytes: 1834022,
      sha256: SPEC_SHA256,
      note: 'Rough black outline, muted color and warm paper texture'
    },
    {
      label: 'Image B',
      role: 'identity',
      path: 'inputs/identity.jpg',
      originalName: 'nixon-front.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 412880,
      sha256: SPEC_SHA256,
      note: 'Preserve facial structure, hairline and age cues'
    }
  ],
  output: {
    aspectRatio: '3:4',
    background: 'pale warm paper',
    format: 'png',
    count: 1
  },
  source: {
    preset: 'chibi-master-v1',
    anchor: 'nixon-v1'
  },
  promptPath: 'prompt.md',
  promptSha256: SPEC_SHA256
}

/** The codex-result.json example from spec section 7.1. */
const SPEC_CODEX_RESULT = {
  schemaVersion: 1,
  jobId: '2026-09-28-richard-nixon-001',
  status: 'succeeded',
  outputs: [{ path: 'outputs/001.png' }],
  error: null
}

/** The result.json example from spec section 7.2. */
const SPEC_RESULT = {
  schemaVersion: 1,
  jobId: '2026-09-28-richard-nixon-001',
  status: 'succeeded',
  startedAt: '2026-09-28T10:00:02Z',
  completedAt: '2026-09-28T10:01:12Z',
  executor: {
    codexVersion: '0.158.0',
    executable:
      'C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex-x86_64-pc-windows-msvc.exe',
    exitCode: 0,
    signal: null
  },
  outputs: [
    {
      path: 'outputs/001.png',
      mimeType: 'image/png',
      width: 1024,
      height: 1365,
      sizeBytes: 1522311,
      sha256: SPEC_SHA256
    }
  ],
  warnings: [],
  promptPath: 'prompt.md',
  error: null
}

const REFERENCE_ID = '3f1e8a2c-5b6d-4c7e-9a01-2b3c4d5e6f70'

const BUILDER_STATE = {
  schemaVersion: 1,
  subject: {
    name: 'Richard Nixon',
    description: 'Chibi historical character portrait'
  },
  references: [
    {
      referenceId: REFERENCE_ID,
      role: 'identity',
      originalName: 'nixon-front.jpg',
      displayPath: '…/references/nixon-front.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 412880,
      width: 900,
      height: 1200,
      sha256: SPEC_SHA256,
      note: 'Preserve facial structure',
      missing: false
    }
  ],
  output: {
    aspectRatio: '3:4',
    background: 'pale warm paper',
    format: 'png',
    count: 1
  },
  negativeConstraints: ['no text', 'no watermark'],
  source: { preset: 'chibi-master-v1', anchor: null }
}

const DRAFT = {
  schemaVersion: 1,
  savedAt: '2026-09-28T09:58:00Z',
  state: BUILDER_STATE,
  referencePaths: { [REFERENCE_ID]: 'C:\\refs\\nixon-front.jpg' }
}

const PRESET = {
  schemaVersion: 1,
  id: 'chibi-master-v1',
  name: 'Chibi master',
  createdAt: '2026-09-01T08:00:00Z',
  updatedAt: '2026-09-20T08:00:00Z',
  styleReference: {
    path: 'style.png',
    originalName: 'master-style.png',
    mimeType: 'image/png',
    sizeBytes: 1834022,
    sha256: SPEC_SHA256
  },
  roleNotes: { style: 'Rough black outline', identity: 'Keep age cues' },
  promptConventions: ['Describe the silhouette first'],
  negativeConstraints: ['no text'],
  composition: { notes: 'Clear silhouette' },
  output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png' }
}

const ANCHOR = {
  schemaVersion: 1,
  id: 'nixon',
  name: 'Richard Nixon',
  version: 1,
  createdAt: '2026-09-28T11:00:00Z',
  identityReference: {
    path: 'identity.jpg',
    originalName: 'nixon-front.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 412880,
    sha256: SPEC_SHA256
  },
  approvedOutput: null,
  identityDescription: 'Square jaw, receding hairline, late fifties',
  immutableTraits: ['hairline', 'jaw line'],
  mutableTraits: ['outfit', 'equipment', 'pose', 'expression'],
  sourceJobId: '2026-09-28-richard-nixon-001'
}

const SETTINGS = { schemaVersion: 1, codexExecutable: null }

describe('spec examples', () => {
  it('uses a checksum that really is 64 lowercase hex characters', () => {
    expect(SPEC_SHA256).toHaveLength(64)
    expect(SHA256_REGEX.test(SPEC_SHA256)).toBe(true)
  })

  it('parses the job.json example of spec section 6.2', () => {
    expect(JobPacketSchema.parse(SPEC_JOB_PACKET)).toEqual(SPEC_JOB_PACKET)
  })

  it('parses the codex-result.json example of spec section 7.1', () => {
    expect(CodexResultSchema.parse(SPEC_CODEX_RESULT)).toEqual(SPEC_CODEX_RESULT)
  })

  it('parses the result.json example of spec section 7.2', () => {
    expect(ResultSchema.parse(SPEC_RESULT)).toEqual(SPEC_RESULT)
  })
})

describe('strictness', () => {
  const samples = [
    ['JobPacket', JobPacketSchema, SPEC_JOB_PACKET],
    ['CodexResult', CodexResultSchema, SPEC_CODEX_RESULT],
    ['Result', ResultSchema, SPEC_RESULT],
    ['Preset', PresetSchema, PRESET],
    ['Anchor', AnchorSchema, ANCHOR],
    ['Draft', DraftSchema, DRAFT],
    ['BuilderState', BuilderStateSchema, BUILDER_STATE],
    ['Settings', SettingsSchema, SETTINGS]
  ] as const

  it.each(samples)('%s parses its example', (_name, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true)
  })

  it.each(samples)('%s rejects an unknown key', (_name, schema, sample) => {
    expect(schema.safeParse({ ...sample, surprise: 'nope' }).success).toBe(false)
  })

  // Spec section 6: job.json is written once and holds no run state.
  it('rejects a job.json that carries a status field', () => {
    const result = JobPacketSchema.safeParse({ ...SPEC_JOB_PACKET, status: 'running' })

    expect(result.success).toBe(false)
  })

  it('rejects a nested unknown key inside job.json', () => {
    const withExtra = {
      ...SPEC_JOB_PACKET,
      subject: { ...SPEC_JOB_PACKET.subject, mood: 'grumpy' }
    }

    expect(JobPacketSchema.safeParse(withExtra).success).toBe(false)
  })
})

describe('job id and checksum constraints', () => {
  it.each([
    ['../etc/passwd', 'traversal'],
    ['2026-09-28-Richard-Nixon-001', 'uppercase'],
    ['2026-09-28-richard nixon-001', 'whitespace'],
    ['2026-09-28--001', 'empty slug'],
    ['2026-09-28-richard-nixon-1', 'short sequence'],
    ['2026-09-28-richard-nixon-001/../..', 'trailing traversal']
  ])('rejects job id %s (%s)', (jobId) => {
    expect(JobPacketSchema.safeParse({ ...SPEC_JOB_PACKET, jobId }).success).toBe(false)
  })

  it.each([
    ['0123456789ABCDEF'.repeat(4), 'uppercase hex'],
    ['0123456789abcdef'.repeat(3), 'too short'],
    ['<64 lowercase hex characters>', 'the spec placeholder itself']
  ])('rejects promptSha256 %s (%s)', (promptSha256) => {
    expect(JobPacketSchema.safeParse({ ...SPEC_JOB_PACKET, promptSha256 }).success).toBe(false)
  })
})

describe('path constraints', () => {
  function withReferencePath(path: string): unknown {
    const [first, ...rest] = SPEC_JOB_PACKET.references

    return { ...SPEC_JOB_PACKET, references: [{ ...first, path }, ...rest] }
  }

  it.each([
    'inputs/style.gif',
    'inputs/../style.png',
    '../inputs/style.png',
    'inputs/nested/style.png',
    'inputs/background.png',
    'C:\\inputs\\style.png',
    'outputs/001.png'
  ])('rejects reference path %s', (path) => {
    expect(JobPacketSchema.safeParse(withReferencePath(path)).success).toBe(false)
  })

  it.each(['inputs/style.png', 'inputs/identity.jpg', 'inputs/equipment.webp'])(
    'accepts reference path %s',
    (path) => {
      expect(JobPacketSchema.safeParse(withReferencePath(path)).success).toBe(true)
    }
  )

  function withOutputPath(path: string): unknown {
    const [first, ...rest] = SPEC_RESULT.outputs

    return { ...SPEC_RESULT, outputs: [{ ...first, path }, ...rest] }
  }

  it.each([
    'outputs/../secret.png',
    '../outputs/001.png',
    'outputs/nested/001.png',
    'outputs/001.gif',
    'outputs/001',
    '001.png'
  ])('rejects output path %s', (path) => {
    expect(ResultSchema.safeParse(withOutputPath(path)).success).toBe(false)
  })

  it.each(['outputs/001.png', 'outputs/nixon_final-2.webp', 'outputs/a.jpg'])(
    'accepts output path %s',
    (path) => {
      expect(ResultSchema.safeParse(withOutputPath(path)).success).toBe(true)
    }
  )
})

describe('codex-result.json error codes', () => {
  it.each(CODEX_ERROR_CODES)('accepts %s', (code) => {
    const failed = {
      ...SPEC_CODEX_RESULT,
      status: 'failed',
      outputs: [],
      error: { code, message: 'image_gen is not available in this session' }
    }

    expect(CodexResultSchema.safeParse(failed).success).toBe(true)
  })

  // Spec section 7.1: any other code is INVALID_RESULT as far as main is
  // concerned, so the executor schema must not accept it.
  it.each(['CODEX_NOT_FOUND', 'INVALID_RESULT', 'CANCELLED', 'INTERRUPTED', 'BOOM'])(
    'rejects %s',
    (code) => {
      const failed = {
        ...SPEC_CODEX_RESULT,
        status: 'failed',
        outputs: [],
        error: { code, message: 'nope' }
      }

      expect(CodexResultSchema.safeParse(failed).success).toBe(false)
    }
  )

  it('rejects a run state as a codex-result status', () => {
    expect(CodexResultSchema.safeParse({ ...SPEC_CODEX_RESULT, status: 'running' }).success).toBe(
      false
    )
  })
})

describe('result.json', () => {
  it.each(RESULT_ERROR_CODES)('accepts error code %s', (code) => {
    const failed = {
      ...SPEC_RESULT,
      status: 'failed',
      outputs: [],
      error: { code, message: 'Codex CLI was not found' }
    }

    expect(ResultSchema.safeParse(failed).success).toBe(true)
  })

  // Plan Task 3.7: a preflight failure still writes result.json, and then
  // there is no version, no executable, no exit code and no signal.
  it('accepts an executor with nothing resolved', () => {
    const preflightFailure = {
      ...SPEC_RESULT,
      status: 'failed',
      executor: { codexVersion: null, executable: null, exitCode: null, signal: null },
      outputs: [],
      error: { code: 'CODEX_NOT_FOUND', message: 'Codex CLI was not found' }
    }

    expect(ResultSchema.safeParse(preflightFailure).success).toBe(true)
  })

  it.each(TERMINAL_RUN_STATES)('accepts terminal status %s', (status) => {
    expect(ResultSchema.safeParse({ ...SPEC_RESULT, status }).success).toBe(true)
  })

  it.each(['queued', 'preflight', 'running', 'verifying'])(
    'rejects non-terminal status %s',
    (status) => {
      expect(ResultSchema.safeParse({ ...SPEC_RESULT, status }).success).toBe(false)
    }
  )
})

describe('builder state', () => {
  // Spec section 11 and plan decision Q3: the renderer holds opaque handles.
  it('rejects a reference that carries a filesystem path', () => {
    const [first, ...rest] = BUILDER_STATE.references
    const leaky = {
      ...BUILDER_STATE,
      references: [{ ...first, path: 'C:\\refs\\nixon-front.jpg' }, ...rest]
    }

    expect(BuilderStateSchema.safeParse(leaky).success).toBe(false)
  })

  it('rejects a reference id that is not a uuid', () => {
    const [first, ...rest] = BUILDER_STATE.references
    const bad = { ...BUILDER_STATE, references: [{ ...first, referenceId: '../x' }, ...rest] }

    expect(BuilderStateSchema.safeParse(bad).success).toBe(false)
  })

  // Plan Task 5.1 derives the builder `invalid` state from this parse.
  it('rejects an empty subject name', () => {
    const nameless = { ...BUILDER_STATE, subject: { ...BUILDER_STATE.subject, name: '' } }

    expect(BuilderStateSchema.safeParse(nameless).success).toBe(false)
  })

  it('rejects more references than there are roles', () => {
    const [first] = BUILDER_STATE.references
    const tooMany = { ...BUILDER_STATE, references: Array.from({ length: 6 }, () => first) }

    expect(BuilderStateSchema.safeParse(tooMany).success).toBe(false)
  })
})
