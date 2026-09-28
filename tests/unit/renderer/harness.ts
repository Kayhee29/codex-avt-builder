/**
 * Shared scaffolding for the renderer tests (plan Task 5.1).
 *
 * The renderer only ever reaches the outside world through `window.studio`, so
 * a renderer test only ever needs that one fake. It is built by walking
 * `IPC_CHANNEL_NAMES`, which means a channel added to the contract is faked
 * automatically and, more importantly, that a test can assert something about
 * *every* channel — "editing the form called nothing but `draft.save`" is a
 * claim over the whole contract rather than over a hand-written list.
 *
 * Nothing here touches Electron; the tests run in jsdom.
 */
import { vi, type Mock } from 'vitest'

import {
  IPC_CHANNEL_NAMES,
  IPC_CHANNELS,
  type AnchorEntry,
  type IpcChannelName,
  type IpcResult,
  type JobSummary,
  type PresetEntry
} from '@shared/ipc-contract'
import type { ProgressEvent } from '@shared/progress'
import type { ReferenceRole } from '@shared/reference-roles'
import {
  SCHEMA_VERSION,
  type Anchor,
  type BuilderReference,
  type BuilderState,
  type Preset
} from '@shared/schemas'
import { DEFAULT_OUTPUT_REQUEST } from '@shared/anchor'

import { STUDIO_GLOBAL } from '../../../src/renderer/bridge.ts'

/** Every channel, each one a `vi.fn()` the test can inspect or re-program. */
export type ChannelMocks = Record<IpcChannelName, Mock>

export interface FakeBridge {
  /** The object installed as `window.studio`. */
  readonly api: Record<IpcChannelName, Mock>
  /** The same functions, for assertions such as `toHaveBeenCalledTimes`. */
  readonly channels: ChannelMocks
  /** Pushes a `jobs.onProgress` event to every current subscriber. */
  readonly emitProgress: (event: ProgressEvent) => void
  /** How many subscribers `jobs.onProgress` currently has. */
  readonly progressListenerCount: () => number
  /** Replaces one channel's answer. */
  readonly answer: <C extends IpcChannelName>(channel: C, result: IpcResult<unknown>) => void
}

const ISO_SAVED_AT = '2026-09-28T10:00:00.000Z'

/**
 * The answer each invoke channel gives unless a test changes it.
 *
 * A channel with no entry answers `NOT_FOUND`, so a test that reaches an
 * unplanned command sees a refusal rather than `undefined`.
 */
function defaultAnswer(channel: IpcChannelName): IpcResult<unknown> {
  switch (channel) {
    case 'dialog.selectReference':
      return { ok: true, data: { reference: null } }
    case 'draft.load':
      return { ok: true, data: { draft: null } }
    case 'draft.save':
      return { ok: true, data: { savedAt: ISO_SAVED_AT } }
    case 'jobs.list':
      return { ok: true, data: { jobs: [] } }
    case 'library.listPresets':
      return { ok: true, data: { presets: [] } }
    case 'library.listAnchors':
      return { ok: true, data: { anchors: [] } }
    default:
      return { ok: false, code: 'NOT_FOUND', message: `No fake answer for ${channel}.` }
  }
}

/** Builds the fake bridge and installs it as `window.studio`. */
export function installFakeBridge(): FakeBridge {
  const listeners = new Set<(event: ProgressEvent) => void>()
  const answers = new Map<IpcChannelName, IpcResult<unknown>>()
  const channels = {} as Record<IpcChannelName, Mock>

  for (const channel of IPC_CHANNEL_NAMES) {
    channels[channel] =
      IPC_CHANNELS[channel].kind === 'event'
        ? vi.fn((listener: (event: ProgressEvent) => void) => {
            listeners.add(listener)

            return (): void => {
              listeners.delete(listener)
            }
          })
        : vi.fn(async () => answers.get(channel) ?? defaultAnswer(channel))
  }

  const bridge: FakeBridge = {
    api: channels,
    channels,
    emitProgress: (event: ProgressEvent): void => {
      for (const listener of [...listeners]) {
        listener(event)
      }
    },
    progressListenerCount: (): number => listeners.size,
    answer: (channel, result): void => {
      answers.set(channel, result)
    }
  }

  vi.stubGlobal(STUDIO_GLOBAL, channels)

  return bridge
}

/** Every channel except the ones named, for "nothing else was called" checks. */
export function channelsOtherThan(...allowed: readonly IpcChannelName[]): IpcChannelName[] {
  return IPC_CHANNEL_NAMES.filter((channel) => !allowed.includes(channel))
}

const REFERENCE_IDS: Record<ReferenceRole, string> = {
  style: '00000000-0000-4000-8000-000000000001',
  identity: '00000000-0000-4000-8000-000000000002',
  outfit: '00000000-0000-4000-8000-000000000003',
  equipment: '00000000-0000-4000-8000-000000000004',
  extra: '00000000-0000-4000-8000-000000000005'
}

/**
 * A reference handle shaped exactly like the one `dialog.selectReference`
 * returns, including the two fields the renderer must never send back.
 */
export function makeReference(
  role: ReferenceRole,
  overrides: Partial<BuilderReference> = {}
): BuilderReference {
  return {
    referenceId: REFERENCE_IDS[role],
    role,
    originalName: `${role}.png`,
    displayPath: `…\\references\\${role}.png`,
    thumbnail: 'data:image/png;base64,AAAA',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 512,
    height: 512,
    sha256: 'a'.repeat(64),
    missing: false,
    ...overrides
  }
}

/** A state that satisfies `BuilderStateSchema`, so the store reports it valid. */
export function makeValidState(overrides: Partial<BuilderState> = {}): BuilderState {
  return {
    schemaVersion: SCHEMA_VERSION,
    subject: { name: 'Nguyễn Văn A', description: 'Nam, ngoài 50 tuổi, tóc bạc hai bên' },
    references: [],
    output: { ...DEFAULT_OUTPUT_REQUEST },
    negativeConstraints: [],
    source: { preset: null, anchor: null },
    ...overrides
  }
}

/**
 * A preset entry as `library.listPresets` answers with one: the metadata plus
 * the handle for the style image main copied next to it (plan decision Q18).
 */
export function makePresetEntry(
  overrides: Partial<Preset> = {},
  styleReference: BuilderReference | null = null
): PresetEntry {
  return {
    preset: {
      schemaVersion: SCHEMA_VERSION,
      id: 'chibi-master-v1',
      name: 'Chibi master',
      createdAt: ISO_SAVED_AT,
      updatedAt: ISO_SAVED_AT,
      styleReference: null,
      roleNotes: {},
      promptConventions: [],
      negativeConstraints: [],
      composition: {},
      output: { aspectRatio: '3:4', background: 'giấy ấm', format: 'png' },
      ...overrides
    },
    styleReference
  }
}

/** One anchor version with the handle for its identity image (decision Q18). */
export function makeAnchorEntry(
  overrides: Partial<Anchor> = {},
  identityReference: BuilderReference | null = makeReference('identity')
): AnchorEntry {
  return {
    anchor: {
      schemaVersion: SCHEMA_VERSION,
      id: 'nguyen-van-a',
      name: 'Nguyễn Văn A',
      version: 1,
      createdAt: ISO_SAVED_AT,
      identityReference: {
        path: 'identity.png',
        originalName: 'identity.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64)
      },
      approvedOutput: null,
      identityDescription: 'Nam, ngoài 50 tuổi, tóc bạc hai bên',
      immutableTraits: [],
      mutableTraits: [],
      sourceJobId: null,
      ...overrides
    },
    identityReference
  }
}

/** A recent-jobs row with everything but the fields a test cares about filled. */
export function makeJobSummary(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    jobId: '2026-09-28-nguyen-van-a-001',
    subjectName: 'Nguyễn Văn A',
    state: 'succeeded',
    createdAt: ISO_SAVED_AT,
    completedAt: ISO_SAVED_AT,
    preset: null,
    anchor: null,
    outputCount: 1,
    errorCode: null,
    warnings: [],
    thumbnailDataUrl: null,
    ...overrides
  }
}

/** A progress event with everything but the fields a test cares about filled. */
export function makeProgress(overrides: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    jobId: '2026-09-28-nguyen-van-a-001',
    state: 'running',
    seq: 1,
    at: ISO_SAVED_AT,
    ...overrides
  }
}
