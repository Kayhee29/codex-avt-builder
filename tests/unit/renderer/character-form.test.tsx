// @vitest-environment jsdom
/**
 * The character direction form once its free-text boxes became dropdowns.
 *
 * Two claims carry this file. A dropdown must never be able to leave the draft
 * in a state the builder refuses to generate — which is why the only fields
 * still marked required are the two a list cannot fill in. And a value that
 * came from somewhere other than a list must survive being loaded: a draft
 * saved before the lists existed, or one typed into "Khác…", opens with the
 * text box showing rather than silently losing what the user wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

import { ASPECT_RATIO_OPTIONS, EXPRESSION_OPTIONS, POSE_OPTIONS } from '@shared/direction-options'
import type { BuilderState } from '@shared/schemas'

import {
  CharacterForm,
  CUSTOM_OPTION_VALUE
} from '../../../src/renderer/components/CharacterForm.tsx'
import {
  EXPRESSION_OPTION_TEXT,
  POSE_OPTION_TEXT,
  vi as viText
} from '../../../src/renderer/i18n/vi.ts'
import { useBuilderStore } from '../../../src/renderer/store/builder.ts'

import { installFakeBridge, makeValidState } from './harness.ts'

function subject(): BuilderState['subject'] {
  return useBuilderStore.getState().state.subject
}

function output(): BuilderState['output'] {
  return useBuilderStore.getState().state.output
}

beforeEach(() => {
  installFakeBridge()
  useBuilderStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useBuilderStore.getState().reset()
})

describe('pose and expression as dropdowns', () => {
  it('lists every predefined choice by its Vietnamese label', () => {
    render(<CharacterForm />)

    const pose = screen.getByLabelText(viText.form.pose)

    for (const option of POSE_OPTIONS) {
      expect(within(pose).getByRole('option', { name: POSE_OPTION_TEXT[option.id] })).toBeDefined()
    }

    const expression = screen.getByLabelText(viText.form.expression)

    for (const option of EXPRESSION_OPTIONS) {
      expect(
        within(expression).getByRole('option', { name: EXPRESSION_OPTION_TEXT[option.id] })
      ).toBeDefined()
    }
  })

  it('stores the English value, not the label the user read', () => {
    render(<CharacterForm />)

    const chosen = POSE_OPTIONS[2]

    fireEvent.change(screen.getByLabelText(viText.form.pose), {
      target: { value: chosen?.value }
    })

    // `prompt.md` is an English document, so what lands in the draft has to be
    // the English phrase even though the dropdown showed Vietnamese.
    expect(subject().pose).toBe(chosen?.value)
  })

  it('offers an explicit empty choice, because no pose is a real answer', () => {
    render(<CharacterForm />)

    const pose = screen.getByLabelText(viText.form.pose)

    expect(within(pose).getByRole('option', { name: viText.form.unspecified })).toBeDefined()

    fireEvent.change(pose, { target: { value: POSE_OPTIONS[0]?.value } })
    fireEvent.change(pose, { target: { value: '' } })

    expect(subject().pose ?? '').toBe('')
  })
})

describe('the Khác… escape hatch', () => {
  it('reveals a text box that writes straight into the draft', () => {
    render(<CharacterForm />)

    expect(screen.queryByLabelText(viText.form.customPose)).toBeNull()

    fireEvent.change(screen.getByLabelText(viText.form.pose), {
      target: { value: CUSTOM_OPTION_VALUE }
    })

    const box = screen.getByLabelText(viText.form.customPose)

    fireEvent.change(box, { target: { value: 'ngồi xổm trên nóc tủ' } })

    expect(subject().pose).toBe('ngồi xổm trên nóc tủ')
  })

  it('opens already showing a value no list contains', () => {
    useBuilderStore.setState({
      state: makeValidState({
        subject: {
          name: 'A',
          description: 'B',
          pose: 'ngồi xổm trên nóc tủ',
          expression: EXPRESSION_OPTIONS[0]?.value
        }
      })
    })

    render(<CharacterForm />)

    // The select falls back to Khác… and the box keeps the text, so loading an
    // older draft cannot quietly drop direction the user wrote by hand.
    expect(screen.getByLabelText<HTMLSelectElement>(viText.form.pose).value).toBe(
      CUSTOM_OPTION_VALUE
    )
    expect(screen.getByLabelText<HTMLInputElement>(viText.form.customPose).value).toBe(
      'ngồi xổm trên nóc tủ'
    )

    // A value that *is* on a list gets no text box.
    expect(screen.queryByLabelText(viText.form.customExpression)).toBeNull()
  })
})

describe('the output settings', () => {
  it('cannot be set to anything the schema rejects', () => {
    render(<CharacterForm />)

    const ratio = screen.getByLabelText<HTMLSelectElement>(viText.form.aspectRatio)
    const count = screen.getByLabelText<HTMLSelectElement>(viText.form.count)

    // Both are closed lists with a valid default, which is what removes them
    // from the set of fields that can block Generate.
    expect(ratio.value).not.toBe('')
    expect(within(ratio).queryByRole('option', { name: viText.form.unspecified })).toBeNull()
    expect(Number.parseInt(count.value, 10)).toBeGreaterThan(0)

    fireEvent.change(ratio, { target: { value: ASPECT_RATIO_OPTIONS.at(-1)?.value } })

    expect(output().aspectRatio).toBe(ASPECT_RATIO_OPTIONS.at(-1)?.value)
  })

  it('lets the background go back to unspecified', () => {
    render(<CharacterForm />)

    const background = screen.getByLabelText(viText.form.background)

    fireEvent.change(background, { target: { value: 'solid white' } })
    expect(output().background).toBe('solid white')

    fireEvent.change(background, { target: { value: '' } })
    expect(output().background).toBe('')
  })
})

describe('the fields Generate needs', () => {
  it('marks the name and the description required, and nothing else', () => {
    render(<CharacterForm />)

    for (const label of [viText.form.name, viText.form.description]) {
      expect(screen.getByLabelText(label).getAttribute('aria-required')).toBe('true')
    }

    for (const label of [
      viText.form.pose,
      viText.form.expression,
      viText.form.notes,
      viText.form.aspectRatio,
      viText.form.background,
      viText.form.count
    ]) {
      expect(screen.getByLabelText(label).getAttribute('aria-required')).not.toBe('true')
    }
  })

  it('says nothing on a form nobody has touched', () => {
    render(<CharacterForm />)

    expect(screen.getByLabelText(viText.form.name).getAttribute('aria-invalid')).not.toBe('true')
  })

  it('flags an empty required field once the draft holds anything at all', () => {
    render(<CharacterForm />)

    fireEvent.change(screen.getByLabelText(viText.form.description), {
      target: { value: 'Nam, ngoài 50 tuổi' }
    })

    // The description is filled and the name is not, so the name is a real gap
    // rather than a form that has simply not been started.
    expect(screen.getByLabelText(viText.form.name).getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText(viText.form.description).getAttribute('aria-invalid')).not.toBe(
      'true'
    )
  })
})
