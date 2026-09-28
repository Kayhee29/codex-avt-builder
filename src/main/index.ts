import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { app, BrowserWindow, type WebContents } from 'electron'

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

app.on('web-contents-created', (_event, contents) => {
  lockDownNavigation(contents)
})

void app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
