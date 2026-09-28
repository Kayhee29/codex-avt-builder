import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  BuilderReferenceInputSchema,
  BuilderStateInputSchema,
  IPC_CHANNEL_NAMES,
  IPC_CHANNELS,
  IpcErrorSchema,
  ipcResultSchema,
  PreflightResultSchema,
  type IpcChannelName
} from '@shared/ipc-contract'
import {
  isTerminalRunState,
  ProgressEventSchema,
  RUN_STATES,
  TERMINAL_RUN_STATES
} from '@shared/progress'
import { ResultStatusSchema } from '@shared/schemas'

/** Spec section 8, verbatim and in order. */
const SPEC_CHANNELS = [
  'dialog.selectReference',
  'draft.load',
  'draft.save',
  'library.listPresets',
  'library.savePreset',
  'library.listAnchors',
  'library.saveAnchor',
  'jobs.list',
  'jobs.get',
  'jobs.generate',
  'jobs.cancel',
  'jobs.openFolder',
  'jobs.onProgress'
] as const

/** The four channels plan decision Q7 adds, and nothing else. */
const Q7_CHANNELS = [
  'system.preflight',
  'system.getSettings',
  'system.setSettings',
  'library.deletePreset'
] as const

// ---------------------------------------------------------------------------
// A walker over the request schemas
// ---------------------------------------------------------------------------

/**
 * The parts of a zod definition this audit reads. zod exposes `.def` with a
 * `type` discriminator; going through it means the audit sees the real schema
 * tree rather than a list of field names kept by hand.
 */
interface ZodInternals {
  readonly type: string
  readonly shape?: Readonly<Record<string, z.ZodType>>
  readonly catchall?: z.ZodType
  readonly element?: z.ZodType
  readonly innerType?: z.ZodType
  readonly options?: readonly z.ZodType[]
  readonly keyType?: z.ZodType
  readonly valueType?: z.ZodType
}

function internals(schema: z.ZodType): ZodInternals {
  return schema.def as unknown as ZodInternals
}

function required(schema: z.ZodType | undefined, path: string): z.ZodType {
  if (schema === undefined) {
    throw new Error(`Expected an inner schema at ${path}.`)
  }

  return schema
}

interface Audit {
  /** Every field reachable in a request, as `<channel>.<a>.<b>`. */
  readonly fields: { readonly path: string; readonly name: string }[]
  /** Objects that would accept unknown keys. */
  readonly looseObjects: string[]
}

/** Leaf types carry no further field names. */
const LEAF_TYPES = new Set(['string', 'number', 'boolean', 'bigint', 'date', 'enum', 'literal'])

function walk(schema: z.ZodType, path: string, audit: Audit): void {
  const node = internals(schema)

  switch (node.type) {
    case 'object': {
      if (node.catchall === undefined || internals(node.catchall).type !== 'never') {
        audit.looseObjects.push(path)
      }

      for (const [key, value] of Object.entries(node.shape ?? {})) {
        audit.fields.push({ path: `${path}.${key}`, name: key })
        walk(value, `${path}.${key}`, audit)
      }

      return
    }

    case 'array':
      walk(required(node.element, path), `${path}[]`, audit)

      return

    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'nonoptional':
    case 'default':
      walk(required(node.innerType, path), path, audit)

      return

    case 'union':
      for (const [index, option] of (node.options ?? []).entries()) {
        walk(option, `${path}|${String(index)}`, audit)
      }

      return

    case 'record':
      walk(required(node.keyType, path), `${path}{key}`, audit)
      walk(required(node.valueType, path), `${path}{value}`, audit)

      return

    default:
      if (LEAF_TYPES.has(node.type)) {
        return
      }

      // Refusing to skip an unknown wrapper is the point: a new zod type must
      // be taught to this walker before it can hide fields from the audit.
      throw new Error(
        `The IPC request audit does not understand the zod type "${node.type}" at ${path}.`
      )
  }
}

function auditRequests(): Audit {
  const audit: Audit = { fields: [], looseObjects: [] }

  for (const name of IPC_CHANNEL_NAMES) {
    walk(IPC_CHANNELS[name].request, name, audit)
  }

  return audit
}

/**
 * Words that mean "this is a path, a working directory, a command line or an
 * executable" (spec section 11). `displayPath` is caught by `path`, and a
 * camel-cased name is split before the comparison.
 */
const FORBIDDEN_FIELD_WORDS = new Set([
  'arg',
  'args',
  'argv',
  'argument',
  'arguments',
  'binary',
  'cmd',
  'command',
  'cwd',
  'dir',
  'directory',
  'env',
  'environment',
  'exe',
  'executable',
  'file',
  'filename',
  'filepath',
  'folder',
  'launcher',
  'path',
  'paths',
  'script',
  'shell',
  'uri',
  'url'
])

/**
 * The one exception spec section 11 allows: the user's own override for the
 * Codex executable, which plan decision Q7 makes the only writable setting.
 * Adding a second entry here has to be a deliberate, reviewable act.
 */
const ALLOWED_PATH_LIKE_FIELDS = ['system.setSettings.patch.codexExecutable']

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
}

function isPathLike(name: string): boolean {
  return words(name).some((word) => FORBIDDEN_FIELD_WORDS.has(word))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('channel list', () => {
  it('covers every channel of spec section 8 plus plan decision Q7, and nothing else', () => {
    expect([...IPC_CHANNEL_NAMES].sort()).toEqual([...SPEC_CHANNELS, ...Q7_CHANNELS].sort())
  })

  it('gives every channel a request schema and a response schema', () => {
    for (const name of IPC_CHANNEL_NAMES) {
      const channel = IPC_CHANNELS[name]

      expect(typeof channel.request.safeParse).toBe('function')
      expect(typeof channel.response.safeParse).toBe('function')
      expect(['invoke', 'event']).toContain(channel.kind)
    }
  })

  it('has one event channel, jobs.onProgress, carrying a ProgressEvent', () => {
    const events = IPC_CHANNEL_NAMES.filter((name) => IPC_CHANNELS[name].kind === 'event')

    expect(events).toEqual(['jobs.onProgress'])
    expect(IPC_CHANNELS['jobs.onProgress'].response).toBe(ProgressEventSchema)
  })
})

describe('no raw paths from the renderer (spec section 11)', () => {
  const audit = auditRequests()

  it('reaches the fields it is meant to audit', () => {
    const paths = audit.fields.map((field) => field.path)

    expect(paths).toContain('jobs.generate.state.subject.name')
    expect(paths).toContain('jobs.generate.state.references[].referenceId')
    expect(paths).toContain('library.saveAnchor.anchor.approvedOutput.jobId')
    expect(paths.length).toBeGreaterThan(40)
  })

  it('accepts no path, cwd, argv, command or executable field except the one in Settings', () => {
    const flagged = audit.fields
      .filter((field) => isPathLike(field.name))
      .map((field) => field.path)

    expect(flagged).toEqual(ALLOWED_PATH_LIKE_FIELDS)
  })

  it('whitelists exactly one field, codexExecutable of system.setSettings', () => {
    expect(ALLOWED_PATH_LIKE_FIELDS).toHaveLength(1)
    expect(ALLOWED_PATH_LIKE_FIELDS[0]).toMatch(/^system\.setSettings\..*codexExecutable$/)
  })

  it('makes every request object reject unknown keys', () => {
    expect(audit.looseObjects).toEqual([])
  })

  it('strips displayPath from the references the renderer sends back', () => {
    expect(Object.keys(BuilderReferenceInputSchema.shape)).not.toContain('displayPath')

    const reference = {
      referenceId: '11111111-1111-4111-8111-111111111111',
      role: 'identity',
      originalName: 'nixon-front.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 412880,
      width: 800,
      height: 1000,
      sha256: '0123456789abcdef'.repeat(4),
      missing: false
    }

    expect(BuilderReferenceInputSchema.safeParse(reference).success).toBe(true)
    expect(
      BuilderReferenceInputSchema.safeParse({ ...reference, displayPath: 'C:\\refs\\x.jpg' })
        .success
    ).toBe(false)
  })

  it('names an approved output by job and index instead of by file name', () => {
    const shape = Object.keys(
      (IPC_CHANNELS['library.saveAnchor'].request as z.ZodObject<{ anchor: z.ZodType }>).shape
    )

    expect(shape).toEqual(['anchor'])
    expect(
      audit.fields.map((field) => field.path).filter((path) => path.includes('approvedOutput'))
    ).toEqual([
      'library.saveAnchor.anchor.approvedOutput',
      'library.saveAnchor.anchor.approvedOutput.jobId',
      'library.saveAnchor.anchor.approvedOutput.outputIndex'
    ])
  })
})

describe('requests', () => {
  const REFERENCE_INPUT = {
    referenceId: '11111111-1111-4111-8111-111111111111',
    role: 'style' as const,
    originalName: 'master-style.png',
    mimeType: 'image/png' as const,
    sizeBytes: 1834022,
    width: 1024,
    height: 1024,
    sha256: '0123456789abcdef'.repeat(4),
    missing: false
  }

  const STATE_INPUT = {
    schemaVersion: 1 as const,
    subject: { name: 'Richard Nixon', description: 'Chibi historical character portrait' },
    references: [REFERENCE_INPUT],
    output: { aspectRatio: '3:4', background: 'pale warm paper', format: 'png' as const, count: 1 },
    negativeConstraints: ['no text'],
    source: { preset: 'chibi-master-v1', anchor: 'nixon' }
  }

  it('accepts a jobs.generate request carrying the previewed prompt checksum', () => {
    const request = {
      state: STATE_INPUT,
      promptSha256: '0123456789abcdef'.repeat(4)
    }

    expect(IPC_CHANNELS['jobs.generate'].request.safeParse(request).success).toBe(true)
  })

  it('rejects a jobs.generate request without the checksum', () => {
    expect(IPC_CHANNELS['jobs.generate'].request.safeParse({ state: STATE_INPUT }).success).toBe(
      false
    )
  })

  it('rejects a job ID that could escape the workspace', () => {
    for (const jobId of ['../etc', '2026-09-28-richard-nixon-001/../x', 'nixon']) {
      expect(IPC_CHANNELS['jobs.get'].request.safeParse({ jobId }).success).toBe(false)
    }

    expect(
      IPC_CHANNELS['jobs.get'].request.safeParse({ jobId: '2026-09-28-richard-nixon-001' }).success
    ).toBe(true)
  })

  it('accepts only the five roles on dialog.selectReference', () => {
    expect(
      IPC_CHANNELS['dialog.selectReference'].request.safeParse({ role: 'style' }).success
    ).toBe(true)
    expect(
      IPC_CHANNELS['dialog.selectReference'].request.safeParse({ role: 'background' }).success
    ).toBe(false)
  })

  it('takes no arguments where spec section 8 takes none', () => {
    for (const name of ['draft.load', 'library.listPresets', 'library.listAnchors', 'jobs.list']) {
      const request = IPC_CHANNELS[name as IpcChannelName].request

      expect(request.safeParse({}).success).toBe(true)
      expect(request.safeParse({ filter: 'all' }).success).toBe(false)
    }
  })

  it('lets system.setSettings carry only codexExecutable', () => {
    const request = IPC_CHANNELS['system.setSettings'].request

    expect(request.safeParse({ patch: { codexExecutable: 'C:\\codex.exe' } }).success).toBe(true)
    expect(request.safeParse({ patch: { codexExecutable: null } }).success).toBe(true)
    expect(
      request.safeParse({ patch: { codexExecutable: null, workingDirectory: 'C:\\' } }).success
    ).toBe(false)
  })

  it('accepts a builder state with no references and refuses a sixth one', () => {
    expect(BuilderStateInputSchema.safeParse({ ...STATE_INPUT, references: [] }).success).toBe(true)
    expect(
      BuilderStateInputSchema.safeParse({
        ...STATE_INPUT,
        references: Array.from({ length: 6 }, () => REFERENCE_INPUT)
      }).success
    ).toBe(false)
  })
})

describe('responses', () => {
  it('wraps a success payload and carries a sanitized error otherwise', () => {
    const schema = ipcResultSchema(IPC_CHANNELS['jobs.cancel'].response)

    expect(schema.safeParse({ ok: true, data: { cancelled: true } }).success).toBe(true)
    expect(
      schema.safeParse({ ok: false, code: 'ALREADY_RUNNING', message: 'A job is already running' })
        .success
    ).toBe(true)
    expect(schema.safeParse({ ok: false, code: 'BOOM', message: 'x' }).success).toBe(false)
  })

  it('never lets an error carry a stack or a raw path field', () => {
    expect(
      IpcErrorSchema.safeParse({
        ok: false,
        code: 'IO_ERROR',
        message: 'Could not read the draft',
        stack: 'Error: ...'
      }).success
    ).toBe(false)
  })

  it('reports preflight as a version and an executable, or a code (spec section 5.3)', () => {
    expect(
      PreflightResultSchema.safeParse({
        ok: true,
        version: '0.158.0',
        executable: 'C:\\npm\\codex.exe'
      }).success
    ).toBe(true)
    expect(
      PreflightResultSchema.safeParse({
        ok: false,
        code: 'CODEX_VERSION_UNSUPPORTED',
        message: 'Codex CLI 0.27.0 is older than 0.158.0'
      }).success
    ).toBe(true)
    expect(
      PreflightResultSchema.safeParse({ ok: false, code: 'INVALID_JOB', message: 'x' }).success
    ).toBe(false)
  })
})

describe('run states (spec sections 5.5 and 12)', () => {
  const PROGRESS_EVENT = {
    jobId: '2026-09-28-richard-nixon-001',
    state: 'running',
    activity: 'Đang gọi image_gen',
    seq: 42,
    at: '2026-09-28T10:00:40Z'
  }

  it('lists the seven run states of spec section 12', () => {
    expect(RUN_STATES).toEqual([
      'queued',
      'preflight',
      'running',
      'verifying',
      'succeeded',
      'failed',
      'cancelled'
    ])
  })

  it('agrees with the status field of result.json', () => {
    expect([...TERMINAL_RUN_STATES]).toEqual([...ResultStatusSchema.options])
  })

  it('knows which states end a run', () => {
    const terminal: readonly string[] = TERMINAL_RUN_STATES

    for (const state of RUN_STATES) {
      expect(isTerminalRunState(state)).toBe(terminal.includes(state))
    }
  })

  it('parses the jobs.onProgress payload of spec section 5.5', () => {
    expect(ProgressEventSchema.parse(PROGRESS_EVENT)).toEqual(PROGRESS_EVENT)
  })

  it.each(RUN_STATES)('accepts run state %s', (state) => {
    expect(ProgressEventSchema.safeParse({ ...PROGRESS_EVENT, state }).success).toBe(true)
  })

  it('rejects an unknown run state and an unknown key', () => {
    expect(ProgressEventSchema.safeParse({ ...PROGRESS_EVENT, state: 'loading' }).success).toBe(
      false
    )
    expect(ProgressEventSchema.safeParse({ ...PROGRESS_EVENT, surprise: 1 }).success).toBe(false)
  })

  it('allows a state change with no activity text', () => {
    const { activity: _activity, ...withoutActivity } = PROGRESS_EVENT

    expect(ProgressEventSchema.safeParse({ ...withoutActivity, state: 'queued' }).success).toBe(
      true
    )
  })

  it('refuses a job ID that is not valid (spec section 6.1)', () => {
    expect(ProgressEventSchema.safeParse({ ...PROGRESS_EVENT, jobId: '../x' }).success).toBe(false)
  })
})
