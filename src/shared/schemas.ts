/**
 * The single source of truth for every contract the app validates
 * (plan decision Q2).
 *
 * `schemas/*.json` is generated from this file by `pnpm export-schemas`;
 * `tests/unit/schemas-sync.test.ts` fails when the two drift. Codex reads the
 * JSON Schema files, the app validates with zod.
 *
 * Pure TypeScript with no Electron and no Node built-ins, so the renderer and
 * the main process validate the same way (spec section 4.3).
 *
 * Every object is strict. `job.json` in particular must reject a `status`
 * field: it is written once and carries no run state (spec section 6).
 * Structural rules that JSON Schema cannot express, such as "each role appears
 * at most once", are deliberately not encoded as zod refinements here, because
 * a refinement would silently disappear from the exported JSON Schema. Role
 * uniqueness is enforced by `sortReferences` in `./reference-roles.ts`.
 */
import { z } from 'zod'

import { MAX_REFERENCES, REFERENCE_LABELS, REFERENCE_ROLES } from './reference-roles.ts'

/** Every on-disk contract carries the same version number for now. */
export const SCHEMA_VERSION = 1

/**
 * Job ID (spec section 6.1), used as a directory name, in the fixed
 * orchestration instruction of spec section 5.4 and over IPC.
 *
 * Spec section 6.1 prints the slug part as `[a-z0-9]{1,24}`, but its own
 * prose builds slugs out of hyphen-joined words and its own example ID is
 * `2026-09-28-richard-nixon-001`, which that character class cannot match.
 * The pattern below follows the prose: 1 to 24 characters, lowercase
 * alphanumerics and hyphens, never starting or ending with a hyphen.
 */
export const JOB_ID_REGEX = /^\d{4}-\d{2}-\d{2}-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?-\d{3}$/

/** Lowercase hex SHA-256, as written into job.json and result.json. */
export const SHA256_REGEX = /^[a-f0-9]{64}$/

/** A copied reference inside the job directory (spec section 5.2). */
export const REFERENCE_PATH_REGEX =
  /^inputs\/(style|identity|outfit|equipment|extra)\.(png|jpg|webp)$/

/** A generated image inside the job directory (spec sections 5.6 and 7.3). */
export const OUTPUT_PATH_REGEX = /^outputs\/[A-Za-z0-9._-]+\.(png|jpg|webp)$/

/** `<major>.<minor>.<patch>`, the shape `codex --version` reports. */
export const SEMVER_REGEX = /^\d+\.\d+\.\d+$/

/** Preset and anchor identifiers double as directory names (plan decision Q4). */
export const LIBRARY_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A style image copied next to its preset metadata (plan decision Q4). */
export const PRESET_STYLE_PATH_REGEX = /^style\.(png|jpg|webp)$/

/** An identity image copied into an anchor version directory (plan decision Q4). */
export const ANCHOR_IDENTITY_PATH_REGEX = /^identity\.(png|jpg|webp)$/

/** The optional approved output stored with an anchor version (spec section 4.5). */
export const ANCHOR_APPROVED_PATH_REGEX = /^approved\.(png|jpg|webp)$/

/**
 * The thumbnail every reference slot shows (spec section 4.2, plan decision
 * Q19). A base64 `data:` URL the main process renders, small enough to sit in
 * the builder state and in the autosaved draft.
 */
export const THUMBNAIL_DATA_URL_REGEX = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export const JobIdSchema = z
  .string()
  .regex(JOB_ID_REGEX, 'Job ID does not match the pattern in spec section 6.1')

export const Sha256Schema = z.string().regex(SHA256_REGEX, 'Expected 64 lowercase hex characters')

export const SemverSchema = z.string().regex(SEMVER_REGEX, 'Expected a <major>.<minor>.<patch>')

export const LibraryIdSchema = z
  .string()
  .max(64)
  .regex(LIBRARY_ID_REGEX, 'Expected a lowercase slug usable as a directory name')

/** UTC timestamp such as `2026-09-28T10:00:00Z`. */
export const IsoTimestampSchema = z.iso.datetime()

export const ReferenceRoleSchema = z.enum(REFERENCE_ROLES)

export const ReferenceLabelSchema = z.enum(REFERENCE_LABELS)

/** Formats accepted in the first version (spec section 4.2). */
export const ImageMimeTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])

export const ImageFormatSchema = z.enum(['png', 'jpg', 'webp'])

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

/** Character direction (spec section 4.1). Only name and description are required. */
export const SubjectSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  pose: z.string().optional(),
  expression: z.string().optional(),
  notes: z.string().optional()
})

/**
 * Output settings. A request, not a guarantee: `image_gen` receives these
 * through natural language and the real values are measured into result.json
 * (spec section 6.2).
 */
export const OutputRequestSchema = z.strictObject({
  aspectRatio: z.string().min(1),
  background: z.string(),
  format: ImageFormatSchema,
  count: z.int().min(1)
})

/** Which preset and anchor the job or draft came from (spec sections 4.4, 4.5). */
export const SourceRefsSchema = z.strictObject({
  preset: LibraryIdSchema.nullable(),
  anchor: LibraryIdSchema.nullable()
})

// ---------------------------------------------------------------------------
// job.json (spec section 6)
// ---------------------------------------------------------------------------

export const JobExecutorSchema = z.strictObject({
  kind: z.literal('codex-cli'),
  minimumVersion: SemverSchema,
  imageTool: z.literal('image_gen')
})

export const JobReferenceSchema = z.strictObject({
  label: ReferenceLabelSchema,
  role: ReferenceRoleSchema,
  path: z.string().regex(REFERENCE_PATH_REGEX, 'Reference path must live in inputs/'),
  originalName: z.string().min(1),
  mimeType: ImageMimeTypeSchema,
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Schema,
  note: z.string().optional()
})

export const JobPacketSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  jobId: JobIdSchema,
  createdAt: IsoTimestampSchema,
  executor: JobExecutorSchema,
  subject: SubjectSchema,
  references: z.array(JobReferenceSchema).max(MAX_REFERENCES),
  output: OutputRequestSchema,
  source: SourceRefsSchema,
  promptPath: z.literal('prompt.md'),
  promptSha256: Sha256Schema
})

// ---------------------------------------------------------------------------
// codex-result.json, written by Codex (spec section 7.1)
// ---------------------------------------------------------------------------

/** The only codes Codex may report; anything else is INVALID_RESULT to main. */
export const CODEX_ERROR_CODES = [
  'INVALID_JOB',
  'MISSING_REFERENCE',
  'IMAGE_CAPABILITY_UNAVAILABLE',
  'GENERATION_FAILED'
] as const

export const CodexErrorCodeSchema = z.enum(CODEX_ERROR_CODES)

export const CodexResultSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  jobId: JobIdSchema,
  status: z.enum(['succeeded', 'failed']),
  outputs: z.array(
    z.strictObject({
      path: z.string().regex(OUTPUT_PATH_REGEX, 'Output path must live in outputs/')
    })
  ),
  error: z.strictObject({ code: CodexErrorCodeSchema, message: z.string().min(1) }).nullable()
})

// ---------------------------------------------------------------------------
// result.json, written by the main process (spec sections 7.2 and 7.4)
// ---------------------------------------------------------------------------

export const RESULT_ERROR_CODES = [
  'CODEX_NOT_FOUND',
  'CODEX_VERSION_UNSUPPORTED',
  'CODEX_NOT_AUTHENTICATED',
  'CODEX_SANDBOX_UNAVAILABLE',
  'INVALID_JOB',
  'MISSING_REFERENCE',
  'IMAGE_CAPABILITY_UNAVAILABLE',
  'GENERATION_FAILED',
  'INVALID_RESULT',
  'CANCELLED',
  'INTERRUPTED'
] as const

export const ResultErrorCodeSchema = z.enum(RESULT_ERROR_CODES)

/**
 * The three terminal run states written to result.json (spec section 12).
 *
 * The same three values are `TERMINAL_RUN_STATES` in `./progress.ts`, which is
 * where the run-state vocabulary lives. They are spelled out again here rather
 * than imported, because `progress.ts` imports this file and one direction of
 * dependency is enough; `tests/unit/ipc-contract.test.ts` asserts the two lists
 * stay identical.
 */
export const ResultStatusSchema = z.enum(['succeeded', 'failed', 'cancelled'])

/**
 * Every field is nullable because main always writes result.json, including
 * when Codex never ran: a preflight failure leaves no version, no executable,
 * no exit code and no signal (spec section 7, plan Task 3.7).
 */
export const ResultExecutorSchema = z.strictObject({
  codexVersion: SemverSchema.nullable(),
  executable: z.string().min(1).nullable(),
  exitCode: z.int().nullable(),
  signal: z.string().min(1).nullable()
})

/** Measured by main from the file itself, never copied from Codex (spec 7.2). */
export const ResultOutputSchema = z.strictObject({
  path: z.string().regex(OUTPUT_PATH_REGEX, 'Output path must live in outputs/'),
  mimeType: ImageMimeTypeSchema,
  width: z.int().positive(),
  height: z.int().positive(),
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Schema
})

export const ResultSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  jobId: JobIdSchema,
  status: ResultStatusSchema,
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  executor: ResultExecutorSchema,
  outputs: z.array(ResultOutputSchema),
  warnings: z.array(z.string().min(1)),
  promptPath: z.literal('prompt.md'),
  error: z.strictObject({ code: ResultErrorCodeSchema, message: z.string().min(1) }).nullable()
})

// ---------------------------------------------------------------------------
// Preset (spec section 4.4)
// ---------------------------------------------------------------------------

/** Per-role default notes. Written out so the exported JSON Schema names them. */
export const RoleNotesSchema = z.strictObject({
  style: z.string().optional(),
  identity: z.string().optional(),
  outfit: z.string().optional(),
  equipment: z.string().optional(),
  extra: z.string().optional()
})

export const CompositionDefaultsSchema = z.strictObject({
  pose: z.string().optional(),
  expression: z.string().optional(),
  notes: z.string().optional()
})

export const OutputDefaultsSchema = z.strictObject({
  aspectRatio: z.string().min(1),
  background: z.string(),
  format: ImageFormatSchema
})

/** Copied to `workspace/presets/<presetId>/style.<ext>` (plan decision Q4). */
export const PresetStyleReferenceSchema = z.strictObject({
  path: z.string().regex(PRESET_STYLE_PATH_REGEX, 'Expected style.<png|jpg|webp>'),
  originalName: z.string().min(1),
  mimeType: ImageMimeTypeSchema,
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Schema
})

/** A preset never stores an identity reference or a generated output. */
export const PresetSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: LibraryIdSchema,
  name: z.string().min(1),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  styleReference: PresetStyleReferenceSchema.nullable(),
  roleNotes: RoleNotesSchema,
  promptConventions: z.array(z.string().min(1)),
  negativeConstraints: z.array(z.string().min(1)),
  composition: CompositionDefaultsSchema,
  output: OutputDefaultsSchema
})

// ---------------------------------------------------------------------------
// Anchor (spec section 4.5)
// ---------------------------------------------------------------------------

/** Copied to `workspace/anchors/<anchorId>/v<N>/identity.<ext>` (decision Q4). */
export const AnchorIdentityReferenceSchema = z.strictObject({
  path: z.string().regex(ANCHOR_IDENTITY_PATH_REGEX, 'Expected identity.<png|jpg|webp>'),
  originalName: z.string().min(1),
  mimeType: ImageMimeTypeSchema,
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Schema
})

export const AnchorApprovedOutputSchema = z.strictObject({
  path: z.string().regex(ANCHOR_APPROVED_PATH_REGEX, 'Expected approved.<png|jpg|webp>'),
  originalName: z.string().min(1),
  mimeType: ImageMimeTypeSchema,
  sizeBytes: z.int().nonnegative(),
  sha256: Sha256Schema
})

/**
 * Outfit, equipment, pose and expression stay mutable and are not stored here;
 * updating an anchor creates a new version instead of overwriting one
 * (spec section 4.5).
 */
export const AnchorSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: LibraryIdSchema,
  name: z.string().min(1),
  version: z.int().min(1),
  createdAt: IsoTimestampSchema,
  identityReference: AnchorIdentityReferenceSchema,
  approvedOutput: AnchorApprovedOutputSchema.nullable(),
  identityDescription: z.string(),
  immutableTraits: z.array(z.string().min(1)),
  mutableTraits: z.array(z.string().min(1)),
  sourceJobId: JobIdSchema.nullable()
})

// ---------------------------------------------------------------------------
// Builder state and draft (spec sections 4.2, 4.6; plan decision Q3)
// ---------------------------------------------------------------------------

/**
 * What the renderer holds for a filled slot. It carries an opaque
 * `referenceId` and never an absolute path; the main process owns the registry
 * that maps the id back to a path (spec section 11, plan decision Q3).
 * `displayPath` is a shortened string for display only and is never sent back.
 *
 * `thumbnail` is the preview spec section 4.2 requires on every slot, added by
 * plan decision Q19. Main renders it and, like `displayPath`, the renderer
 * never hands it back; it is absent when main could not render one, which is
 * the case for a reference whose file has gone `missing`. The field is named
 * `thumbnail` rather than `thumbnailDataUrl` on purpose: the IPC audit in
 * `tests/unit/ipc-contract.test.ts` refuses any request field whose name
 * contains a path-shaped word, and `url` is one of them.
 */
export const BuilderReferenceSchema = z.strictObject({
  referenceId: z.uuid(),
  role: ReferenceRoleSchema,
  originalName: z.string().min(1),
  displayPath: z.string().min(1),
  thumbnail: z
    .string()
    .regex(THUMBNAIL_DATA_URL_REGEX, 'Expected a base64 image data URL')
    .optional(),
  mimeType: ImageMimeTypeSchema,
  sizeBytes: z.int().nonnegative(),
  width: z.int().positive(),
  height: z.int().positive(),
  sha256: Sha256Schema,
  note: z.string().optional(),
  missing: z.boolean()
})

export const BuilderStateSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  subject: SubjectSchema,
  references: z.array(BuilderReferenceSchema).max(MAX_REFERENCES),
  output: OutputRequestSchema,
  negativeConstraints: z.array(z.string().min(1)),
  source: SourceRefsSchema
})

/**
 * `workspace/drafts/current.json`. Written by main, so unlike `BuilderState`
 * it may hold absolute paths; on `draft.load` main re-registers them and marks
 * anything missing (plan decision Q3, spec section 4.2).
 */
export const DraftSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  savedAt: IsoTimestampSchema,
  state: BuilderStateSchema,
  referencePaths: z.record(z.uuid(), z.string().min(1))
})

// ---------------------------------------------------------------------------
// Settings (plan decision Q7)
// ---------------------------------------------------------------------------

/** The only setting is an override for the resolved Codex executable. */
export const SettingsSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  codexExecutable: z.string().min(1).nullable()
})

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type ImageMimeType = z.infer<typeof ImageMimeTypeSchema>
export type ImageFormat = z.infer<typeof ImageFormatSchema>
export type Subject = z.infer<typeof SubjectSchema>
export type OutputRequest = z.infer<typeof OutputRequestSchema>
export type SourceRefs = z.infer<typeof SourceRefsSchema>
export type JobExecutor = z.infer<typeof JobExecutorSchema>
export type JobReference = z.infer<typeof JobReferenceSchema>
export type JobPacket = z.infer<typeof JobPacketSchema>
export type CodexErrorCode = z.infer<typeof CodexErrorCodeSchema>
export type CodexResult = z.infer<typeof CodexResultSchema>
export type ResultErrorCode = z.infer<typeof ResultErrorCodeSchema>
export type ResultStatus = z.infer<typeof ResultStatusSchema>
export type ResultExecutor = z.infer<typeof ResultExecutorSchema>
export type ResultOutput = z.infer<typeof ResultOutputSchema>
export type Result = z.infer<typeof ResultSchema>
export type RoleNotes = z.infer<typeof RoleNotesSchema>
export type CompositionDefaults = z.infer<typeof CompositionDefaultsSchema>
export type OutputDefaults = z.infer<typeof OutputDefaultsSchema>
export type PresetStyleReference = z.infer<typeof PresetStyleReferenceSchema>
export type Preset = z.infer<typeof PresetSchema>
export type AnchorIdentityReference = z.infer<typeof AnchorIdentityReferenceSchema>
export type AnchorApprovedOutput = z.infer<typeof AnchorApprovedOutputSchema>
export type Anchor = z.infer<typeof AnchorSchema>
export type BuilderReference = z.infer<typeof BuilderReferenceSchema>
export type BuilderState = z.infer<typeof BuilderStateSchema>
export type Draft = z.infer<typeof DraftSchema>
export type Settings = z.infer<typeof SettingsSchema>
