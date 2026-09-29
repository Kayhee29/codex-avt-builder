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
 *
 * Pose, expression, aspect ratio, background, count and format are dropdowns
 * over `src/shared/direction-options.ts`. Two consequences worth knowing:
 *
 * - A closed list with a valid default cannot hold a value the schema rejects,
 *   so aspect ratio and count stopped being able to block Generate. The only
 *   fields that still can are the name and the description, and those are the
 *   ones marked required here.
 * - Pose and expression keep an escape hatch, because they become prose in
 *   `prompt.md` and no list covers what a character needs. A value that is not
 *   on a list — typed into "Khác…", or saved by a build before the lists
 *   existed — opens with the text box showing and the value intact.
 */
import { useState, type ChangeEvent, type JSX, type ReactNode } from 'react'

import {
  ASPECT_RATIO_OPTIONS,
  BACKGROUND_OPTIONS,
  COUNT_OPTIONS,
  EXPRESSION_OPTIONS,
  POSE_OPTIONS,
  type DirectionOption
} from '@shared/direction-options'
import { ImageFormatSchema, type ImageFormat } from '@shared/schemas'

import {
  ASPECT_RATIO_OPTION_TEXT,
  BACKGROUND_OPTION_TEXT,
  EXPRESSION_OPTION_TEXT,
  IMAGE_FORMAT_TEXT,
  POSE_OPTION_TEXT,
  vi
} from '../i18n/vi.ts'
import { selectHasContent, useBuilderStore } from '../store/builder.ts'

/**
 * What the "Khác…" entry carries as its `value`.
 *
 * A `NUL` prefix, so it can never collide with something a user chose or typed:
 * every real value is a printable phrase, and the empty choice is `''`.
 */
export const CUSTOM_OPTION_VALUE = '\u0000custom'

interface Choice {
  readonly value: string
  readonly label: string
}

/** Built once: the lists are constant and rebuilding them would only churn. */
function toChoices(
  options: readonly DirectionOption[],
  labels: Readonly<Record<string, string>>
): Choice[] {
  return options.map((option) => ({ value: option.value, label: labels[option.id] ?? option.id }))
}

const POSE_CHOICES = toChoices(POSE_OPTIONS, POSE_OPTION_TEXT)
const EXPRESSION_CHOICES = toChoices(EXPRESSION_OPTIONS, EXPRESSION_OPTION_TEXT)
const ASPECT_RATIO_CHOICES = toChoices(ASPECT_RATIO_OPTIONS, ASPECT_RATIO_OPTION_TEXT)
const BACKGROUND_CHOICES = toChoices(BACKGROUND_OPTIONS, BACKGROUND_OPTION_TEXT)

export function CharacterForm(): JSX.Element {
  const subject = useBuilderStore((store) => store.state.subject)
  const output = useBuilderStore((store) => store.state.output)
  const negativeConstraintsText = useBuilderStore((store) => store.negativeConstraintsText)
  const setSubjectField = useBuilderStore((store) => store.setSubjectField)
  const setOutput = useBuilderStore((store) => store.setOutput)
  const setNegativeConstraintsText = useBuilderStore((store) => store.setNegativeConstraintsText)
  // A boolean, so subscribing to it is safe. An empty required field on an
  // untouched form is not a mistake yet; on a draft that already holds
  // something, it is the thing standing between the user and Generate.
  const started = useBuilderStore(selectHasContent)

  return (
    <form className="form" onSubmit={(event): void => event.preventDefault()}>
      <fieldset className="form__group">
        <legend className="form__legend">{vi.form.legendSubject}</legend>

        <Field id="subject-name" label={vi.form.name} required>
          <input
            id="subject-name"
            type="text"
            value={subject.name}
            placeholder={vi.form.namePlaceholder}
            aria-required="true"
            aria-invalid={started && subject.name.trim() === '' ? 'true' : undefined}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              setSubjectField('name', event.target.value)
            }}
          />
        </Field>

        <Field id="subject-description" label={vi.form.description} required>
          <textarea
            id="subject-description"
            rows={3}
            value={subject.description}
            placeholder={vi.form.descriptionPlaceholder}
            aria-required="true"
            aria-invalid={started && subject.description.trim() === '' ? 'true' : undefined}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
              setSubjectField('description', event.target.value)
            }}
          />
        </Field>

        <ChoiceField
          id="subject-pose"
          label={vi.form.pose}
          choices={POSE_CHOICES}
          value={subject.pose ?? ''}
          allowEmpty
          customLabel={vi.form.customPose}
          onChange={(value): void => {
            setSubjectField('pose', value)
          }}
        />

        <ChoiceField
          id="subject-expression"
          label={vi.form.expression}
          choices={EXPRESSION_CHOICES}
          value={subject.expression ?? ''}
          allowEmpty
          customLabel={vi.form.customExpression}
          onChange={(value): void => {
            setSubjectField('expression', value)
          }}
        />

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
          {/* No empty entry: `aspectRatio` is `min(1)`, so an empty one would
              make the draft invalid — which is exactly what a closed list is
              here to prevent. */}
          <ChoiceField
            id="output-aspect-ratio"
            label={vi.form.aspectRatio}
            choices={ASPECT_RATIO_CHOICES}
            value={output.aspectRatio}
            onChange={(value): void => {
              setOutput('aspectRatio', value)
            }}
          />

          <Field id="output-count" label={vi.form.count}>
            <select
              id="output-count"
              value={String(output.count)}
              onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
                setOutput('count', Number.parseInt(event.target.value, 10))
              }}
            >
              {COUNT_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Empty is a real answer here: the prompt says so in as many words
            when the background is blank, and it is the default. */}
        <ChoiceField
          id="output-background"
          label={vi.form.background}
          choices={BACKGROUND_CHOICES}
          value={output.background}
          allowEmpty
          onChange={(value): void => {
            setOutput('background', value)
          }}
        />

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

/**
 * A dropdown over a predefined list, with an optional way out of it.
 *
 * `customLabel` is what turns the escape hatch on. Without it the list is
 * closed and the field can only ever hold one of its values.
 */
function ChoiceField({
  id,
  label,
  choices,
  value,
  allowEmpty = false,
  customLabel,
  onChange
}: {
  id: string
  label: string
  choices: readonly Choice[]
  value: string
  allowEmpty?: boolean
  customLabel?: string
  onChange: (value: string) => void
}): JSX.Element {
  // Only needed for the moment between picking "Khác…" and typing anything:
  // until then the stored value is still empty, which on its own looks like the
  // empty choice rather than a custom one.
  const [customChosen, setCustomChosen] = useState(false)

  const custom = customLabel !== undefined
  const offList = value !== '' && !choices.some((choice) => choice.value === value)
  const showCustom = custom && (offList || customChosen)

  return (
    <Field id={id} label={label}>
      <select
        id={id}
        value={showCustom ? CUSTOM_OPTION_VALUE : value}
        onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
          const next = event.target.value

          if (next === CUSTOM_OPTION_VALUE) {
            // The current value stays put, so converting a chosen option into a
            // custom one leaves something to edit instead of an empty box.
            setCustomChosen(true)

            return
          }

          setCustomChosen(false)
          onChange(next)
        }}
      >
        {allowEmpty ? <option value="">{vi.form.unspecified}</option> : null}

        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}

        {custom ? <option value={CUSTOM_OPTION_VALUE}>{vi.form.custom}</option> : null}
      </select>

      {showCustom && customLabel !== undefined ? (
        <>
          <label className="field__label" htmlFor={`${id}-custom`}>
            {customLabel}
          </label>
          <input
            id={`${id}-custom`}
            type="text"
            value={value}
            onChange={(event: ChangeEvent<HTMLInputElement>): void => {
              onChange(event.target.value)
            }}
          />
        </>
      ) : null}
    </Field>
  )
}

function Field({
  id,
  label,
  hint,
  required = false,
  children
}: {
  id: string
  label: string
  hint?: string
  required?: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <div className="field">
      {/* The badge is a sibling of the label, not inside it: the accessible
          name of the control stays the field's name, and `aria-required` on the
          control is what actually says it is required. */}
      <span className="field__head">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {required ? <span className="field__required">{vi.form.required}</span> : null}
      </span>
      {children}
      {hint === undefined ? null : <span className="field__hint">{hint}</span>}
    </div>
  )
}
