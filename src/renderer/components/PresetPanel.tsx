/**
 * The preset panel (plan Task 5.4, spec section 4.4).
 *
 * List, save, apply and delete. Applying is the interesting one and is
 * deliberately two steps (plan decision Q5): the button builds the field list
 * with `previewPresetApply` and opens {@link ApplyPreviewDialog}; only the
 * confirm button runs `applyPreset` and hands the result to `adoptState`.
 * Cancelling leaves the draft byte for byte as it was, because nothing has been
 * applied yet.
 *
 * The preset's stored style image reaches `applyPreset` as the handle main sent
 * with the entry (plan decisions Q17 and Q18). The renderer cannot mint one:
 * it holds opaque handles and never a path (spec section 11, decision Q3). A
 * preset whose entry carries no handle leaves the style slot alone, and the
 * preview says so, because both go through the same options argument.
 *
 * What a preset never touches, and what this panel therefore never shows in the
 * diff: the identity reference and its note (spec section 4.4).
 */
import { useState, type ChangeEvent, type JSX } from 'react'

import type { PresetEntry, PresetInput } from '@shared/ipc-contract'
import { applyPreset, previewPresetApply, type FieldChange } from '@shared/preset-merge'
import type { BuilderState } from '@shared/schemas'

import { ipcErrorText, vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'
import { useLibraryStore } from '../store/library.ts'

import { ApplyPreviewDialog } from './ApplyPreviewDialog.tsx'

/** The dialog that is open, if any. */
type Pending =
  | { readonly kind: 'apply'; readonly entry: PresetEntry; readonly changes: FieldChange[] }
  | { readonly kind: 'delete'; readonly entry: PresetEntry }

export function PresetPanel(): JSX.Element {
  const presets = useLibraryStore((store) => store.presets)
  const listErrorCode = useLibraryStore((store) => store.listErrorCode)
  const writeErrorCode = useLibraryStore((store) => store.writeErrorCode)
  const saving = useLibraryStore((store) => store.saving)
  const savePreset = useLibraryStore((store) => store.savePreset)
  const deletePreset = useLibraryStore((store) => store.deletePreset)

  const state = useBuilderStore((store) => store.state)
  const adoptState = useBuilderStore((store) => store.adoptState)
  const flushAutosave = useBuilderStore((store) => store.flushAutosave)

  const [name, setName] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)

  function confirm(): void {
    if (pending === null) {
      return
    }

    if (pending.kind === 'delete') {
      void deletePreset(pending.entry.preset.id)
    } else {
      adoptState(
        applyPreset(state, pending.entry.preset, { styleReference: pending.entry.styleReference })
      )
      // `adoptState` starts a fresh, already-saved state, so the applied preset
      // would otherwise sit only in memory until the next keystroke.
      void flushAutosave()
    }

    setPending(null)
  }

  return (
    <div className="library">
      {listErrorCode === null ? null : (
        <p className="library__error" role="alert">
          {vi.library.listFailed} {ipcErrorText(listErrorCode)}
        </p>
      )}

      {writeErrorCode === null ? null : (
        <p className="library__error" role="alert">
          {vi.library.saveFailed} {ipcErrorText(writeErrorCode)}
        </p>
      )}

      {presets.length === 0 ? (
        <p className="library__empty">{vi.library.presetsEmpty}</p>
      ) : (
        <ul className="library__list">
          {presets.map((entry) => (
            <li className="library__row" key={entry.preset.id}>
              <span className="library__name">{entry.preset.name}</span>
              <span className="library__actions">
                <button
                  type="button"
                  onClick={(): void => {
                    setPending({
                      kind: 'apply',
                      entry,
                      changes: previewPresetApply(state, entry.preset, {
                        styleReference: entry.styleReference
                      })
                    })
                  }}
                >
                  {vi.library.applyPreset}
                </button>
                <button
                  type="button"
                  onClick={(): void => {
                    setPending({ kind: 'delete', entry })
                  }}
                >
                  {vi.library.deletePreset}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label className="field__label" htmlFor="preset-name">
          {vi.library.presetName}
        </label>
        <input
          id="preset-name"
          type="text"
          value={name}
          placeholder={vi.library.presetNamePlaceholder}
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            setName(event.target.value)
          }}
        />
      </div>

      <button
        type="button"
        disabled={saving || !canSavePreset(state, name)}
        onClick={(): void => {
          void savePreset(presetInputFromState(state, name.trim())).then((stored) => {
            if (stored) {
              setName('')
            }
          })
        }}
      >
        {vi.library.savePreset}
      </button>

      {pending === null ? null : pending.kind === 'apply' ? (
        <ApplyPreviewDialog
          title={vi.library.applyTitle}
          message={vi.library.applyMessage}
          changes={pending.changes}
          confirmLabel={vi.library.applyConfirm}
          onConfirm={confirm}
          onCancel={(): void => {
            setPending(null)
          }}
        />
      ) : (
        <ApplyPreviewDialog
          title={vi.library.deleteTitle}
          message={`${pending.entry.preset.name} — ${vi.library.deleteMessage}`}
          confirmLabel={vi.library.deleteConfirm}
          onConfirm={confirm}
          onCancel={(): void => {
            setPending(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Whether the draft can become a preset.
 *
 * A name is required by `PresetInputSchema`, and so is an aspect ratio, which a
 * half-typed draft is allowed to have left empty (plan decision Q22). Asking
 * here keeps that from becoming an `INVALID_REQUEST` the user has to decode.
 */
export function canSavePreset(state: BuilderState, name: string): boolean {
  return name.trim() !== '' && state.output.aspectRatio.trim() !== ''
}

/**
 * The current draft as a new preset (spec section 4.4).
 *
 * The style image is named by the handle in that slot, so main can copy the
 * file into `workspace/presets/<id>/` (plan decision Q4); the identity slot is
 * not offered, because a preset stores no identity reference.
 *
 * Only the four roles `applyPreset` can write a note back to are stored. Saving
 * the identity note as well would keep a value no apply would ever restore, and
 * a preset that quietly holds identity direction is exactly what spec section
 * 4.4 separates from anchors.
 *
 * `promptConventions` is left empty: there is no field for it in the builder,
 * and plan decision Q16 carries a preset's conventions into the composition
 * note, which this reads back out of `subject.notes`.
 */
export function presetInputFromState(state: BuilderState, name: string): PresetInput {
  const noteFor = (role: 'style' | 'outfit' | 'equipment' | 'extra'): string | undefined => {
    const note = state.references.find((reference) => reference.role === role)?.note?.trim()

    return note === undefined || note === '' ? undefined : note
  }

  return {
    id: null,
    name,
    styleReferenceId: state.references.find((r) => r.role === 'style')?.referenceId ?? null,
    roleNotes: definedOnly({
      style: noteFor('style'),
      outfit: noteFor('outfit'),
      equipment: noteFor('equipment'),
      extra: noteFor('extra')
    }),
    promptConventions: [],
    negativeConstraints: [...state.negativeConstraints],
    composition: definedOnly({
      pose: blankToUndefined(state.subject.pose),
      expression: blankToUndefined(state.subject.expression),
      notes: blankToUndefined(state.subject.notes)
    }),
    output: {
      aspectRatio: state.output.aspectRatio,
      background: state.output.background,
      format: state.output.format
    }
  }
}

/**
 * Drops the keys whose value is `undefined`.
 *
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and the schemas here are strict objects with optional fields, so
 * the key has to go rather than hold `undefined`.
 */
function definedOnly<T extends object>(value: T): { [K in keyof T]?: NonNullable<T[K]> } {
  const result: { [K in keyof T]?: NonNullable<T[K]> } = {}

  for (const [key, entry] of Object.entries(value) as [keyof T, T[keyof T]][]) {
    if (entry !== undefined) {
      result[key] = entry as NonNullable<T[keyof T]>
    }
  }

  return result
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()

  return trimmed === '' ? undefined : trimmed
}
