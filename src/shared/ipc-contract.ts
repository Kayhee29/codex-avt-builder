/**
 * The typed IPC contract (spec section 8, plan Task 1.6 and decision Q7).
 *
 * Every channel the preload bridge exposes is listed here with a zod schema for
 * its request and one for its success payload. The preload validates a request
 * before `ipcRenderer.invoke`, the main process validates it again before it
 * runs anything (spec section 8), and nothing outside this table is reachable
 * from the renderer.
 *
 * Security, spec section 11: the renderer never sends a raw command, an
 * executable path, a shell argument or a working directory. That is why
 *
 * - a reference crosses as an opaque `referenceId`, never a path (decision Q3);
 * - `displayPath` is stripped from every request, so the only path-shaped
 *   string main ever produced for display cannot come back in;
 * - an approved output is named by its job ID and its index in `result.json`,
 *   not by a file name;
 * - the single exception is `system.setSettings`, whose `codexExecutable` is
 *   the user's own override for the resolved Codex binary (spec section 5.3).
 *
 * `tests/unit/ipc-contract.test.ts` walks these request schemas and fails on
 * any other path-shaped field name.
 *
 * Pure TypeScript with no Electron and no Node built-ins.
 */
import { z } from 'zod'

import { ProgressEventSchema, RunStateSchema } from './progress.ts'
import { MAX_REFERENCES } from './reference-roles.ts'
import {
  AnchorSchema,
  BuilderReferenceSchema,
  BuilderStateSchema,
  CompositionDefaultsSchema,
  IsoTimestampSchema,
  JobIdSchema,
  JobPacketSchema,
  LibraryIdSchema,
  OutputDefaultsSchema,
  PresetSchema,
  ReferenceRoleSchema,
  RESULT_ERROR_CODES,
  ResultErrorCodeSchema,
  ResultSchema,
  RoleNotesSchema,
  SemverSchema,
  SettingsSchema,
  Sha256Schema
} from './schemas.ts'

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/**
 * What a rejected IPC call may report. The run error codes of spec section 7.4
 * plus the four an IPC call can fail with before a job exists.
 *
 * Messages crossing to the renderer are short and sanitized; the technical
 * detail stays in `events.jsonl`, `stderr.log` and `last-message.txt`
 * (spec sections 7.4 and 11).
 */
export const IPC_ERROR_CODES = [
  ...RESULT_ERROR_CODES,
  'INVALID_REQUEST',
  'NOT_FOUND',
  'ALREADY_RUNNING',
  'IO_ERROR'
] as const

export const IpcErrorCodeSchema = z.enum(IPC_ERROR_CODES)

export type IpcErrorCode = z.infer<typeof IpcErrorCodeSchema>

export const IpcErrorSchema = z.strictObject({
  ok: z.literal(false),
  code: IpcErrorCodeSchema,
  message: z.string().min(1)
})

/** Wraps a channel's success payload in the envelope main replies with. */
export function ipcResultSchema<T extends z.ZodType>(payload: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), data: payload }),
    IpcErrorSchema
  ])
}

export type IpcResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: IpcErrorCode; readonly message: string }

// ---------------------------------------------------------------------------
// What the renderer is allowed to send
// ---------------------------------------------------------------------------

/**
 * A reference as the renderer sends it back.
 *
 * `displayPath` is dropped: main produced it for display and the renderer must
 * never hand a path back (spec section 11). `thumbnail` is dropped for the same
 * reason, minus the security argument: main rendered it, main's reference
 * registry still holds it, and sending several base64 images back on every
 * autosave would be waste. The rest is the handle's own metadata; main treats
 * it as untrusted display state and re-measures every reference from its
 * registry when it materializes a job (spec section 5.2).
 */
export const BuilderReferenceInputSchema = BuilderReferenceSchema.omit({
  displayPath: true,
  thumbnail: true
})

export type BuilderReferenceInput = z.infer<typeof BuilderReferenceInputSchema>

/** A builder state as the renderer sends it back (see above). */
export const BuilderStateInputSchema = BuilderStateSchema.extend({
  references: z.array(BuilderReferenceInputSchema).max(MAX_REFERENCES)
})

export type BuilderStateInput = z.infer<typeof BuilderStateInputSchema>

/**
 * A preset as the renderer asks for it to be saved. The style image is named by
 * the handle main issued; main copies the file into
 * `workspace/presets/<id>/style.<ext>` (plan decision Q4) and fills in the
 * metadata. `id` is null when this is a new preset.
 */
export const PresetInputSchema = z.strictObject({
  id: LibraryIdSchema.nullable(),
  name: z.string().min(1),
  styleReferenceId: z.uuid().nullable(),
  roleNotes: RoleNotesSchema,
  promptConventions: z.array(z.string().min(1)),
  negativeConstraints: z.array(z.string().min(1)),
  composition: CompositionDefaultsSchema,
  output: OutputDefaultsSchema
})

export type PresetInput = z.infer<typeof PresetInputSchema>

/**
 * An approved output an anchor may keep (spec section 4.5), named by its job
 * and its position in that job's `result.json` rather than by a file name, so
 * no path crosses IPC.
 */
export const ApprovedOutputRefSchema = z.strictObject({
  jobId: JobIdSchema,
  outputIndex: z.int().nonnegative()
})

/**
 * An anchor version as the renderer asks for it to be saved. Main resolves the
 * identity image from the handle, copies it into
 * `workspace/anchors/<id>/v<N>/` and picks the version with
 * `nextAnchorVersion`, so the renderer never chooses a version number.
 */
export const AnchorInputSchema = z.strictObject({
  id: LibraryIdSchema.nullable(),
  name: z.string().min(1),
  identityReferenceId: z.uuid(),
  approvedOutput: ApprovedOutputRefSchema.nullable(),
  identityDescription: z.string(),
  immutableTraits: z.array(z.string().min(1)),
  mutableTraits: z.array(z.string().min(1)),
  sourceJobId: JobIdSchema.nullable()
})

export type AnchorInput = z.infer<typeof AnchorInputSchema>

/** The only setting the renderer may change (plan decision Q7). */
export const SettingsPatchSchema = z.strictObject({
  codexExecutable: z.string().min(1).nullable()
})

export type SettingsPatch = z.infer<typeof SettingsPatchSchema>

// ---------------------------------------------------------------------------
// What main sends back
// ---------------------------------------------------------------------------

/** A preset together with the handle for its stored style image, if any. */
export const PresetEntrySchema = z.strictObject({
  preset: PresetSchema,
  styleReference: BuilderReferenceSchema.nullable()
})

export type PresetEntry = z.infer<typeof PresetEntrySchema>

/** One anchor version together with the handle for its identity image. */
export const AnchorEntrySchema = z.strictObject({
  anchor: AnchorSchema,
  identityReference: BuilderReferenceSchema.nullable()
})

export type AnchorEntry = z.infer<typeof AnchorEntrySchema>

/**
 * A row of the recent jobs list (spec section 4.6). `state` comes from
 * `result.json`, or from the run in progress; a job with no `result.json` that
 * main is not running shows as `failed` with `INTERRUPTED` (spec section 12).
 */
export const JobSummarySchema = z.strictObject({
  jobId: JobIdSchema,
  subjectName: z.string(),
  state: RunStateSchema,
  createdAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
  preset: LibraryIdSchema.nullable(),
  anchor: LibraryIdSchema.nullable(),
  outputCount: z.int().nonnegative(),
  errorCode: ResultErrorCodeSchema.nullable(),
  warnings: z.array(z.string().min(1)),
  thumbnailDataUrl: z.string().min(1).nullable()
})

export type JobSummary = z.infer<typeof JobSummarySchema>

/** Result of the version and login checks of spec section 5.3. */
export const PreflightResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    version: SemverSchema,
    executable: z.string().min(1)
  }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(['CODEX_NOT_FOUND', 'CODEX_VERSION_UNSUPPORTED', 'CODEX_NOT_AUTHENTICATED']),
    message: z.string().min(1)
  })
])

export type PreflightResult = z.infer<typeof PreflightResultSchema>

/** A channel that takes no arguments still takes an object, so it can grow. */
const NoRequestSchema = z.strictObject({})

// ---------------------------------------------------------------------------
// The channels
// ---------------------------------------------------------------------------

export interface IpcChannelDefinition {
  /** `invoke` is renderer to main and back; `event` is main pushing. */
  readonly kind: 'invoke' | 'event'
  /** What the renderer may send. For an event channel, the subscribe call. */
  readonly request: z.ZodType
  /** The success payload. Main wraps it with {@link ipcResultSchema}. */
  readonly response: z.ZodType
}

/**
 * Every channel of spec section 8, plus the four of plan decision Q7. The
 * preload exposes these and nothing else (spec section 11).
 */
export const IPC_CHANNELS = {
  /** Opens the file picker for one role and registers the file main chose. */
  'dialog.selectReference': {
    kind: 'invoke',
    request: z.strictObject({ role: ReferenceRoleSchema }),
    response: z.strictObject({ reference: BuilderReferenceSchema.nullable() })
  },

  /** Reads `workspace/drafts/current.json` and re-registers its references. */
  'draft.load': {
    kind: 'invoke',
    request: NoRequestSchema,
    response: z.strictObject({
      draft: z.strictObject({ state: BuilderStateSchema, savedAt: IsoTimestampSchema }).nullable()
    })
  },

  /** Autosaves the builder state (spec section 4.6). */
  'draft.save': {
    kind: 'invoke',
    request: z.strictObject({ state: BuilderStateInputSchema }),
    response: z.strictObject({ savedAt: IsoTimestampSchema })
  },

  'library.listPresets': {
    kind: 'invoke',
    request: NoRequestSchema,
    response: z.strictObject({ presets: z.array(PresetEntrySchema) })
  },

  'library.savePreset': {
    kind: 'invoke',
    request: z.strictObject({ preset: PresetInputSchema }),
    response: z.strictObject({ preset: PresetEntrySchema })
  },

  /** Plan decision Q7. Removes `workspace/presets/<id>/` and its image. */
  'library.deletePreset': {
    kind: 'invoke',
    request: z.strictObject({ id: LibraryIdSchema }),
    response: z.strictObject({ id: LibraryIdSchema })
  },

  'library.listAnchors': {
    kind: 'invoke',
    request: NoRequestSchema,
    response: z.strictObject({ anchors: z.array(AnchorEntrySchema) })
  },

  /** Saves a new anchor version; main picks the version (spec section 4.5). */
  'library.saveAnchor': {
    kind: 'invoke',
    request: z.strictObject({ anchor: AnchorInputSchema }),
    response: z.strictObject({ anchor: AnchorEntrySchema })
  },

  'jobs.list': {
    kind: 'invoke',
    request: NoRequestSchema,
    response: z.strictObject({ jobs: z.array(JobSummarySchema) })
  },

  /**
   * One job. `references` are handles main registered for the files in the
   * job's `inputs/`, so the UI can duplicate a job into a new draft without
   * ever seeing a path (plan Task 5.5).
   */
  'jobs.get': {
    kind: 'invoke',
    request: z.strictObject({ jobId: JobIdSchema }),
    response: z.strictObject({
      job: JobPacketSchema,
      result: ResultSchema.nullable(),
      references: z.array(BuilderReferenceSchema)
    })
  },

  /**
   * Materializes a job and runs it (spec section 5.2).
   *
   * `promptSha256` is the checksum of the prompt the renderer previewed. Main
   * rebuilds the prompt from `state` and refuses the job with `INVALID_JOB`
   * when the two differ (spec section 10, plan Task 2.5), which is why the
   * checksum rides on the request instead of inside `BuilderState`.
   */
  'jobs.generate': {
    kind: 'invoke',
    request: z.strictObject({ state: BuilderStateInputSchema, promptSha256: Sha256Schema }),
    response: z.strictObject({ jobId: JobIdSchema })
  },

  'jobs.cancel': {
    kind: 'invoke',
    request: z.strictObject({ jobId: JobIdSchema }),
    response: z.strictObject({ cancelled: z.boolean() })
  },

  /** Reveals the job directory with `shell.showItemInFolder` (plan Task 3.7). */
  'jobs.openFolder': {
    kind: 'invoke',
    request: z.strictObject({ jobId: JobIdSchema }),
    response: z.strictObject({ opened: z.boolean() })
  },

  /** Main pushes one of these per state change and per activity line. */
  'jobs.onProgress': {
    kind: 'event',
    request: NoRequestSchema,
    response: ProgressEventSchema
  },

  /** Plan decision Q7. Cached per session; `force` runs the checks again. */
  'system.preflight': {
    kind: 'invoke',
    request: z.strictObject({ force: z.boolean().optional() }),
    response: z.strictObject({ preflight: PreflightResultSchema })
  },

  /** Plan decision Q7. */
  'system.getSettings': {
    kind: 'invoke',
    request: NoRequestSchema,
    response: z.strictObject({ settings: SettingsSchema })
  },

  /**
   * Plan decision Q7. The one place the renderer may send something the main
   * process turns into a path: the user's own override for the Codex
   * executable (spec section 5.3). Main still resolves and checks it, and on
   * Windows still refuses anything that is not a real `.exe`.
   */
  'system.setSettings': {
    kind: 'invoke',
    request: z.strictObject({ patch: SettingsPatchSchema }),
    response: z.strictObject({ settings: SettingsSchema })
  }
} as const satisfies Record<string, IpcChannelDefinition>

export type IpcChannelName = keyof typeof IPC_CHANNELS

/** Every channel name, for the preload allowlist test of plan Task 4.1. */
export const IPC_CHANNEL_NAMES = Object.keys(IPC_CHANNELS) as IpcChannelName[]

export type IpcRequest<C extends IpcChannelName> = z.infer<(typeof IPC_CHANNELS)[C]['request']>

export type IpcResponse<C extends IpcChannelName> = z.infer<(typeof IPC_CHANNELS)[C]['response']>
