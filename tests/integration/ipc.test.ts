/**
 * The main-process IPC handlers (plan Task 4.2, spec sections 8, 10 and 11).
 *
 * Every handler is driven the way `ipcMain` would drive it — a raw request in,
 * an envelope out — against the real storage, the real job orchestrator and the
 * fake Codex of plan Task 3.3. No Electron window exists anywhere in this file:
 * `ipcMain`, the web contents and the session all arrive as the structural
 * types `src/main/ipc.ts` declares.
 */
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexCommandResult, PreflightOutcome } from '../../src/main/codex-preflight.ts'
import { CodexRunner } from '../../src/main/codex-runner.ts'
import type { OpenDialogAnswer } from '../../src/main/dialog.ts'
import {
  applyContentSecurityPolicy,
  CONTENT_SECURITY_POLICY,
  CONTENT_SECURITY_POLICY_HEADER,
  createIpcHandlers,
  PROGRESS_CHANNEL,
  ProgressForwarder,
  ReconfigurablePreflight,
  registerIpcHandlers,
  UNEXPECTED_ERROR_MESSAGE,
  withContentSecurityPolicy,
  type HeadersReceivedDetails,
  type HeadersReceivedResponse,
  type InvokeChannelName,
  type IpcMainLike,
  type IpcServices,
  type SessionLike,
  type WebContentsLike
} from '../../src/main/ipc.ts'
import { JobMaterializer } from '../../src/main/job-materializer.ts'
import { JobService } from '../../src/main/jobs.ts'
import { Library } from '../../src/main/library.ts'
import { ReferenceRegistry } from '../../src/main/reference-registry.ts'
import { RESULT_FILE_NAME } from '../../src/main/result-verifier.ts'
import { SETTINGS_FILE_NAME } from '../../src/main/settings.ts'
import {
  IPC_CHANNELS,
  IPC_CHANNEL_NAMES,
  IpcErrorSchema,
  ipcResultSchema,
  type BuilderStateInput,
  type IpcChannelName,
  type IpcResult
} from '../../src/shared/ipc-contract.ts'
import { ProgressEventSchema, type ProgressEvent } from '../../src/shared/progress.ts'
import { buildPrompt, sha256Hex, type OrderedReference } from '../../src/shared/prompt-builder.ts'
import { assignReferenceLabels } from '../../src/shared/reference-roles.ts'
import {
  SCHEMA_VERSION,
  type BuilderReference,
  type BuilderState
} from '../../src/shared/schemas.ts'
import { fakeCodexLauncher, type FakeCodexScenario } from '../helpers/fake-codex.ts'
import { createTempWorkspace, type TempWorkspace } from '../helpers/tmp-workspace.ts'

const IMAGE_DIR = fileURLToPath(new URL('../fixtures/images/', import.meta.url))

const FIRST_NOW = new Date('2026-09-28T10:00:00.000Z')

interface SentMessage {
  readonly channel: string
  readonly payload: unknown
}

let workspace: TempWorkspace
let registry: ReferenceRegistry
let library: Library
let materializer: JobMaterializer
let runner: CodexRunner
let jobs: JobService
let services: IpcServices
let handlers: Record<InvokeChannelName, (request: unknown) => Promise<IpcResult<unknown>>>
let sent: SentMessage[]
let destroyed: boolean
let logged: { channel: IpcChannelName; error: unknown }[]
let dialogAnswer: OpenDialogAnswer
let stylePath: string
let clock: number

function now(): Date {
  clock += 1000

  return new Date(FIRST_NOW.getTime() + clock)
}

/** A preflight that always passes, pointed at one fake-Codex scenario. */
function passingPreflight(scenario: FakeCodexScenario): { run: () => Promise<PreflightOutcome> } {
  return {
    run: async (): Promise<PreflightOutcome> => ({
      result: { ok: true, version: '0.158.0', executable: process.execPath },
      launcher: fakeCodexLauncher({ scenario })
    })
  }
}

function build(scenario: FakeCodexScenario = 'success'): void {
  const forwarder = new ProgressForwarder(() => contents())

  jobs = new JobService({
    workspace,
    materializer,
    preflight: passingPreflight(scenario),
    runner,
    registry,
    now,
    onProgress: (event) => {
      forwarder.send(event)
    },
    reveal: () => {}
  })

  services = {
    workspace,
    registry,
    library,
    jobs,
    preflight: passingPreflight(scenario),
    showOpenDialog: async () => dialogAnswer,
    logError: (channel, error) => {
      logged.push({ channel, error })
    }
  }

  handlers = createIpcHandlers(services)
}

/** One window, which a test can declare destroyed. */
function contents(): WebContentsLike[] {
  return [
    {
      send: (channel, payload) => {
        sent.push({ channel, payload })
      },
      isDestroyed: () => destroyed
    }
  ]
}

async function call(channel: InvokeChannelName, request?: unknown): Promise<IpcResult<unknown>> {
  const handler = handlers[channel]

  return handler(request)
}

/** The same call, failing the test if the envelope says the call was refused. */
async function succeed(channel: InvokeChannelName, request?: unknown): Promise<unknown> {
  const answer = await call(channel, request)

  expect(ipcResultSchema(IPC_CHANNELS[channel].response).safeParse(answer).success).toBe(true)

  if (!answer.ok) {
    throw new Error(`${channel} answered ${answer.code}: ${answer.message}`)
  }

  return answer.data
}

function invokeChannels(): InvokeChannelName[] {
  return IPC_CHANNEL_NAMES.filter(
    (name): name is InvokeChannelName => IPC_CHANNELS[name].kind === 'invoke'
  )
}

function progressEvents(): ProgressEvent[] {
  return sent
    .filter((message) => message.channel === PROGRESS_CHANNEL)
    .map((message) => ProgressEventSchema.parse(message.payload))
}

/** The run states in the order they were pushed, without the repeats. */
function distinctStates(): string[] {
  const seen: string[] = []

  for (const event of progressEvents()) {
    if (seen[seen.length - 1] !== event.state) {
      seen.push(event.state)
    }
  }

  return seen
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a condition.')
    }

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

async function waitForTerminalState(): Promise<ProgressEvent> {
  await waitFor(() =>
    progressEvents().some((event) => ['succeeded', 'failed', 'cancelled'].includes(event.state))
  )

  return progressEvents().at(-1) as ProgressEvent
}

async function builderInput(): Promise<{ state: BuilderStateInput; promptSha256: string }> {
  const reference = await registry.createReference(stylePath, { role: 'style' })
  const state: BuilderState = {
    schemaVersion: SCHEMA_VERSION,
    subject: { name: 'Richard Nixon', description: 'Chibi historical character portrait' },
    references: [reference],
    output: { aspectRatio: '2:3', background: 'pale warm paper', format: 'png', count: 1 },
    negativeConstraints: [],
    source: { preset: null, anchor: null }
  }
  const ordered = assignReferenceLabels(state.references).map((entry): OrderedReference => ({
    label: entry.label,
    role: entry.role,
    originalName: entry.originalName,
    ...(entry.note === undefined ? {} : { note: entry.note })
  }))

  return {
    state: {
      ...state,
      references: state.references.map(
        ({ displayPath: _displayPath, thumbnail: _thumbnail, ...rest }) => rest
      )
    },
    promptSha256: await sha256Hex(buildPrompt(state, ordered).markdown)
  }
}

beforeEach(async () => {
  workspace = await createTempWorkspace()
  registry = new ReferenceRegistry()
  library = new Library({ workspace, registry })
  materializer = new JobMaterializer({ workspace, registry, now: () => FIRST_NOW })
  runner = new CodexRunner()
  sent = []
  logged = []
  destroyed = false
  clock = 0
  stylePath = join(workspace.base, 'master-style.png')
  dialogAnswer = { canceled: true, filePaths: [] }

  await copyFile(join(IMAGE_DIR, 'style-2x3.png'), stylePath)

  build()
})

afterEach(async () => {
  runner.cancelAll()
  vi.restoreAllMocks()
  await workspace.remove()
})

// ---------------------------------------------------------------------------

describe('registration', () => {
  it('handles every invoke channel and never the event channel', () => {
    const handled = new Map<string, unknown>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        handled.set(channel, listener)
      },
      removeHandler: (channel) => {
        handled.delete(channel)
      }
    }

    const dispose = registerIpcHandlers(ipcMain, services)

    expect([...handled.keys()].sort()).toEqual([...invokeChannels()].sort())
    expect(handled.has(PROGRESS_CHANNEL)).toBe(false)
    expect(handled.size).toBe(IPC_CHANNEL_NAMES.length - 1)

    dispose()

    expect(handled.size).toBe(0)
  })

  it('passes the renderer request to the handler and the envelope back', async () => {
    const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        handled.set(channel, listener)
      },
      removeHandler: () => {}
    }

    registerIpcHandlers(ipcMain, services)

    const listener = handled.get('jobs.get')
    const answer = await listener?.({ sender: 'ignored' }, { jobId: '2026-09-28-nobody-001' })

    expect(answer).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'That job is not in this workspace.'
    })
  })
})

describe('requests are validated again in main (spec section 8)', () => {
  it('refuses a request no channel could accept', async () => {
    for (const channel of invokeChannels()) {
      const answer = await call(channel, { definitelyNotAField: 1 })

      expect(IpcErrorSchema.safeParse(answer).success).toBe(true)
      expect(answer).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })
    }
  })

  it('refuses a malformed job ID before the handler runs', async () => {
    const get = vi.spyOn(jobs, 'get')

    for (const jobId of ['../etc', '2026-09-28-nixon-001/../x', 'nixon', '']) {
      expect(await call('jobs.get', { jobId })).toMatchObject({
        ok: false,
        code: 'INVALID_REQUEST'
      })
    }

    expect(get).not.toHaveBeenCalled()
  })

  it('reports a well-formed job ID with no directory as NOT_FOUND', async () => {
    expect(await call('jobs.get', { jobId: '2026-09-28-nobody-001' })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND'
    })
  })

  it('treats a missing request as the empty one for a channel that takes none', async () => {
    expect(await call('jobs.list')).toEqual({ ok: true, data: { jobs: [] } })
  })

  it('refuses an answer that does not match the channel contract', async () => {
    vi.spyOn(jobs, 'list').mockResolvedValue([{ jobId: 'nonsense' } as never])

    expect(await call('jobs.list')).toEqual({
      ok: false,
      code: 'IO_ERROR',
      message: 'The app produced an answer for jobs.list that does not match its contract.'
    })
    expect(logged).toHaveLength(1)
  })
})

describe('answers', () => {
  it('saves and loads a draft through the envelope', async () => {
    const { state } = await builderInput()
    const saved = (await succeed('draft.save', { state })) as { savedAt: string }

    expect(saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const loaded = (await succeed('draft.load')) as {
      draft: { state: BuilderState; savedAt: string } | null
    }

    expect(loaded.draft?.state.subject.name).toBe('Richard Nixon')
    expect(loaded.draft?.state.references).toHaveLength(1)
  })

  it('answers the reference picker with a handle that carries no path', async () => {
    dialogAnswer = { canceled: false, filePaths: [stylePath] }

    const answer = (await succeed('dialog.selectReference', { role: 'style' })) as {
      reference: BuilderReference
    }

    expect(answer.reference.role).toBe('style')
    expect(Object.keys(answer.reference)).not.toContain('path')
    expect(registry.resolve(answer.reference.referenceId)).toBe(stylePath)
  })

  it('answers null when the user cancelled the picker', async () => {
    expect(await succeed('dialog.selectReference', { role: 'identity' })).toEqual({
      reference: null
    })
  })

  it('reads and writes the one setting the renderer may change', async () => {
    expect(await succeed('system.getSettings')).toEqual({
      settings: { schemaVersion: SCHEMA_VERSION, codexExecutable: null }
    })

    const updated = (await succeed('system.setSettings', {
      patch: { codexExecutable: 'C:\\tools\\codex.exe' }
    })) as { settings: { codexExecutable: string | null } }

    expect(updated.settings.codexExecutable).toBe('C:\\tools\\codex.exe')
    expect(
      JSON.parse(await readFile(join(workspace.root, SETTINGS_FILE_NAME), 'utf8')) as unknown
    ).toMatchObject({ codexExecutable: 'C:\\tools\\codex.exe' })
  })

  it('answers the preflight result without the launcher (spec section 11)', async () => {
    expect(await succeed('system.preflight', { force: true })).toEqual({
      preflight: { ok: true, version: '0.158.0', executable: process.execPath }
    })
  })

  it('stores a preset and lists it back with a handle for its image', async () => {
    dialogAnswer = { canceled: false, filePaths: [stylePath] }

    const picked = (await succeed('dialog.selectReference', { role: 'style' })) as {
      reference: BuilderReference
    }

    await succeed('library.savePreset', {
      preset: {
        id: null,
        name: 'Chibi master',
        styleReferenceId: picked.reference.referenceId,
        roleNotes: {},
        promptConventions: [],
        negativeConstraints: [],
        composition: {},
        output: { aspectRatio: '2:3', background: 'pale warm paper', format: 'png' }
      }
    })

    const listed = (await succeed('library.listPresets')) as {
      presets: { preset: { id: string; name: string } }[]
    }

    expect(listed.presets).toHaveLength(1)
    expect(listed.presets[0]?.preset.name).toBe('Chibi master')

    const id = listed.presets[0]?.preset.id as string

    expect(await succeed('library.deletePreset', { id })).toEqual({ id })
    expect(await succeed('library.listPresets')).toEqual({ presets: [] })
  })
})

describe('errors are sanitized (spec section 11)', () => {
  it('maps a refused image to a code and a message with no path in it', async () => {
    const notAnImage = join(workspace.base, 'text-pretending-to-be.png')

    await copyFile(join(IMAGE_DIR, 'text-pretending-to-be.png'), notAnImage)

    dialogAnswer = { canceled: false, filePaths: [notAnImage] }

    const answer = await call('dialog.selectReference', { role: 'style' })

    // A strict schema: parsing at all proves there is no stack and no extra key.
    expect(IpcErrorSchema.safeParse(answer).success).toBe(true)
    expect(answer).toMatchObject({ ok: false, code: 'INVALID_REQUEST' })

    if (!answer.ok) {
      expect(answer.message).not.toContain(workspace.base)
      expect(answer.message).not.toContain('\\')
    }
  })

  it('never forwards the message of an error this app did not write', async () => {
    const leaky = new Error(`ENOENT: no such file or directory, open '${workspace.root}\\secret'`)

    vi.spyOn(library, 'listAnchors').mockRejectedValue(leaky)

    const answer = await call('library.listAnchors')

    expect(answer).toEqual({ ok: false, code: 'IO_ERROR', message: UNEXPECTED_ERROR_MESSAGE })
    // The real failure is kept inside the main process instead.
    expect(logged).toEqual([{ channel: 'library.listAnchors', error: leaky }])
  })

  it('maps a library failure to its own code', async () => {
    expect(await call('library.deletePreset', { id: 'never-saved' })).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'That preset no longer exists.'
    })
  })

  it('reports a job whose prompt checksum does not match as INVALID_JOB', async () => {
    const { state } = await builderInput()

    expect(await call('jobs.generate', { state, promptSha256: 'f'.repeat(64) })).toMatchObject({
      ok: false,
      code: 'INVALID_JOB'
    })
    expect(await succeed('jobs.list')).toEqual({ jobs: [] })
  })
})

describe('jobs.generate', () => {
  it('answers the job ID alone and forwards progress to the window', async () => {
    const { state, promptSha256 } = await builderInput()
    const started = (await succeed('jobs.generate', { state, promptSha256 })) as { jobId: string }

    expect(Object.keys(started)).toEqual(['jobId'])

    const last = await waitForTerminalState()

    expect(last.state).toBe('succeeded')
    expect(distinctStates()).toEqual(['queued', 'preflight', 'running', 'verifying', 'succeeded'])
    expect(sent.every((message) => message.channel === PROGRESS_CHANNEL)).toBe(true)
    expect(progressEvents().map((event) => event.seq)).toEqual(
      progressEvents().map((_event, index) => index)
    )

    const result = JSON.parse(
      await readFile(join(workspace.jobs, started.jobId, RESULT_FILE_NAME), 'utf8')
    ) as { status: string }

    expect(result.status).toBe('succeeded')

    const listed = (await succeed('jobs.list')) as { jobs: { jobId: string; state: string }[] }

    expect(listed.jobs).toEqual([expect.objectContaining({ jobId: started.jobId })])
  })

  it('refuses a second Generate while a run is in flight (spec section 10)', async () => {
    build('hang')

    const first = await builderInput()
    const started = (await succeed('jobs.generate', first)) as { jobId: string }

    await waitFor(() => runner.isRunning(started.jobId))

    const second = await builderInput()

    expect(await call('jobs.generate', second)).toMatchObject({
      ok: false,
      code: 'ALREADY_RUNNING'
    })

    expect(await succeed('jobs.cancel', { jobId: started.jobId })).toEqual({ cancelled: true })
    expect((await waitForTerminalState()).state).toBe('cancelled')
  })

  it('reveals the job folder and refuses one that is not there', async () => {
    const { state, promptSha256 } = await builderInput()
    const started = (await succeed('jobs.generate', { state, promptSha256 })) as { jobId: string }

    await waitForTerminalState()

    expect(await succeed('jobs.openFolder', { jobId: started.jobId })).toEqual({ opened: true })
    expect(await call('jobs.openFolder', { jobId: '2026-09-28-nobody-001' })).toMatchObject({
      code: 'NOT_FOUND'
    })

    const got = (await succeed('jobs.get', { jobId: started.jobId })) as {
      job: { jobId: string }
      result: { status: string } | null
      references: BuilderReference[]
    }

    expect(got.job.jobId).toBe(started.jobId)
    expect(got.result?.status).toBe('succeeded')
    expect(got.references).toHaveLength(1)
  })
})

describe('ProgressForwarder', () => {
  const EVENT: ProgressEvent = {
    jobId: '2026-09-28-richard-nixon-001',
    state: 'running',
    activity: 'Đang gọi image_gen',
    seq: 3,
    at: '2026-09-28T10:00:40Z'
  }

  it('sends the contract payload on the contract channel', () => {
    new ProgressForwarder(() => contents()).send(EVENT)

    expect(sent).toEqual([{ channel: PROGRESS_CHANNEL, payload: EVENT }])
  })

  it('skips a window that has been destroyed', () => {
    destroyed = true
    new ProgressForwarder(() => contents()).send(EVENT)

    expect(sent).toEqual([])
  })

  it('never sends a payload that is not a ProgressEvent', () => {
    new ProgressForwarder(() => contents()).send({ ...EVENT, state: 'loading' } as never)
    new ProgressForwarder(() => contents()).send({ ...EVENT, jobId: '../escape' } as never)

    expect(sent).toEqual([])
  })

  it('survives a window that throws on send', () => {
    const forwarder = new ProgressForwarder(() => [
      {
        send: () => {
          throw new Error('Object has been destroyed')
        }
      }
    ])

    expect(() => forwarder.send(EVENT)).not.toThrow()
  })
})

describe('Content Security Policy (plan decision Q15)', () => {
  function fakeSession(): {
    session: SessionLike
    listeners: ((
      details: HeadersReceivedDetails,
      callback: (response: HeadersReceivedResponse) => void
    ) => void)[]
  } {
    const listeners: ((
      details: HeadersReceivedDetails,
      callback: (response: HeadersReceivedResponse) => void
    ) => void)[] = []

    return {
      listeners,
      session: {
        webRequest: {
          onHeadersReceived: (listener) => {
            listeners.push(listener)
          }
        }
      }
    }
  }

  it('does nothing in development, where it would break Fast Refresh', () => {
    const { session, listeners } = fakeSession()

    expect(applyContentSecurityPolicy(session, { isPackaged: false })).toBe(false)
    expect(listeners).toEqual([])
  })

  it('adds the policy to every response in a packaged app', () => {
    const { session, listeners } = fakeSession()

    expect(applyContentSecurityPolicy(session, { isPackaged: true })).toBe(true)
    expect(listeners).toHaveLength(1)

    let answered: HeadersReceivedResponse | null = null

    listeners[0]?.({ responseHeaders: { 'Content-Type': ['text/html'] } }, (response) => {
      answered = response
    })

    const headers = (answered as HeadersReceivedResponse | null)?.responseHeaders ?? {}

    expect(headers['Content-Type']).toEqual(['text/html'])
    expect(headers[CONTENT_SECURITY_POLICY_HEADER]).toEqual([CONTENT_SECURITY_POLICY])
  })

  it('allows data: images, because every JobSummary carries a thumbnail', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("img-src 'self' data:")
  })

  it('allows no script but the app bundle and no connection at all', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'")
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'none'")
    expect(CONTENT_SECURITY_POLICY).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(CONTENT_SECURITY_POLICY).not.toContain('http')
  })

  it('replaces a policy that is already there, whatever its casing', () => {
    const headers = withContentSecurityPolicy({
      'content-security-policy': ['default-src *'],
      'X-Frame-Options': ['DENY']
    })

    expect(Object.keys(headers).sort()).toEqual([CONTENT_SECURITY_POLICY_HEADER, 'X-Frame-Options'])
    expect(headers[CONTENT_SECURITY_POLICY_HEADER]).toEqual([CONTENT_SECURITY_POLICY])
  })

  it('works when the response carried no headers at all', () => {
    expect(withContentSecurityPolicy(undefined)).toEqual({
      [CONTENT_SECURITY_POLICY_HEADER]: [CONTENT_SECURITY_POLICY]
    })
  })
})

describe('ReconfigurablePreflight (plan decision Q7)', () => {
  /** Two files that pass the resolver: a real `.exe` that exists. */
  async function executable(name: string): Promise<string> {
    const path = join(workspace.base, name)

    await writeFile(path, '', 'utf8')
    await chmod(path, 0o755)

    return path
  }

  function countingRun(
    calls: string[]
  ): (launcher: { command: string }, args: readonly string[]) => Promise<CodexCommandResult> {
    return async (launcher, args) => {
      calls.push(`${launcher.command} ${args.join(' ')}`)

      return {
        code: 0,
        signal: null,
        stdout: args[0] === '--version' ? 'codex-cli 0.158.0' : 'Logged in',
        stderr: '',
        timedOut: false,
        spawnError: null
      }
    }
  }

  it('caches for the session and checks the new executable after a change', async () => {
    const calls: string[] = []
    const first = await executable('codex-first.exe')
    const second = await executable('codex-second.exe')
    const preflight = new ReconfigurablePreflight({
      codexExecutable: first,
      run: countingRun(calls)
    })

    const before = await preflight.run()

    await preflight.run()

    expect(before.result).toEqual({ ok: true, version: '0.158.0', executable: first })
    // Cached: the second call ran nothing.
    expect(calls).toHaveLength(2)

    preflight.reconfigure(second)

    const after = await preflight.run()

    expect(after.result).toEqual({ ok: true, version: '0.158.0', executable: second })
    expect(calls).toHaveLength(4)
    expect(calls.slice(0, 2).every((entry) => entry.startsWith(first))).toBe(true)
    expect(calls.slice(2).every((entry) => entry.startsWith(second))).toBe(true)
  })

  it('is what system.setSettings tells about a new executable', async () => {
    const calls: string[] = []
    const first = await executable('codex-a.exe')
    const second = await executable('codex-b.exe')
    const preflight = new ReconfigurablePreflight({
      codexExecutable: first,
      run: countingRun(calls)
    })

    handlers = createIpcHandlers({ ...services, preflight })

    expect(await succeed('system.preflight')).toMatchObject({
      preflight: { ok: true, executable: first }
    })

    await succeed('system.setSettings', { patch: { codexExecutable: second } })

    expect(await succeed('system.preflight')).toMatchObject({
      preflight: { ok: true, executable: second }
    })
  })
})
