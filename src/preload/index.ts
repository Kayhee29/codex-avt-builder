/**
 * Preload bridge (plan Task 4.1, spec sections 8 and 11).
 *
 * The window runs with `contextIsolation: true` and `sandbox: true`, so the
 * renderer has no Node.js, filesystem or child-process access at all
 * (spec section 3.2). The only thing it ever sees is the object this file hands
 * to `contextBridge.exposeInMainWorld`, and that object is built by walking
 * `IPC_CHANNEL_NAMES`: it has exactly the commands of spec section 8 plus the
 * four of plan decision Q7, and nothing else. `ipcRenderer` itself is never
 * exposed, nor is any function that hands one back.
 *
 * Every command validates its request against the channel's zod schema **before**
 * `ipcRenderer.invoke`, and a request that does not match is refused here with
 * an `INVALID_REQUEST` envelope rather than sent. The main process validates the
 * same request again (spec section 8); this side exists so a renderer bug is
 * caught where it happened, not so main can trust anything.
 *
 * `jobs.onProgress` is the one event channel. It validates each payload against
 * `ProgressEventSchema` before calling the listener, hands the listener the
 * payload alone — never the `IpcRendererEvent`, which carries the sender — and
 * returns a function that unsubscribes.
 *
 * Because the window is sandboxed, this file cannot `require` anything from
 * `node_modules` at runtime: zod has to be bundled into the preload, which is
 * why `electron.vite.config.ts` excludes it from `externalizeDepsPlugin`.
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { z } from 'zod'

import {
  IPC_CHANNEL_NAMES,
  IPC_CHANNELS,
  type IpcChannelName,
  type IpcRequest,
  type IpcResponse,
  type IpcResult
} from '../shared/ipc-contract.ts'

/** The property `contextBridge` puts on `window`. */
export const STUDIO_GLOBAL = 'studio'

/**
 * The part of `ipcRenderer` this bridge uses.
 *
 * Declaring it keeps the surface auditable — three methods, no `send`, no
 * `sendSync`, no `postMessage` — and lets the allowlist test drive the bridge
 * without an Electron window.
 */
export interface PreloadIpc {
  invoke(channel: string, request: unknown): Promise<unknown>
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void
  removeListener(channel: string, listener: (event: unknown, payload: unknown) => void): void
}

/**
 * An empty object type, spelled through `Record` so the `no-empty-object-type`
 * lint rule does not flag it. `EmptyRequest extends IpcRequest<C>` asks whether
 * a channel can be called with no arguments at all.
 */
type EmptyRequest = Record<never, never>

/**
 * One `invoke` channel as the renderer calls it.
 *
 * The argument is optional exactly when the channel accepts an empty request —
 * `draft.load()`, `jobs.list()` — and required otherwise. The answer is always
 * the envelope of `ipcResultSchema`, so the renderer has one error path and a
 * rejected promise means a bug rather than a refused command.
 */
type StudioCommand<C extends IpcChannelName> =
  EmptyRequest extends IpcRequest<C>
    ? (request?: IpcRequest<C>) => Promise<IpcResult<IpcResponse<C>>>
    : (request: IpcRequest<C>) => Promise<IpcResult<IpcResponse<C>>>

/** One event channel: subscribe, and get an unsubscribe function back. */
type StudioSubscription<C extends IpcChannelName> = (
  listener: (event: IpcResponse<C>) => void
) => () => void

/**
 * `window.studio`, keyed by channel name.
 *
 * The keys are the dotted channel names of `src/shared/ipc-contract.ts`, so the
 * exposed surface and the contract are the same list by construction:
 * `window.studio['jobs.generate']({ state, promptSha256 })`.
 */
export type StudioApi = {
  readonly [C in IpcChannelName]: (typeof IPC_CHANNELS)[C]['kind'] extends 'event'
    ? StudioSubscription<C>
    : StudioCommand<C>
}

/** How many zod issues an `INVALID_REQUEST` message names. */
const MAX_REPORTED_ISSUES = 3

/**
 * Builds the bridge over any `ipcRenderer`-shaped object.
 *
 * Exported so the allowlist test of plan Task 4.1 can compare the keys it
 * produces against `IPC_CHANNEL_NAMES` without starting Electron.
 */
export function createStudioApi(ipc: PreloadIpc): StudioApi {
  const api: Record<string, unknown> = {}

  for (const channel of IPC_CHANNEL_NAMES) {
    const definition = IPC_CHANNELS[channel]

    api[channel] =
      definition.kind === 'event'
        ? createSubscription(ipc, channel, definition.response)
        : createCommand(ipc, channel, definition.request)
  }

  // The loop walked `IPC_CHANNEL_NAMES`, so this object has exactly the keys
  // `StudioApi` declares. `tests/unit/preload-allowlist.test.ts` proves it
  // rather than taking the cast's word for it.
  return Object.freeze(api) as StudioApi
}

/**
 * One command: validate, then `invoke`.
 *
 * A request that does not match the schema never reaches `invoke`, so a
 * malformed payload cannot even occupy the main process for the time it takes
 * to reject it.
 */
function createCommand(
  ipc: PreloadIpc,
  channel: IpcChannelName,
  request: z.ZodType
): (payload?: unknown) => Promise<IpcResult<unknown>> {
  return async (payload?: unknown): Promise<IpcResult<unknown>> => {
    const parsed = request.safeParse(payload ?? {})

    if (!parsed.success) {
      return invalidRequest(channel, parsed.error)
    }

    return (await ipc.invoke(channel, parsed.data)) as IpcResult<unknown>
  }
}

/**
 * One event channel: validate every payload, then call the listener with it.
 *
 * The `IpcRendererEvent` is dropped on purpose — it carries `sender` and the
 * message ports, which are exactly the capabilities the renderer must not get
 * (spec section 11). A payload that fails the schema is dropped rather than
 * passed on: main is the only sender, so a malformed event is a main-process
 * bug and never something the UI should act on.
 */
function createSubscription(
  ipc: PreloadIpc,
  channel: IpcChannelName,
  payloadSchema: z.ZodType
): (listener: (event: never) => void) => () => void {
  return (listener: (event: never) => void): (() => void) => {
    const handler = (_event: unknown, raw: unknown): void => {
      const parsed = payloadSchema.safeParse(raw)

      if (parsed.success) {
        listener(parsed.data as never)
      }
    }

    ipc.on(channel, handler)

    return (): void => {
      ipc.removeListener(channel, handler)
    }
  }
}

/**
 * The envelope a refused request gets, in the same shape main would have sent.
 *
 * The message names the offending fields and never their values, so a draft's
 * text cannot end up in an error string.
 */
function invalidRequest(channel: IpcChannelName, error: z.ZodError): IpcResult<never> {
  const fields = error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => (issue.path.length === 0 ? '(root)' : issue.path.join('.')))
    .join(', ')

  return {
    ok: false,
    code: 'INVALID_REQUEST',
    message: `This request does not match the ${channel} contract: ${fields}.`
  }
}

contextBridge.exposeInMainWorld(STUDIO_GLOBAL, createStudioApi(ipcRenderer))
