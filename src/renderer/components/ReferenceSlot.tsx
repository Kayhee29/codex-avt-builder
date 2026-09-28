/**
 * One reference slot (plan Task 5.3, spec section 4.2).
 *
 * Everything spec section 4.2 asks a slot to support: choose a file, see the
 * thumbnail, replace, remove, keep a note for that role, show the file name and
 * the source path, and warn when the file has gone.
 *
 * The slot is independent. Its actions name their own role and the store
 * rewrites nothing else, which is the guarantee spec sections 4.2 and 14.2 make
 * about replacing one slot; `tests/unit/renderer/reference-slots.test.tsx`
 * proves it by comparing the other four before and after.
 *
 * The path shown is `displayPath`, which the main process shortened for
 * display. It is never sent anywhere: the renderer holds an opaque handle and
 * only main can turn it back into a path (spec section 11, plan decision Q3).
 */
import type { ChangeEvent, JSX } from 'react'

import type { BuilderReference } from '@shared/schemas'
import type { ReferenceRole } from '@shared/reference-roles'

import { REFERENCE_ROLE_TEXT, vi } from '../i18n/vi.ts'
import { selectReference, useBuilderStore } from '../store/builder.ts'

export interface ReferenceSlotProps {
  readonly role: ReferenceRole
}

export function ReferenceSlot({ role }: ReferenceSlotProps): JSX.Element {
  const reference = useBuilderStore((store) => selectReference(store, role))
  const pickReference = useBuilderStore((store) => store.pickReference)
  const removeReference = useBuilderStore((store) => store.removeReference)
  const setReferenceNote = useBuilderStore((store) => store.setReferenceNote)

  const text = REFERENCE_ROLE_TEXT[role]
  const missing = reference?.missing === true

  return (
    <section
      className={missing ? 'slot slot--missing' : 'slot'}
      aria-label={text.name}
      data-role={role}
    >
      <header className="slot__heading">
        <h3 className="slot__name">{text.name}</h3>
        <span className="slot__role">{role}</span>
      </header>

      <p className="slot__description">{text.description}</p>

      {reference === null ? (
        <>
          <p className="slot__empty">{vi.reference.empty}</p>
          <div className="slot__actions">
            <button
              type="button"
              onClick={(): void => {
                void pickReference(role)
              }}
            >
              {vi.reference.choose}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="slot__body">
            <Thumbnail reference={reference} />
            <dl className="slot__meta">
              <dt>{vi.reference.fileName}</dt>
              <dd>{reference.originalName}</dd>
              <dt>{vi.reference.sourcePath}</dt>
              <dd>{reference.displayPath}</dd>
              <dt>{vi.reference.dimensions}</dt>
              <dd>{`${String(reference.width)} × ${String(reference.height)}`}</dd>
            </dl>
          </div>

          {missing ? <p className="slot__warning">{vi.reference.missing}</p> : null}

          <div className="slot__actions">
            <button
              type="button"
              onClick={(): void => {
                void pickReference(role)
              }}
            >
              {vi.reference.replace}
            </button>
            <button
              type="button"
              onClick={(): void => {
                removeReference(role)
              }}
            >
              {vi.reference.remove}
            </button>
          </div>

          <div className="field">
            <label className="field__label" htmlFor={`note-${role}`}>
              {vi.reference.note}
            </label>
            <textarea
              id={`note-${role}`}
              rows={2}
              value={reference.note ?? ''}
              placeholder={vi.reference.notePlaceholder}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
                setReferenceNote(role, event.target.value)
              }}
            />
          </div>
        </>
      )}
    </section>
  )
}

/**
 * The preview of spec section 4.2.
 *
 * `thumbnail` is a data URL main rendered (plan decision Q19) and is absent
 * when it could not render one, which is the normal case for a file that has
 * gone missing.
 */
function Thumbnail({ reference }: { reference: BuilderReference }): JSX.Element {
  if (reference.thumbnail === undefined) {
    return <div className="slot__thumbnail slot__thumbnail--empty">{vi.reference.noThumbnail}</div>
  }

  return <img className="slot__thumbnail" src={reference.thumbnail} alt={reference.originalName} />
}
