/**
 * The Electron entry point.
 *
 * This is the one file in `src/main/` that may import Electron at module level;
 * everything else takes what it needs as an injected function or a structural
 * type, so `pnpm test` runs the whole main process without a browser.
 *
 * Startup order matters and is fixed here (plan Tasks 3.7 and 4.2):
 *
 * 1. the Content Security Policy of plan decision Q15, before anything loads;
 * 2. `ensureWorkspaceLayout`, so the four directories of spec section 9 exist;
 * 3. `recoverInterruptedJobs`, so a job the last session left unfinished has its
 *    `result.json` before the window can list it (plan decision Q13);
 * 4. the IPC handlers, so the renderer never invokes a channel that is not
 *    registered yet;
 * 5. the window.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, ipcMain, session, type WebContents } from 'electron'

import { electronShowOpenDialog } from './dialog.ts'
import {
  applyContentSecurityPolicy,
  ProgressForwarder,
  ReconfigurablePreflight,
  registerIpcHandlers,
  type IpcServices
} from './ipc.ts'
import { JobMaterializer } from './job-materializer.ts'
import { JobService } from './jobs.ts'
import { Library } from './library.ts'
import { recoverInterruptedJobs } from './recovery.ts'
import { nativeImageThumbnail, ReferenceRegistry } from './reference-registry.ts'
import { loadSettings } from './settings.ts'
import { ensureWorkspaceLayout, resolveWorkspaceRoot } from './workspace.ts'

const RENDERER_DEV_URL = process.env['ELECTRON_RENDERER_URL']
const RENDERER_FILE = join(__dirname, '../renderer/index.html')

/**
 * The single URL the renderer is ever allowed to sit on. Anything else is an
 * external navigation and is refused (spec section 11).
 */
const RENDERER_ENTRY_URL = RENDERER_DEV_URL ?? pathToFileURL(RENDERER_FILE).toString()

/**
 * Applies the navigation half of the security boundary to any web contents the
 * app creates, so a future window or webview cannot opt out of it.
 */
function lockDownNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))

  contents.on('will-navigate', (event, url) => {
    if (url !== RENDERER_ENTRY_URL) {
      event.preventDefault()
    }
  })
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: 'Reference Image Studio',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Spec section 11. None of these four may be relaxed.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  })

  window.once('ready-to-show', () => {
    window.show()
  })

  if (RENDERER_DEV_URL === undefined) {
    void window.loadFile(RENDERER_FILE)
  } else {
    void window.loadURL(RENDERER_DEV_URL)
  }

  return window
}

/**
 * Everything the main process owns for one app session, wired with the
 * production injections: real thumbnails through `nativeImage`, the real file
 * dialog, and progress pushed to every live window.
 */
async function createServices(): Promise<IpcServices> {
  const layout = await ensureWorkspaceLayout(resolveWorkspaceRoot(app))

  // Plan decision Q13, before the window exists: a job the app died on shows as
  // failed with INTERRUPTED and is never mistaken for one still running.
  await recoverInterruptedJobs({ workspace: layout })

  const settings = await loadSettings(layout.root)
  const registry = new ReferenceRegistry({ renderThumbnail: nativeImageThumbnail })
  const preflight = new ReconfigurablePreflight({ codexExecutable: settings.codexExecutable })
  const progress = new ProgressForwarder(() =>
    BrowserWindow.getAllWindows().map((window) => window.webContents)
  )

  return {
    workspace: layout,
    registry,
    library: new Library({ workspace: layout, registry }),
    jobs: new JobService({
      workspace: layout,
      materializer: new JobMaterializer({ workspace: layout, registry }),
      preflight,
      registry,
      renderThumbnail: nativeImageThumbnail,
      onProgress: (event) => {
        progress.send(event)
      }
    }),
    preflight,
    showOpenDialog: electronShowOpenDialog,
    logError: (channel, error) => {
      // The renderer only ever gets a sanitized sentence (spec section 11), so
      // this is the one place the real failure is recorded.
      console.error(`IPC handler ${channel} failed:`, error)
    }
  }
}

app.on('web-contents-created', (_event, contents) => {
  lockDownNavigation(contents)
})

void app
  .whenReady()
  .then(async () => {
    // Plan decision Q15: packaged only, because `script-src 'self'` would block
    // the React Fast Refresh preamble under `pnpm dev`.
    applyContentSecurityPolicy(session.defaultSession, { isPackaged: app.isPackaged })

    registerIpcHandlers(ipcMain, await createServices())

    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow()
      }
    })
  })
  .catch((error: unknown) => {
    // Without a workspace there is nowhere to write a job, so there is nothing
    // useful the window could do.
    console.error('Reference Image Studio could not start:', error)
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
