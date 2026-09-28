/**
 * Character direction (plan Task 5.2, spec section 4.1).
 *
 * Every field spec section 4.1 lists, plus `count` from `OutputRequestSchema`.
 * Each control is bound straight to the builder store, and nothing in this file
 * talks to the bridge: typing changes state, the preview rebuilds from that
 * state, and the only command that ever follows is the debounced draft
 * autosave. Spec section 5.1 makes that the rule — no builder action runs
 * Codex — and `tests/unit/renderer/prompt-preview.test.tsx` asserts it over the
 * whole IPC contract rather than over a list of channels written by hand.
 */
import type { ChangeEvent, JSX, ReactNode } from 'react'

import { ImageFormatSchema, type ImageFormat } from '@shared/schemas'

import { IMAGE_FORMAT_TEXT, vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'

export function CharacterForm(): JSX.Element {
  const subject = useBuilderStore((store) => store.state.subject)
  const output = useBuilderStore((store) => store.state.output)
  const negativeConstraintsText = useBuilderStore((store) => store.negativeConstraintsText)
  const setSubjectField = useBuilderStore((store) => store.setSubjectField)
  const setOutput = useBuilderStore((store) => store.setOutput)
  const setNegativeConstraintsText = useBuilderStore((store) => store.setNegativeConstraintsText)

  return (
    <form className="form" onSubmit={(event): void => event.preventDefault()}>
      <fieldset className="form__group">
        <legend className="form__legend">{vi.form.legendSubject}</legend>

        <Field id="subject-name" label={vi.form.name}>
          <input
            id="subject-name"
            type="text"
            value={subject.name}
            placeholder={vi.form.namePlaceholder}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setSubjectField('name', event.target.value)
            }}
          />
        </Field>

        <Field id="subject-description" label={vi.form.description}>
          <textarea
            id="subject-description"
            rows={3}
            value={subject.description}
            placeholder={vi.form.descriptionPlaceholder}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
              setSubjectField('description', event.target.value)
            }}
          />
        </Field>

        <Field id="subject-pose" label={vi.form.pose}>
          <input
            id="subject-pose"
            type="text"
            value={subject.pose ?? ''}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setSubjectField('pose', event.target.value)
            }}
          />
        </Field>

        <Field id="subject-expression" label={vi.form.expression}>
          <input
            id="subject-expression"
            type="text"
            value={subject.expression ?? ''}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setSubjectField('expression', event.target.value)
            }}
          />
        </Field>

        <Field id="subject-notes" label={vi.form.notes}>
          <textarea
            id="subject-notes"
            rows={2}
            value={subject.notes ?? ''}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
              setSubjectField('notes', event.target.value)
            }}
          />
        </Field>

        <Field
          id="negative-constraints"
          label={vi.form.negativeConstraints}
          hint={vi.form.negativeConstraintsHint}
        >
          <textarea
            id="negative-constraints"
            rows={3}
            value={negativeConstraintsText}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
              setNegativeConstraintsText(event.target.value)
            }}
          />
        </Field>
      </fieldset>

      <fieldset className="form__group">
        <legend className="form__legend">{vi.form.legendOutput}</legend>

        <div className="field__row">
          <Field id="output-aspect-ratio" label={vi.form.aspectRatio}>
            <input
              id="output-aspect-ratio"
              type="text"
              value={output.aspectRatio}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                setOutput('aspectRatio', event.target.value)
              }}
            />
          </Field>

          <Field id="output-count" label={vi.form.count}>
            <input
              id="output-count"
              type="number"
              min={1}
              value={output.count}
              onChange={(event: ChangeEvent<HTMLInputElement>): void => {
                // An empty or unparseable box becomes 0, which
                // `OutputRequestSchema` rejects, so the builder simply reads
                // `invalid` until the user types a real number.
                const parsed = Number.parseInt(event.target.value, 10)

                setOutput('count', Number.isNaN(parsed) ? 0 : parsed)
              }}
            />
          </Field>
        </div>

        <Field id="output-background" label={vi.form.background}>
          <input
            id="output-background"
            type="text"
            value={output.background}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setOutput('background', event.target.value)
            }}
          />
        </Field>

        <Field id="output-format" label={vi.form.format}>
          <select
            id="output-format"
            value={output.format}
            onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
              setOutput('format', event.target.value as ImageFormat)
            }}
          >
            {ImageFormatSchema.options.map((format) => (
              <option key={format} value={format}>
                {IMAGE_FORMAT_TEXT[format]}
              </option>
            ))}
          </select>
        </Field>
      </fieldset>
    </form>
  )
}

function Field({
  id,
  label,
  hint,
  children
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </div>
  )
}
