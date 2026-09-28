/**
 * The preload allowlist (plan Task 4.1, spec sections 8 and 11).
 *
 * Two things are under test and both are structural rather than sampled: that
 * `window.studio` carries exactly the channels of `src/shared/ipc-contract.ts`,
 * and that nothing reachable through it hands the renderer an `ipcRenderer` or
 * anything else that could send on an unlisted channel.
 *
 * The comparison is against `IPC_CHANNEL_NAMES`, never against a list written
 * out here: a channel added to the contract and forgotten in the preload has to
 * fail this file.
 */
import { contextBridge } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IPC_CHANNEL_NAMES,
  IPC_CHANNELS,
  IpcErrorSchema,
  ipcResultSchema,
  type IpcChannelName
} from '@shared/ipc-contract'
import { ProgressEventSchema, type ProgressEvent } from '@shared/progress'

import {
  createStudioApi,
  STUDIO_GLOBAL,
  type PreloadIpc,
  type StudioApi
} from '../../src/preload/index.ts'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

/**
 * What importing the preload did, captured before vitest can clear the mock
 * between tests: the bridge is installed once, at module load, and that call is
 * the thing under test here.
 */
const EXPOSED: readonly unknown[][] = vi
  .mocked(contextBridge.exposeInMainWorld)
  .mock.calls.map((call) => [...call])

const JOB_ID = '2026-09-28-richard-nixon-001'

const PROGRESS_EVENT: ProgressEvent = {
  jobId: JOB_ID,
  state: 'running',
  activity: 'Đang gọi image_gen',
  seq: 7,
  at: '2026-09-28T10:00:40Z'
}

interface Sent {
  readonly channel: string
  readonly request: unknown
}

/** An `ipcRenderer` stand-in that records what the bridge did with it. */
class FakeIpc implements PreloadIpc {
  readonly sent: Sent[] = []
  readonly listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>()
  answer: unknown = { ok: true, data: {} }

  async invoke(channel: string, request: unknown): Promise<unknown> {
    this.sent.push({ channel, request })

    return this.answer
  }

  on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    const set = this.listeners.get(channel) ?? new Set()

    set.add(listener)
    this.listeners.set(channel, set)
  }

  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void {
    this.listeners.get(channel)?.delete(listener)
  }

  /** Delivers one main-process event, the way `ipcRenderer` would. */
  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) {
      listener({ sender: 'the renderer must never see this' }, payload)
    }
  }
}

let ipc: FakeIpc
let api: StudioApi

beforeEach(() => {
  ipc = new FakeIpc()
  api = createStudioApi(ipc)
})

/** The invoke channels, taken from the contract rather than listed by hand. */
function invokeChannels(): IpcChannelName[] {
  return IPC_CHANNEL_NAMES.filter((name) => IPC_CHANNELS[name].kind === 'invoke')
}

function command(name: IpcChannelName): (request?: unknown) => Promise<unknown> {
  const untyped = api as unknown as Record<string, (request?: unknown) => Promise<unknown>>
  const fn = untyped[name]

  if (fn === undefined) {
    throw new Error(`The preload exposes no ${name}.`)
  }

  return fn
}

describe('the exposed surface', () => {
  it('has exactly the channels of the IPC contract, no more and no less', () => {
    expect(Object.keys(api).sort()).toEqual([...IPC_CHANNEL_NAMES].sort())
  })

  it('exposes every channel as a function', () => {
    for (const name of IPC_CHANNEL_NAMES) {
      expect(typeof command(name)).toBe('function')
    }
  })

  it('is frozen, so the renderer cannot add a channel of its own', () => {
    expect(Object.isFrozen(api)).toBe(true)
  })

  it('is what the preload hands to contextBridge, under one global name', () => {
    expect(EXPOSED).toHaveLength(1)
    expect(EXPOSED[0]?.[0]).toBe(STUDIO_GLOBAL)
    expect(STUDIO_GLOBAL).toBe('studio')
    expect(Object.keys(EXPOSED[0]?.[1] as object).sort()).toEqual([...IPC_CHANNEL_NAMES].sort())
  })
})

describe('nothing hands back a raw ipcRenderer (spec section 11)', () => {
  /** The method names that would let the renderer talk on any channel. */
  const CAPABILITY_NAMES = ['invoke', 'send', 'sendSync', 'sendTo', 'postMessage', 'on', 'once']

  it('exposes values that are plain functions and nothing else', () => {
    expect(Object.getPrototypeOf(api)).toBe(Object.prototype)

    for (const value of Object.values(api)) {
      expect(typeof value).toBe('function')
      expect(Object.keys(value as object)).toEqual([])

      for (const key of CAPABILITY_NAMES) {
        expect((value as unknown as Record<string, unknown>)[key]).toBeUndefined()
      }
    }
  })

  it('returns a bare unsubscribe function from the event channel', () => {
    const unsubscribe = api['jobs.onProgress'](() => {})

    expect(typeof unsubscribe).toBe('function')

    for (const key of CAPABILITY_NAMES) {
      expect((unsubscribe as unknown as Record<string, unknown>)[key]).toBeUndefined()
    }

    unsubscribe()
  })
})

describe('requests are validated before invoke', () => {
  it('refuses a request no channel could accept, without touching ipcRenderer', async () => {
    for (const name of invokeChannels()) {
      const answer = await command(name)({ definitelyNotAField: 1 })

      expect(IpcErrorSchema.safeParse(answer).success).toBe(true)
      expect(answer).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }

    expect(ipc.sent).toEqual([])
  })

  it('names the offending field and never its value', async () => {
    const answer = (await command('jobs.get')({ jobId: '../etc/passwd' })) as {
      message: string
    }

    expect(answer.message).toContain('jobs.get')
    expect(answer.message).toContain('jobId')
    expect(answer.message).not.toContain('passwd')
  })

  it('sends a valid request through on the channel of the same name', async () => {
    ipc.answer = { ok: true, data: { job: {}, result: null, references: [] } }

    await command('jobs.get')({ jobId: JOB_ID })

    expect(ipc.sent).toEqual([{ channel: 'jobs.get', request: { jobId: JOB_ID } }])
  })

  it('lets a channel that takes no arguments be called with none', async () => {
    ipc.answer = { ok: true, data: { draft: null } }

    const answer = await api['draft.load']()

    expect(ipc.sent).toEqual([{ channel: 'draft.load', request: {} }])
    expect(ipcResultSchema(IPC_CHANNELS['draft.load'].response).safeParse(answer).success).toBe(
      true
    )
  })

  it('passes the main process answer through untouched', async () => {
    ipc.answer = { ok: false, code: 'ALREADY_RUNNING', message: 'A job is already running.' }

    expect(await api['jobs.cancel']({ jobId: JOB_ID })).toEqual(ipc.answer)
  })

  it('refuses a job ID that could escape the workspace before it reaches main', async () => {
    for (const jobId of ['../etc', '2026-09-28-nixon-001/../x', '']) {
      expect(await api['jobs.cancel']({ jobId })).toMatchObject({ code: 'INVALID_REQUEST' })
    }

    expect(ipc.sent).toEqual([])
  })
})

describe('jobs.onProgress', () => {
  it('subscribes on the contract channel and never invokes anything', () => {
    const unsubscribe = api['jobs.onProgress'](() => {})

    expect([...ipc.listeners.keys()]).toEqual(['jobs.onProgress'])
    expect(ipc.sent).toEqual([])

    unsubscribe()
  })

  it('hands the listener the payload alone, never the IpcRendererEvent', () => {
    const seen: ProgressEvent[] = []
    const unsubscribe = api['jobs.onProgress']((event) => seen.push(event))

    ipc.emit('jobs.onProgress', PROGRESS_EVENT)

    expect(seen).toEqual([PROGRESS_EVENT])
    expect(ProgressEventSchema.safeParse(seen[0]).success).toBe(true)

    unsubscribe()
  })

  it('drops a payload that is not a ProgressEvent instead of passing it on', () => {
    const seen: ProgressEvent[] = []
    const unsubscribe = api['jobs.onProgress']((event) => seen.push(event))

    ipc.emit('jobs.onProgress', { jobId: '../escape', state: 'running', seq: 0, at: 'now' })
    ipc.emit('jobs.onProgress', { ...PROGRESS_EVENT, state: 'loading' })
    ipc.emit('jobs.onProgress', 'not an object')
    ipc.emit('jobs.onProgress', PROGRESS_EVENT)

    expect(seen).toEqual([PROGRESS_EVENT])

    unsubscribe()
  })

  it('stops calling the listener once the unsubscribe function has run', () => {
    let calls = 0
    const unsubscribe = api['jobs.onProgress'](() => {
      calls += 1
    })

    ipc.emit('jobs.onProgress', PROGRESS_EVENT)
    unsubscribe()
    ipc.emit('jobs.onProgress', PROGRESS_EVENT)

    expect(calls).toBe(1)
    expect(ipc.listeners.get('jobs.onProgress')?.size).toBe(0)
  })

  it('keeps two subscribers independent', () => {
    const first: ProgressEvent[] = []
    const second: ProgressEvent[] = []
    const stopFirst = api['jobs.onProgress']((event) => first.push(event))
    const stopSecond = api['jobs.onProgress']((event) => second.push(event))

    ipc.emit('jobs.onProgress', PROGRESS_EVENT)
    stopFirst()
    ipc.emit('jobs.onProgress', { ...PROGRESS_EVENT, seq: 8 })
    stopSecond()

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(2)
  })
})
