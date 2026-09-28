/**
 * The mapping table shown beside the prompt (plan Task 5.2, spec section 4.3):
 *
 * ```text
 * Image A → style     → master-style.png
 * Image B → identity  → nixon-front.jpg
 * ```
 *
 * The rows come from `buildPrompt`, so the labels here are the same ones the
 * prompt uses and the same ones the main process writes into `job.json` and
 * hands to `codex exec` as `-i` arguments (spec section 5.3). Labels are never
 * derived a second time in the UI.
 */
import type { JSX } from 'react'

import type { MappingRow } from '@shared/prompt-builder'

import { referenceRoleName, vi } from '../i18n/vi.ts'

export interface ReferenceMappingProps {
  readonly rows: readonly MappingRow[]
}

export function ReferenceMapping({ rows }: ReferenceMappingProps): JSX.Element {
  if (rows.length === 0) {
    return <p className="mapping__empty">{vi.preview.mappingEmpty}</p>
  }

  return (
    <table className="mapping" aria-label={vi.preview.mapping}>
      <thead>
        <tr>
          <th scope="col">{vi.preview.columnLabel}</th>
          <th scope="col">{vi.preview.columnRole}</th>
          <th scope="col">{vi.preview.columnFile}</th>
          <th scope="col">{vi.preview.columnNote}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.role}>
            <td>{row.label}</td>
            <td>{referenceRoleName(row.role)}</td>
            <td>{row.originalName}</td>
            <td>{row.note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
