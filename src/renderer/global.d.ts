/**
 * The one global the preload installs (plan Task 5.1, spec section 11).
 *
 * `contextBridge.exposeInMainWorld('studio', …)` is the renderer's entire view
 * of the outside world: no Node, no filesystem, no `ipcRenderer`, no other
 * global. Declaring it here rather than in a component keeps that fact in one
 * place, and `src/renderer/bridge.ts` is the only module that reads it.
 */
import type { StudioApi } from './studio-api.ts'

declare global {
  interface Window {
    /** Installed by `src/preload/index.ts`; absent in a plain browser page. */
    readonly studio: StudioApi
  }
}
