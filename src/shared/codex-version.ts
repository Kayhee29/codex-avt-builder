/**
 * The one place the minimum Codex CLI version is written down (spec section
 * 5.3).
 *
 * `image_gen` only exists in Codex CLI releases from March 2026 on, so a job
 * run by an older CLI cannot produce an image at all. The preflight of plan
 * Task 3.2 compares `codex --version` against this constant and fails with
 * `CODEX_VERSION_UNSUPPORTED`; the job packet records it in `executor`
 * (spec section 6.2) so a job stays readable after the constant moves.
 *
 * Raising it means capturing new JSONL fixtures as well (plan Task 6.3).
 *
 * Reading `codex --version` and comparing it live here too, so the constant and
 * the only two operations performed on it stay in one file and the renderer can
 * explain the requirement without going through IPC.
 *
 * Pure TypeScript with no Electron and no Node built-ins.
 */

import { SEMVER_REGEX } from './schemas.ts'

/** Spec section 5.3: the newest release at the time the spec was written. */
export const CODEX_MIN_VERSION = '0.158.0'

/**
 * What `codex --version` prints, for example `codex-cli 0.27.0`. Verified
 * against the 0.27.0 binary installed on the development machine, which writes
 * it to stdout and exits 0.
 */
export const CODEX_VERSION_OUTPUT_REGEX = /codex-cli\s+(\d+\.\d+\.\d+)/

/** The version in `codex --version` output, or `null` when there is none. */
export function parseCodexVersion(output: string): string | null {
  return CODEX_VERSION_OUTPUT_REGEX.exec(output)?.[1] ?? null
}

/**
 * `-1`, `0` or `1`, comparing two `<major>.<minor>.<patch>` strings
 * numerically, so `0.27.0` sorts below `0.158.0` where a string compare would
 * not.
 *
 * This is deliberately not the `semver` package. `SemverSchema` in
 * `./schemas.ts` — the source of truth for every version this app stores or
 * sends over IPC — accepts three numeric components and nothing else, so a
 * pre-release or build-metadata comparison could never be represented anyway,
 * and the project keeps its two runtime dependencies (plan decision Q11 makes
 * the same trade for image formats). A version that does not match
 * {@link SEMVER_REGEX} throws rather than comparing as something arbitrary.
 */
export function compareCodexVersions(a: string, b: string): -1 | 0 | 1 {
  const left = versionParts(a)
  const right = versionParts(b)

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)

    if (difference !== 0) {
      return difference < 0 ? -1 : 1
    }
  }

  return 0
}

/** Whether `version` is at least `minimum`, the check of spec section 5.3. */
export function isCodexVersionSupported(
  version: string,
  minimum: string = CODEX_MIN_VERSION
): boolean {
  return compareCodexVersions(version, minimum) >= 0
}

function versionParts(version: string): readonly number[] {
  if (!SEMVER_REGEX.test(version)) {
    throw new TypeError(`Not a <major>.<minor>.<patch> version: ${JSON.stringify(version)}`)
  }

  return version.split('.').map(Number)
}
