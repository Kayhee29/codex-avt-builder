/**
 * The main-process IPC handlers (plan Task 4.2, spec sections 8, 10 and 11).
 *
 * One `ipcMain.handle` per `invoke` channel of `src/shared/ipc-contract.ts`,
 * and nothing else is registered: a channel name the renderer invents has no
 * handler and its `invoke` rejects. `jobs.onProgress` is the one `event`
 * channel, so it gets no handler at all — main pushes it through
 * {@link ProgressForwarder}.
 *
 * Three rules shape every handler.
 *
 * Spec section 8: the request is validated here even though the preload already
 * validated it. The preload runs in the renderer's process and is not a trust
 * boundary; this is.
 *
 * Spec section 11: what goes back to the renderer is
 * `{ ok: false, code, message }` with a short message and no stack, no absolute
 * path and no environment detail. Only the message of an error class this app
 * wrote is forwarded, because those are documented as sanitized; anything else
 * — an errno from Node, a zod failure, a bug — becomes a fixed sentence, and
 * the real error goes to {@link IpcServices.logError} inside the main process.
 *
 * Spec section 10: `jobs.generate` is refused while a run is in flight.
 *
 * Electron is never imported here, not even lazily: `ipcMain`, the session and
 * the web contents all arrive as the structural types below, so the whole file
 * is tested without a window (plan Task 4.2 drives it through a handler table).
 */
import type { z } from 'zod'

import {
  IPC_CHANNELS,
  IPC_CHANNEL_NAMES,
  type IpcChannelName,
  type IpcErrorCode,
  type IpcRequest,
  type IpcResponse,
  type IpcResult
} from '../shared/ipc-contract.ts'
import { ProgressEventSchema, type ProgressEvent } from '../shared/progress.ts'

import {
  CodexPreflight,
  type CodexPreflightOptions,
  type PreflightOutcome
} from './codex-preflight.ts'
import { CodexResolveError } from './codex-resolver.ts'
import { CodexRunError } from './codex-runner.ts'
import { selectReference, type ShowOpenDialog } from './dialog.ts'
import { ImageInspectError, type ImageInspectErrorCode } from './image-inspect.ts'
import { MaterializeError } from './job-materializer.ts'
import { JobError, type JobService, type PreflightRunner } from './jobs.ts'
import { LibraryError, type Library } from './library.ts'
import type { ReferenceRegistry } from './reference-registry.ts'
import { loadSettings, updateSettings } from './settings.ts'
import { UnsafePathError, type WorkspaceLayout } from './workspace.ts'

/** The event channel main pushes on (spec section 5.5). */
export const PROGRESS_CHANNEL = 'jobs.onProgress' satisfies IpcChannelName

/** Every channel the renderer may `invoke`, taken from the contract. */
export type InvokeChannelName = {
  [C in IpcChannelName]: (typeof IPC_CHANNELS)[C]['kind'] extends 'invoke' ? C : never
}[IpcChannelName]

/** One registered handler: a raw request in, an envelope out. It never throws. */
export type IpcHandler = (request: unknown) => Promise<IpcResult<unknown>>

/**
 * A preflight whose executable override can be replaced.
 *
 * `system.setSettings` is allowed to change `codexExecutable` (plan decision
 * Q7), and the preflight result is cached for the session — so a cache built
 * from the old path has to be dropped, or the user would fix the setting and
 * still be told Codex cannot be found.
 */
export interface ConfigurablePreflight extends PreflightRunner {
  reconfigure?(codexExecutable: string | null): void
}

export interface IpcServices {
  /** The workspace root, or the layout built from it; settings live there. */
  readonly workspace: string | WorkspaceLayout
  readonly library: Library
  readonly jobs: JobService
  readonly preflight: ConfigurablePreflight
  /** Opens the reference picker; production passes `electronShowOpenDialog`. */
  readonly showOpenDialog: ShowOpenDialog
  /** Needed by `dialog.selectReference` to mint the handle it answers with. */
  readonly registry: ReferenceRegistry
  /** Passed to the image inspector; defaults to the 20 MB of spec section 4.2. */
  readonly maxBytes?: number
  /**
   * Where the real error goes when a handler fails.
   *
   * The renderer gets a sanitized sentence (spec section 11), so without this
   * an unexpected failure would leave no trace anywhere. Defaults to doing
   * nothing, which is what the tests want.
   */
  readonly logError?: (channel: IpcChannelName, error: unknown) => void
}

/** The part of `ipcMain` this module uses. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

/** The part of `WebContents` {@link ProgressForwarder} uses. */
export interface WebContentsLike {
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
}

// ---------------------------------------------------------------------------
// The handlers
// ---------------------------------------------------------------------------

/** What each channel does, before validation and error mapping are wrapped on. */
type Implementations = {
  readonly [C in InvokeChannelName]: (request: IpcRequest<C>) => Promise<IpcResponse<C>>
}

/**
 * The handler table, keyed by channel.
 *
 * Exported so the tests can call a handler directly, the way `ipcMain` would,
 * without an Electron window anywhere.
 */
export function createIpcHandlers(services: IpcServices): Record<InvokeChannelName, IpcHandler> {
  const table = implementations(services)
  const handlers = {} as Record<InvokeChannelName, IpcHandler>

  for (const channel of invokeChannelNames()) {
    handlers[channel] = createHandler(channel, table[channel], services)
  }

  return handlers
}

/**
 * Registers one handler per `invoke` channel and returns a function that
 * removes them again.
 *
 * `jobs.onProgress` is deliberately absent: it is an event channel, and
 * registering a handler for it would let the renderer invoke it.
 */
export function registerIpcHandlers(ipcMain: IpcMainLike, services: IpcServices): () => void {
  const handlers = createIpcHandlers(services)

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event: unknown, ...args: unknown[]) => handler(args[0]))
  }

  return (): void => {
    for (const channel of Object.keys(handlers)) {
      ipcMain.removeHandler(channel)
    }
  }
}

function invokeChannelNames(): InvokeChannelName[] {
  return IPC_CHANNEL_NAMES.filter(
    (name): name is InvokeChannelName => IPC_CHANNELS[name].kind === 'invoke'
  )
}

function implementations(services: IpcServices): Implementations {
  const { jobs, library, preflight, registry } = services
  const workspaceRoot =
    typeof services.workspace === 'string' ? services.workspace : services.workspace.root
  const inspectOptions = services.maxBytes === undefined ? {} : { maxBytes: services.maxBytes }

  return {
    'dialog.selectReference': async ({ role }) => ({
      reference: await selectReference(role, {
        registry,
        showOpenDialog: services.showOpenDialog,
        ...inspectOptions
      })
    }),

    'draft.load': async () => ({ draft: await library.loadDraft() }),

    'draft.save': async ({ state }) => library.saveDraft(state),

    'library.listPresets': async () => ({ presets: await library.listPresets() }),

    'library.savePreset': async ({ preset }) => ({ preset: await library.savePreset(preset) }),

    'library.deletePreset': async ({ id }) => {
      await library.deletePreset(id)

      return { id }
    },

    'library.listAnchors': async () => ({ anchors: await library.listAnchors() }),

    'library.saveAnchor': async ({ anchor }) => ({ anchor: await library.saveAnchor(anchor) }),

    'jobs.list': async () => ({ jobs: await jobs.list() }),

    'jobs.get': async ({ jobId }) => jobs.get(jobId),

    'jobs.generate': async ({ state, promptSha256 }) => {
      // Spec section 10: a second Generate while a run is in flight is refused.
      // This app builds one draft at a time, so any live run is that draft's.
      if (jobs.running.length > 0) {
        throw new JobError(
          'ALREADY_RUNNING',
          'A job is already running; wait for it to finish or cancel it first.'
        )
      }

      const started = await jobs.generate(state, promptSha256)

      // The run reports itself through `jobs.onProgress` and always ends in a
      // `result.json`; `completed` never rejects (plan Task 3.7), so dropping
      // it here leaves no unhandled rejection behind. Spec section 8 answers
      // with the job ID alone.
      void started.completed

      return { jobId: started.jobId }
    },

    'jobs.cancel': async ({ jobId }) => ({ cancelled: jobs.cancel(jobId) }),

    'jobs.openFolder': async ({ jobId }) => ({ opened: await jobs.openFolder(jobId) }),

    'system.preflight': async (request) => ({
      preflight: (await preflight.run(request.force === undefined ? {} : { force: request.force }))
        .result
    }),

    'system.getSettings': async () => ({ settings: await loadSettings(workspaceRoot) }),

    'system.setSettings': async ({ patch }) => {
      const settings = await updateSettings(workspaceRoot, patch)

      // The cached preflight was built from the previous executable, so it has
      // to be rebuilt before anyone asks again (plan decision Q7).
      preflight.reconfigure?.(settings.codexExecutable)

      return { settings }
    }
  }
}

/**
 * Wraps one implementation in the contract: validate the request, run it, then
 * validate what it produced before the renderer sees it.
 *
 * Spec section 8 asks for validation on both sides of every payload, so the
 * response is checked too — a handler that drifts from the contract is a bug
 * reported as `IO_ERROR` rather than a shape the renderer has to guess at.
 */
function createHandler(
  channel: InvokeChannelName,
  // `never` rather than the channel's own request type: {@link Implementations}
  // pins every per-channel type where the implementations are written, and this
  // signature only has to accept all of them at once.
  run: (request: never) => Promise<unknown>,
  services: IpcServices
): IpcHandler {
  const definition: { request: z.ZodType; response: z.ZodType } = IPC_CHANNELS[channel]

  return async (raw: unknown): Promise<IpcResult<unknown>> => {
    const request = definition.request.safeParse(raw ?? {})

    if (!request.success) {
      return {
        ok: false,
        code: 'INVALID_REQUEST',
        message: `This request does not match the ${channel} contract.`
      }
    }

    let answer: unknown

    try {
      answer = await run(request.data as never)
    } catch (error) {
      services.logError?.(channel, error)

      return toErrorEnvelope(error)
    }

    const response = definition.response.safeParse(answer)

    if (!response.success) {
      services.logError?.(channel, response.error)

      return {
        ok: false,
        code: 'IO_ERROR',
        message: `The app produced an answer for ${channel} that does not match its contract.`
      }
    }

    return { ok: true, data: response.data }
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** What an unsupported, oversized, symlinked or missing image maps to. */
const IMAGE_INSPECT_CODES: Record<ImageInspectErrorCode, IpcErrorCode> = {
  UNSUPPORTED_FORMAT: 'INVALID_REQUEST',
  TOO_LARGE: 'INVALID_REQUEST',
  IS_SYMLINK: 'INVALID_REQUEST',
  NOT_A_FILE: 'MISSING_REFERENCE'
}

/** The sentence an error this app did not write is reported as. */
export const UNEXPECTED_ERROR_MESSAGE =
  'Something went wrong inside the app and the action was stopped. Nothing was changed.'

/**
 * Turns a thrown error into the envelope of `src/shared/ipc-contract.ts`.
 *
 * Only the message of an error class this app wrote crosses to the renderer,
 * because those messages are written to be shown; `UnsafePathError` is the
 * exception among them, since its message names the path it refused
 * (spec section 11). Everything else — an errno carrying an absolute path, a
 * zod dump, a bug — becomes {@link UNEXPECTED_ERROR_MESSAGE}.
 */
export function toErrorEnvelope(error: unknown): IpcResult<never> {
  if (
    error instanceof JobError ||
    error instanceof MaterializeError ||
    error instanceof LibraryError ||
    error instanceof CodexRunError
  ) {
    return { ok: false, code: error.code, message: error.message }
  }

  if (error instanceof ImageInspectError) {
    return { ok: false, code: IMAGE_INSPECT_CODES[error.code], message: error.message }
  }

  if (error instanceof CodexResolveError) {
    return { ok: false, code: 'CODEX_NOT_FOUND', message: error.message }
  }

  if (error instanceof UnsafePathError) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'That request named something outside this workspace and was refused.'
    }
  }

  return { ok: false, code: 'IO_ERROR', message: UNEXPECTED_ERROR_MESSAGE }
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/**
 * Pushes `jobs.onProgress` to every live window (spec section 5.5).
 *
 * It is handed to `JobService` as its `onProgress` sink, which is why the
 * windows arrive as a function: the service is built while the app is starting
 * and the window may not exist yet, or may have been closed and reopened.
 *
 * Each event is validated before it is sent. The preload validates it again on
 * arrival; this side catches a main-process bug before it becomes a dropped
 * event the UI cannot explain.
 */
export class ProgressForwarder {
  readonly #targets: () => Iterable<WebContentsLike>

  constructor(targets: () => Iterable<WebContentsLike>) {
    this.#targets = targets
  }

  send(event: ProgressEvent): void {
    const parsed = ProgressEventSchema.safeParse(event)

    if (!parsed.success) {
      return
    }

    for (const contents of this.#targets()) {
      if (contents.isDestroyed?.() === true) {
        continue
      }

      try {
        contents.send(PROGRESS_CHANNEL, parsed.data)
      } catch {
        // A window that went away between the check and the send is not a
        // reason to fail a run.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Content Security Policy (plan decision Q15)
// ---------------------------------------------------------------------------

/**
 * The policy a packaged window runs under.
 *
 * `default-src 'none'` and then only what the app actually uses: its own
 * bundle, its own stylesheet, and `data:` images because every `JobSummary`
 * carries a `thumbnailDataUrl` (plan decision Q15). `'unsafe-inline'` is
 * allowed for styles alone, since React writes `style` attributes; it is never
 * allowed for scripts. Nothing may connect anywhere — this app has no HTTP
 * backend and never calls an API (spec section 2).
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export const CONTENT_SECURITY_POLICY_HEADER = 'Content-Security-Policy'

/** The part of `OnHeadersReceivedListenerDetails` this module reads. */
export interface HeadersReceivedDetails {
  readonly responseHeaders?: Record<string, string[]>
}

/** The part of `HeadersReceivedResponse` this module writes. */
export interface HeadersReceivedResponse {
  responseHeaders?: Record<string, string | string[]>
}

/** The part of `Session` {@link applyContentSecurityPolicy} uses. */
export interface SessionLike {
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: HeadersReceivedDetails,
        callback: (response: HeadersReceivedResponse) => void
      ) => void
    ): void
  }
}

/**
 * Adds the policy to every response, but only in a packaged app
 * (plan decision Q15).
 *
 * Under `pnpm dev` the renderer is served by Vite and React Fast Refresh
 * injects its preamble inline, which `script-src 'self'` would block — so the
 * header is not set there, and the guarantee it is part of is a property of the
 * shipped app. Returns whether it was applied.
 */
export function applyContentSecurityPolicy(
  session: SessionLike,
  options: { readonly isPackaged: boolean }
): boolean {
  if (!options.isPackaged) {
    return false
  }

  session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: withContentSecurityPolicy(details.responseHeaders) })
  })

  return true
}

/**
 * The response headers with exactly one CSP on them.
 *
 * An existing policy is dropped first, case-insensitively, because HTTP header
 * names are case-insensitive and two policies would be intersected rather than
 * replaced.
 */
export function withContentSecurityPolicy(
  headers: Readonly<Record<string, string[]>> | undefined
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {}

  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== CONTENT_SECURITY_POLICY_HEADER.toLowerCase()) {
      next[name] = value
    }
  }

  next[CONTENT_SECURITY_POLICY_HEADER] = [CONTENT_SECURITY_POLICY]

  return next
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * A {@link CodexPreflight} that can be rebuilt when the user changes
 * `codexExecutable`.
 *
 * `CodexPreflight` reads its options once, at construction, and caches the
 * outcome for the session. Both are right for a setting that does not move;
 * this wrapper is what makes `system.setSettings` followed by
 * `system.preflight({ force: true })` check the path the user just typed
 * instead of the one it started with.
 */
export class ReconfigurablePreflight implements ConfigurablePreflight {
  readonly #options: CodexPreflightOptions
  #current: CodexPreflight

  constructor(options: CodexPreflightOptions = {}) {
    this.#options = options
    this.#current = new CodexPreflight(options)
  }

  async run(request: { readonly force?: boolean } = {}): Promise<PreflightOutcome> {
    return this.#current.run(request)
  }

  reconfigure(codexExecutable: string | null): void {
    this.#current = new CodexPreflight({ ...this.#options, codexExecutable })
  }
}
