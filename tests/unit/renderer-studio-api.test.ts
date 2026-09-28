/**
 * The renderer's `StudioApi` and the preload's are the same type
 * (plan Task 5.1).
 *
 * `src/renderer/studio-api.ts` re-derives the bridge type from the IPC contract
 * rather than importing it from `src/preload/index.ts`, so that the renderer's
 * module graph never reaches an Electron module. The price of re-deriving is
 * that the two can drift, and this file is what makes that impossible: the
 * assertions below are compile-time, so a change to either declaration fails
 * `pnpm typecheck` and `pnpm test`.
 *
 * This test lives outside `tests/unit/renderer/` on purpose. It belongs to the
 * node project, which is the one that has the preload and Electron's types; the
 * renderer tests belong to the web project and must not pull Electron in.
 */
import { describe, expect, it, vi } from 'vitest'

import type { StudioApi as PreloadStudioApi } from '../../src/preload/index.ts'
import type { StudioApi as RendererStudioApi } from '../../src/renderer/studio-api.ts'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

/** True only when `X` and `Y` are the identical type, not merely assignable. */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

const SAME_TYPE: Equals<PreloadStudioApi, RendererStudioApi> = true

describe('window.studio typing', () => {
  it('is declared identically on both sides of the bridge', () => {
    // The declaration above is the test: it does not compile if the renderer's
    // view of `window.studio` stops matching the object the preload exposes.
    expect(SAME_TYPE).toBe(true)
  })
})
