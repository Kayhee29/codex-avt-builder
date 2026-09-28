/**
 * The confirmation dialog (plan Task 5.4, spec section 4.4, decision Q5).
 *
 * Spec section 4.4: the UI must show which fields a preset would change before
 * it is applied to a draft that already holds data. Applying is therefore an
 * explicit two-step action — `previewPresetApply` builds the rows, this shows
 * them, and only the confirm button runs `applyPreset`.
 *
 * The same dialog carries the two other "are you sure" moments of the library
 * panels, deleting a preset and replacing the draft with one built from an
 * anchor, by leaving `changes` out and passing a message instead. A component
 * that is a list of changes plus two buttons does not need a second copy.
 *
 * It holds no state and reads no store: the panel that opened it owns both.
 */
import type { JSX } from 'react'

import type { FieldChange } from '@shared/preset-merge'

import { PRESET_FIELD_TEXT, vi } from '../i18n/vi.ts'

export interface ApplyPreviewDialogProps {
  readonly title: string
  /** One sentence above the table, or instead of it. */
  readonly message?: string
  /** The fields that would change. Absent for a plain confirmation. */
  readonly changes?: readonly FieldChange[]
  readonly confirmLabel: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function ApplyPreviewDialog({
  title,
  message,
  changes,
  confirmLabel,
  onConfirm,
  onCancel
}: ApplyPreviewDialogProps): JSX.Element {
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="dialog__panel">
        <h3 className="dialog__title">{title}</h3>

        {message === undefined ? null : <p className="dialog__message">{message}</p>}

        {changes === undefined ? null : <Changes changes={changes} />}

        <div className="dialog__actions">
          <button type="button" onClick={onCancel}>
            {vi.common.cancel}
          </button>
          <button type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The diff `previewPresetApply` produced.
 *
 * An empty list is said out loud rather than shown as an empty table: a preset
 * that changes nothing is a normal answer, and the user should be able to close
 * the dialog knowing that.
 */
function Changes({ changes }: { changes: readonly FieldChange[] }): JSX.Element {
  if (changes.length === 0) {
    return <p className="dialog__empty">{vi.library.applyEmpty}</p>
  }

  return (
    <table className="dialog__changes">
      <thead>
        <tr>
          <th scope="col">{vi.library.applyColumnField}</th>
          <th scope="col">{vi.library.applyColumnFrom}</th>
          <th scope="col">{vi.library.applyColumnTo}</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((change) => (
          <tr key={change.field}>
            <th scope="row">{PRESET_FIELD_TEXT[change.field]}</th>
            <td>{change.from ?? vi.common.emptyValue}</td>
            <td>{change.to ?? vi.common.emptyValue}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
