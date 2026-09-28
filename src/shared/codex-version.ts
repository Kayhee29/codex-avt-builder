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
 * Pure TypeScript with no Electron and no Node built-ins.
 */

/** Spec section 5.3: the newest release at the time the spec was written. */
export const CODEX_MIN_VERSION = '0.158.0'
