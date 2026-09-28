/**
 * The renderer's type for `window.studio` (plan Task 5.1, spec sections 8, 11).
 *
 * The preload builds the real object and `src/preload/index.ts` declares the
 * same shape. This file re-derives it from `src/shared/ipc-contract.ts` instead
 * of importing the preload's `StudioApi`, on purpose:
 *
 * - `src/preload/index.ts` imports `electron` and calls
 *   `contextBridge.exposeInMainWorld` at module load. Pulling it into the web
 *   project would put an Electron module in the renderer's module graph, one
 *   dropped `type` keyword away from bundling the preload into the renderer.
 * - The renderer's view of the bridge should come from the contract, which is
 *   the thing both sides agree on, not from the other side's implementation.
 *
 * The cost of re-deriving is drift, so `tests/unit/renderer-studio-api.test.ts`
 * asserts that this type and the preload's are the same type. Change one and
 * that test fails.
 *
 * Types only: this module emits nothing.
 */
import type {
  IPC_CHANNELS,
  IpcChannelName,
  IpcRequest,
  IpcResponse,
  IpcResult
} from '@shared/ipc-contract'

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
 * the `IpcResult` envelope, so these promises never reject: a refused command
 * comes back as `{ ok: false, code, message }` and the caller branches on `ok`.
 */
export type StudioCommand<C extends IpcChannelName> =
  EmptyRequest extends IpcRequest<C>
    ? (request?: IpcRequest<C>) => Promise<IpcResult<IpcResponse<C>>>
    : (request: IpcRequest<C>) => Promise<IpcResult<IpcResponse<C>>>

/** One event channel: subscribe, and get an unsubscribe function back. */
export type StudioSubscription<C extends IpcChannelName> = (
  listener: (event: IpcResponse<C>) => void
) => () => void

/**
 * `window.studio`, keyed by the dotted channel names of the contract:
 * `window.studio['jobs.generate']({ state, promptSha256 })`. Flat, not nested.
 */
export type StudioApi = {
  readonly [C in IpcChannelName]: (typeof IPC_CHANNELS)[C]['kind'] extends 'event'
    ? StudioSubscription<C>
    : StudioCommand<C>
}
