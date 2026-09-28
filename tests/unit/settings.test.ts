import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  settingsPath,
  updateSettings
} from '../../src/main/settings.ts'
import { SCHEMA_VERSION } from '../../src/shared/schemas.ts'
import { createTempWorkspace, type TempWorkspace } from '../helpers/tmp-workspace.ts'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.remove()
})

describe('loadSettings', () => {
  it('returns the defaults when no settings file was ever written', async () => {
    expect(await loadSettings(workspace.root)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the defaults instead of throwing on unreadable JSON', async () => {
    await writeFile(settingsPath(workspace.root), '{ not json', 'utf8')

    expect(await loadSettings(workspace.root)).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to the defaults on a file that does not match the schema', async () => {
    await writeFile(settingsPath(workspace.root), JSON.stringify({ codexExecutable: 7 }), 'utf8')

    expect(await loadSettings(workspace.root)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('saveSettings and updateSettings', () => {
  it('round trips the Codex executable override', async () => {
    const path = 'C:\\tools\\codex-x86_64-pc-windows-msvc.exe'

    await updateSettings(workspace.root, { codexExecutable: path })

    expect(await loadSettings(workspace.root)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      codexExecutable: path
    })
  })

  it('writes the file inside the workspace root, not next to the code', async () => {
    await updateSettings(workspace.root, { codexExecutable: 'C:\\tools\\codex.exe' })

    expect(settingsPath(workspace.root)).toBe(join(workspace.root, 'settings.json'))
    await expect(readFile(settingsPath(workspace.root), 'utf8')).resolves.toContain('codex.exe')
  })

  it('trims the path and turns a blank one into null', async () => {
    await updateSettings(workspace.root, { codexExecutable: '   C:\\tools\\codex.exe   ' })

    expect((await loadSettings(workspace.root)).codexExecutable).toBe('C:\\tools\\codex.exe')

    await updateSettings(workspace.root, { codexExecutable: '   ' })

    expect((await loadSettings(workspace.root)).codexExecutable).toBeNull()
  })

  it('clears the override when the patch is null', async () => {
    await updateSettings(workspace.root, { codexExecutable: 'C:\\tools\\codex.exe' })
    await updateSettings(workspace.root, { codexExecutable: null })

    expect((await loadSettings(workspace.root)).codexExecutable).toBeNull()
  })

  it('refuses to write settings that do not validate', async () => {
    await expect(
      saveSettings(workspace.root, {
        schemaVersion: 2 as unknown as typeof SCHEMA_VERSION,
        codexExecutable: null
      })
    ).rejects.toThrow()
  })
})
