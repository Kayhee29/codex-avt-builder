import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CLOSE_ANSWER_ENV_VAR,
  CODEX_LAUNCHER_ENV_VAR,
  FAKE_CODEX_SCRIPT_ENV_VAR,
  FAKE_CODEX_SCRIPT_RELATIVE_PATH,
  MISSING_CODEX_FILE_NAME,
  OPEN_DIALOG_ENV_VAR,
  isTestMode,
  scriptedShowMessageBox,
  scriptedShowOpenDialog,
  testCodexLauncher
} from '../../src/main/test-hooks.ts'
import { QUIT_BUTTON_INDEX, STAY_BUTTON_INDEX } from '../../src/main/close-guard.ts'

const APP_PATH = join('C:', 'app')

/** The dialog request `selectReference` builds; the scripted picker ignores it. */
const REQUEST = {
  title: 'Chọn ảnh tham chiếu',
  buttonLabel: 'Chọn ảnh',
  properties: ['openFile'],
  filters: []
} as const

describe('isTestMode', () => {
  it('is true only for NODE_ENV=test', () => {
    expect(isTestMode({ NODE_ENV: 'test' })).toBe(true)
    expect(isTestMode({ NODE_ENV: 'production' })).toBe(false)
    expect(isTestMode({ NODE_ENV: 'development' })).toBe(false)
    expect(isTestMode({})).toBe(false)
  })
})

describe('testCodexLauncher', () => {
  it('refuses every launcher outside test mode', () => {
    for (const kind of ['fake', 'missing']) {
      expect(testCodexLauncher({ [CODEX_LAUNCHER_ENV_VAR]: kind }, APP_PATH)).toBeNull()
      expect(
        testCodexLauncher({ NODE_ENV: 'production', [CODEX_LAUNCHER_ENV_VAR]: kind }, APP_PATH)
      ).toBeNull()
    }
  })

  it('is null in test mode when nothing asked for a stand-in', () => {
    expect(testCodexLauncher({ NODE_ENV: 'test' }, APP_PATH)).toBeNull()
  })

  it('points `fake` at tests/fake-codex under the app path (plan decision Q8)', () => {
    const launcher = testCodexLauncher(
      { NODE_ENV: 'test', [CODEX_LAUNCHER_ENV_VAR]: 'fake' },
      APP_PATH
    )

    expect(launcher?.command).toBe(process.execPath)
    expect(launcher?.prefixArgs).toEqual([join(APP_PATH, FAKE_CODEX_SCRIPT_RELATIVE_PATH)])
  })

  it('forwards every FAKE_CODEX_ variable onto the launcher', () => {
    const launcher = testCodexLauncher(
      {
        NODE_ENV: 'test',
        [CODEX_LAUNCHER_ENV_VAR]: 'fake',
        FAKE_CODEX_SCENARIO: 'capability-unavailable',
        FAKE_CODEX_LOGIN: '1',
        STUDIO_WORKSPACE: join('C:', 'tmp'),
        OPENAI_API_KEY: 'sk-not-a-real-key'
      },
      APP_PATH
    )

    // `minimalCodexEnv` drops what it does not name, so the scenario has to
    // ride on the launcher or every run would silently be `success`.
    expect(launcher?.env).toEqual({
      FAKE_CODEX_SCENARIO: 'capability-unavailable',
      FAKE_CODEX_LOGIN: '1'
    })
  })

  it('takes an absolute script override and ignores a relative one', () => {
    const absolute = join('D:', 'elsewhere', 'fake-codex.mjs')

    expect(
      testCodexLauncher(
        {
          NODE_ENV: 'test',
          [CODEX_LAUNCHER_ENV_VAR]: 'fake',
          [FAKE_CODEX_SCRIPT_ENV_VAR]: absolute
        },
        APP_PATH
      )?.prefixArgs
    ).toEqual([absolute])

    expect(
      testCodexLauncher(
        {
          NODE_ENV: 'test',
          [CODEX_LAUNCHER_ENV_VAR]: 'fake',
          [FAKE_CODEX_SCRIPT_ENV_VAR]: 'fake-codex.mjs'
        },
        APP_PATH
      )?.prefixArgs
    ).toEqual([join(APP_PATH, FAKE_CODEX_SCRIPT_RELATIVE_PATH)])
  })

  it('points `missing` at an absolute path that holds no file', () => {
    const launcher = testCodexLauncher(
      { NODE_ENV: 'test', [CODEX_LAUNCHER_ENV_VAR]: 'missing' },
      APP_PATH
    )

    expect(launcher?.command).toBe(join(APP_PATH, MISSING_CODEX_FILE_NAME))
    expect(isAbsolute(launcher?.command ?? '')).toBe(true)
    expect(launcher?.prefixArgs).toEqual([])
  })
})

describe('scriptedShowOpenDialog', () => {
  let directory: string
  let script: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'studio-test-hooks-'))
    script = join(directory, 'open-dialog.json')
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('is null outside test mode, and null without a script file', () => {
    expect(scriptedShowOpenDialog({ [OPEN_DIALOG_ENV_VAR]: script })).toBeNull()
    expect(scriptedShowOpenDialog({ NODE_ENV: 'test' })).toBeNull()
  })

  it('answers with the paths in the file, re-reading it on every call', async () => {
    const dialog = scriptedShowOpenDialog({ NODE_ENV: 'test', [OPEN_DIALOG_ENV_VAR]: script })

    expect(dialog).not.toBeNull()

    await writeFile(script, JSON.stringify({ canceled: false, filePaths: ['/a/style.png'] }))
    expect(await dialog?.(REQUEST)).toEqual({ canceled: false, filePaths: ['/a/style.png'] })

    await writeFile(script, JSON.stringify({ canceled: false, filePaths: ['/a/outfit.webp'] }))
    expect(await dialog?.(REQUEST)).toEqual({ canceled: false, filePaths: ['/a/outfit.webp'] })
  })

  it('reports a missing, malformed or empty script as a cancelled picker', async () => {
    const dialog = scriptedShowOpenDialog({ NODE_ENV: 'test', [OPEN_DIALOG_ENV_VAR]: script })

    expect(await dialog?.(REQUEST)).toEqual({ canceled: true, filePaths: [] })

    await writeFile(script, 'not json')
    expect(await dialog?.(REQUEST)).toEqual({ canceled: true, filePaths: [] })

    await writeFile(script, JSON.stringify({ canceled: false, filePaths: [] }))
    expect(await dialog?.(REQUEST)).toEqual({ canceled: true, filePaths: [] })

    await writeFile(script, JSON.stringify({ canceled: true, filePaths: ['/a/style.png'] }))
    expect(await dialog?.(REQUEST)).toEqual({ canceled: true, filePaths: [] })
  })
})

describe('scriptedShowMessageBox', () => {
  it('is null outside test mode, and null when no answer was scripted', () => {
    expect(scriptedShowMessageBox({ [CLOSE_ANSWER_ENV_VAR]: 'quit' })).toBeNull()
    expect(scriptedShowMessageBox({ NODE_ENV: 'test' })).toBeNull()
  })

  it('answers with the scripted button', async () => {
    const stay = scriptedShowMessageBox({ NODE_ENV: 'test', [CLOSE_ANSWER_ENV_VAR]: 'stay' })
    const quit = scriptedShowMessageBox({ NODE_ENV: 'test', [CLOSE_ANSWER_ENV_VAR]: 'quit' })

    expect(await stay?.(messageBoxOptions())).toEqual({ response: STAY_BUTTON_INDEX })
    expect(await quit?.(messageBoxOptions())).toEqual({ response: QUIT_BUTTON_INDEX })
  })
})

function messageBoxOptions() {
  return {
    type: 'question',
    buttons: ['Tiếp tục chạy', 'Hủy job và thoát'],
    defaultId: 0,
    cancelId: 0,
    title: 'Còn job đang chạy',
    message: 'message',
    detail: 'detail',
    noLink: true
  } as const
}
