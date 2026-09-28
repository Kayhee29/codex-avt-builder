/**
 * Regenerates `schemas/*.json` from the zod schemas in `src/shared/schemas.ts`
 * (plan Task 1.2, decision Q2).
 *
 * Codex reads the generated JSON Schema files from the job directory; the app
 * itself always validates with zod. `tests/unit/schemas-sync.test.ts` renders
 * the same files into a temp directory and fails when they differ from what is
 * committed.
 *
 * This is a build script and the one file in the schema layer allowed to use
 * Node built-ins. `src/shared/` stays free of them (spec section 4.3).
 *
 * Run it with `pnpm export-schemas`.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import {
  AnchorSchema,
  CodexResultSchema,
  DraftSchema,
  JobPacketSchema,
  PresetSchema,
  ResultSchema
} from '../src/shared/schemas.ts'

const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

export interface SchemaFile {
  /** File name inside `schemas/`. */
  readonly fileName: string
  readonly title: string
  readonly description: string
  readonly schema: z.ZodType
}

/**
 * The six on-disk contracts listed by plan Task 1.2. `BuilderState`,
 * `ProgressEvent` and `Settings` are validated with zod only: they never leave
 * the app as a file Codex has to read.
 */
export const SCHEMA_FILES: readonly SchemaFile[] = [
  {
    fileName: 'job.schema.json',
    title: 'JobPacket',
    description:
      'job.json, the immutable contract between the UI builder and the Codex CLI (spec section 6). Written once and carrying no run state.',
    schema: JobPacketSchema
  },
  {
    fileName: 'codex-result.schema.json',
    title: 'CodexResult',
    description:
      'codex-result.json, the executor report written by Codex (spec section 7.1). The UI never reads this file.',
    schema: CodexResultSchema
  },
  {
    fileName: 'result.schema.json',
    title: 'Result',
    description:
      'result.json, the verified outcome written by the Electron main process and the only result the UI reads (spec section 7.2).',
    schema: ResultSchema
  },
  {
    fileName: 'preset.schema.json',
    title: 'Preset',
    description:
      'A reusable set of style defaults. Presets never store an identity reference or a generated output (spec section 4.4).',
    schema: PresetSchema
  },
  {
    fileName: 'anchor.schema.json',
    title: 'Anchor',
    description:
      'One version of a character anchor. Updating an anchor adds a version instead of overwriting one (spec section 4.5).',
    schema: AnchorSchema
  },
  {
    fileName: 'draft.schema.json',
    title: 'Draft',
    description:
      'workspace/drafts/current.json, the autosaved builder state plus the reference paths main re-registers on load (spec section 4.6, plan decision Q3).',
    schema: DraftSchema
  }
]

/** `<repo>/schemas`. */
export const DEFAULT_OUTPUT_DIR = resolve(fileURLToPath(new URL('../schemas', import.meta.url)))

/** Renders one schema file, including its trailing newline. */
export function renderSchemaFile(file: SchemaFile): string {
  const { $schema, ...body } = z.toJSONSchema(file.schema, { target: 'draft-2020-12' })

  const document = {
    $schema: $schema ?? JSON_SCHEMA_DIALECT,
    title: file.title,
    description: file.description,
    ...body
  }

  return `${JSON.stringify(document, null, 2)}\n`
}

/** Writes every schema file into `outDir` and returns the paths written. */
export async function exportSchemas(outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true })

  const written: string[] = []

  for (const file of SCHEMA_FILES) {
    const target = join(outDir, file.fileName)

    await writeFile(target, renderSchemaFile(file), 'utf8')
    written.push(target)
  }

  return written
}

async function main(): Promise<void> {
  const outDir = process.argv[2] === undefined ? DEFAULT_OUTPUT_DIR : resolve(process.argv[2])
  const written = await exportSchemas(outDir)

  for (const target of written) {
    process.stdout.write(`wrote ${target}\n`)
  }
}

const entryPoint = process.argv[1]

if (entryPoint !== undefined && resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  await main()
}
