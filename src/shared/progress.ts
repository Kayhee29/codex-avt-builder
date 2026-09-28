/**
 * Run states and the progress payload (spec sections 5.5 and 12, plan Task
 * 1.6).
 *
 * There is exactly one run-state vocabulary and the main process is the only
 * thing that sets it. A state is never inferred from the name of a Codex event,
 * because Codex knows nothing about the app's phases (spec section 5.5).
 *
 * ```text
 * queued → preflight → running → verifying → succeeded
 *              │          │          │
 *              └──────────┴──────────┴──────→ failed
 *                         └─────────────────→ cancelled
 * ```
 *
 * This module imports from `./schemas.ts` and nothing there imports back, so
 * the two never form a cycle. `ResultStatusSchema` in `schemas.ts` holds the
 * same three terminal states; `tests/unit/ipc-contract.test.ts` asserts the two
 * lists agree.
 *
 * Pure TypeScript with no Electron and no Node built-ins.
 */
import { z } from 'zod'

import { IsoTimestampSchema, JobIdSchema } from './schemas.ts'

/** The seven run states of spec section 12, in the order they occur. */
export const RUN_STATES = [
  'queued',
  'preflight',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'cancelled'
] as const

/** The three states that end a run and are written to result.json. */
export const TERMINAL_RUN_STATES = ['succeeded', 'failed', 'cancelled'] as const

export const RunStateSchema = z.enum(RUN_STATES)

export type RunState = z.infer<typeof RunStateSchema>

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number]

/**
 * Payload of `jobs.onProgress` (spec section 5.5).
 *
 * `activity` is short display text such as "Đang gọi image_gen". It is
 * information for the UI only and must never be used to branch logic
 * (spec section 12). `seq` increases over a run so the UI can drop a late
 * event.
 */
export const ProgressEventSchema = z.strictObject({
  jobId: JobIdSchema,
  state: RunStateSchema,
  activity: z.string().optional(),
  seq: z.int().nonnegative(),
  at: IsoTimestampSchema
})

export type ProgressEvent = z.infer<typeof ProgressEventSchema>

/** Whether a run has ended. The three terminal states are also result.json's. */
export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly RunState[]).includes(state)
}
