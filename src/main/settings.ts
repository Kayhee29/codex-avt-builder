/**
 * App settings (plan Task 3.1, decision Q7).
 *
 * There is exactly one setting: `codexExecutable`, the user's own override for
 * the Codex binary the resolver would otherwise find (spec section 5.3). It
 * exists because the npm layout of `@openai/codex` can change under us, and the
 * plan's risk table names this override as the way out when it does.
 *
 * Settings live in `workspace/settings.json`, next to the four directories of
 * spec section 9, so a workspace carries its own configuration and the
 * Playwright harness of plan Task 6.1 gets a clean one for free by pointing
 * `STUDIO_WORKSPACE` somewhere else. The file holds a machine-specific absolute
 * path, so `.gitignore` excludes it.
 *
 * A missing or unreadable file is not an error: the app has working defaults
 * and the user should not be blocked by a settings file they never wrote. A
 * file that exists but does not validate is replaced by the defaults on the
 * next write rather than throwing, for the same reason.
 *
 * Node built-ins are allowed here; Electron is not imported at all — the
 * workspace root arrives as a path.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SettingsPatch } from '../shared/ipc-contract.ts'
import { SCHEMA_VERSION, SettingsSchema, type Settings } from '../shared/schemas.ts'

import { writeJsonAtomically } from './library.ts'
import { workspaceLayout } from './workspace.ts'

/** The file inside the workspace root that holds {@link Settings}. */
export const SETTINGS_FILE_NAME = 'settings.json'

/** What the app uses until the user changes something. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  codexExecutable: null
})

/** Where {@link loadSettings} reads from and {@link saveSettings} writes to. */
export function settingsPath(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).root, SETTINGS_FILE_NAME)
}

/**
 * Reads `workspace/settings.json`.
 *
 * Returns {@link DEFAULT_SETTINGS} when the file is missing, is not JSON or
 * does not match the schema. The one thing it does not swallow is a real I/O
 * failure such as a permission error, which the caller should see.
 */
export async function loadSettings(workspaceRoot: string): Promise<Settings> {
  let raw: string

  try {
    raw = await readFile(settingsPath(workspaceRoot), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...DEFAULT_SETTINGS }
    }

    throw error
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS }
  }

  const result = SettingsSchema.safeParse(parsed)

  return result.success ? result.data : { ...DEFAULT_SETTINGS }
}

/** Writes settings atomically, validating them first. */
export async function saveSettings(workspaceRoot: string, settings: Settings): Promise<Settings> {
  const validated = SettingsSchema.parse(settings)

  await writeJsonAtomically(settingsPath(workspaceRoot), validated)

  return validated
}

/**
 * Applies the one patch `system.setSettings` may send (plan decision Q7) and
 * writes the result.
 *
 * The path is trimmed and an empty string becomes `null`, so clearing the
 * override in the UI cannot store a path that resolves to the current working
 * directory. Whether the path is usable is not decided here: the resolver of
 * `./codex-resolver.ts` checks it every time it runs, so a binary that is
 * deleted after the setting was saved still produces `CODEX_NOT_FOUND` rather
 * than a stale success.
 */
export async function updateSettings(
  workspaceRoot: string,
  patch: SettingsPatch
): Promise<Settings> {
  const current = await loadSettings(workspaceRoot)
  const trimmed = patch.codexExecutable?.trim() ?? null

  return saveSettings(workspaceRoot, {
    ...current,
    schemaVersion: SCHEMA_VERSION,
    codexExecutable: trimmed === '' ? null : trimmed
  })
}
