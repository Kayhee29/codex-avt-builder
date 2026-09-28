/**
 * Preload bridge.
 *
 * The window runs with `contextIsolation: true` and `sandbox: true`, so the
 * renderer has no Node.js, filesystem or child-process access at all
 * (spec section 3.2). The only way anything reaches the renderer is through an
 * explicit `contextBridge.exposeInMainWorld` allowlist.
 *
 * Task 4.1 fills this file in: it exposes `window.studio` with exactly the
 * commands declared in `src/shared/ipc-contract.ts` (spec section 8), each one
 * validating its request payload before calling `ipcRenderer.invoke`. Until
 * then nothing is exposed, which is the correct default.
 */

export {}
