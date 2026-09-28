/**
 * The single accessor for `window.studio` (plan Task 5.1).
 *
 * Every store and component goes through this function instead of reading the
 * global directly, for three reasons:
 *
 * - the global is read at call time, so a test can install a fake bridge after
 *   the modules under test have been imported;
 * - a renderer running without the preload fails with one clear English
 *   message instead of `undefined is not a function` somewhere downstream;
 * - `grep -r "window.studio" src/renderer` returns exactly one hit, which is
 *   what makes the surface of spec section 11 auditable from the renderer side.
 *
 * The commands themselves never reject: they answer with the `IpcResult`
 * envelope, so callers branch on `ok` rather than wrapping calls in try/catch.
 */
import type { StudioApi } from './studio-api.ts'

/** The property name `contextBridge.exposeInMainWorld` was given. */
export const STUDIO_GLOBAL = 'studio'

/**
 * The bridge the preload installed.
 *
 * @throws when the preload did not run, which is a bootstrap bug rather than a
 * condition the UI should try to recover from.
 */
export function bridge(): StudioApi {
  const api = (window as Partial<Window>).studio

  if (api === undefined) {
    throw new Error(
      `The preload bridge is missing: window.${STUDIO_GLOBAL} is undefined. ` +
        'The renderer cannot reach the main process without it.'
    )
  }

  return api
}
