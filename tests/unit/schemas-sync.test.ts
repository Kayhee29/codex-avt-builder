import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_OUTPUT_DIR, exportSchemas, SCHEMA_FILES } from '../../scripts/export-schemas.ts'

/**
 * `src/shared/schemas.ts` is the source of truth and `schemas/*.json` is
 * generated from it (plan decision Q2). This test regenerates the files into a
 * temp directory and compares them byte for byte with what is committed.
 */
const REGENERATE =
  'The committed JSON Schema is stale. Run `pnpm export-schemas` and commit the result.'

let generatedDir = ''

beforeAll(async () => {
  generatedDir = await mkdtemp(join(tmpdir(), 'reference-image-studio-schemas-'))
  await exportSchemas(generatedDir)
})

afterAll(async () => {
  if (generatedDir !== '') {
    await rm(generatedDir, { recursive: true, force: true })
  }
})

describe('schemas/*.json stays in sync with src/shared/schemas.ts', () => {
  it.each(SCHEMA_FILES.map((file) => file.fileName))(
    '%s matches the generated file',
    async (fileName) => {
      const committed = await readFile(join(DEFAULT_OUTPUT_DIR, fileName), 'utf8')
      const generated = await readFile(join(generatedDir, fileName), 'utf8')

      expect(committed, `${fileName}: ${REGENERATE}`).toBe(generated)
    }
  )

  it('has no committed schema file that the exporter does not produce', async () => {
    const committed = (await readdir(DEFAULT_OUTPUT_DIR)).sort()
    const expected = SCHEMA_FILES.map((file) => file.fileName).sort()

    expect(committed, `schemas/: ${REGENERATE}`).toEqual(expected)
  })

  it('produces valid JSON declaring the 2020-12 dialect', async () => {
    for (const file of SCHEMA_FILES) {
      const document: unknown = JSON.parse(
        await readFile(join(generatedDir, file.fileName), 'utf8')
      )

      expect(document).toMatchObject({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: file.title,
        type: 'object',
        additionalProperties: false
      })
    }
  })
})
