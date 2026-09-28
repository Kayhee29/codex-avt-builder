// @vitest-environment jsdom
/**
 * Character direction and the live prompt preview (plan Task 5.2, spec
 * sections 4.1, 4.3 and 5.1).
 *
 * Two claims matter here. The preview follows the form immediately, because
 * `buildPrompt` is a pure function the renderer calls itself. And editing the
 * form reaches the main process for exactly one reason, the debounced draft
 * autosave: spec section 5.1 says no builder action starts Codex, and the
 * strongest way to show that is to assert over every channel in the contract
 * rather than over a list of channels written out by hand.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { IPC_CHANNEL_NAMES } from '@shared/ipc-contract'
import { sha256Hex } from '@shared/prompt-builder'

import { CharacterForm } from '../../../src/renderer/components/CharacterForm.tsx'
import { PromptPreview } from '../../../src/renderer/components/PromptPreview.tsx'
import { AUTOSAVE_DEBOUNCE_MS, useBuilderStore } from '../../../src/renderer/store/builder.ts'

import {
  channelsOtherThan,
  installFakeBridge,
  makeReference,
  makeValidState,
  type FakeBridge
} from './harness.ts'

let fake: FakeBridge

function renderBuilder(): void {
  render(
    <>
      <CharacterForm />
      <PromptPreview />
    </>
  )
}

function promptText(): string {
  return screen.getByLabelText('Prompt').textContent ?? ''
}

beforeEach(() => {
  fake = installFakeBridge()
  useBuilderStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useBuilderStore.getState().reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the preview follows the form', () => {
  it('rebuilds the prompt as the pose is typed', () => {
    renderBuilder()

    expect(promptText()).not.toContain('đứng thẳng, tay chắp sau lưng')

    fireEvent.change(screen.getByLabelText('Pose'), {
      target: { value: 'đứng thẳng, tay chắp sau lưng' }
    })

    expect(promptText()).toContain('- Pose: đứng thẳng, tay chắp sau lưng')
  })

  it('carries the name, the description and the composition note', () => {
    renderBuilder()

    fireEvent.change(screen.getByLabelText('Tên nhân vật'), { target: { value: 'Trần Văn B' } })
    fireEvent.change(screen.getByLabelText('Mô tả nhân vật'), {
      target: { value: 'Nam, tóc ngắn' }
    })
    fireEvent.change(screen.getByLabelText('Ghi chú bố cục'), {
      target: { value: 'khung ngang, chủ thể lệch trái' }
    })

    expect(promptText()).toContain('- Name: Trần Văn B')
    expect(promptText()).toContain('- Description: Nam, tóc ngắn')
    expect(promptText()).toContain('- Composition note: khung ngang, chủ thể lệch trái')
  })

  it('carries the output request, including count and format', () => {
    renderBuilder()

    fireEvent.change(screen.getByLabelText('Số lượng ảnh'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Định dạng file'), { target: { value: 'webp' } })
    fireEvent.change(screen.getByLabelText('Tỉ lệ khung hình'), { target: { value: '3:2' } })
    fireEvent.change(screen.getByLabelText('Nền'), { target: { value: 'xám trơn' } })

    expect(promptText()).toContain('Generate 3 images')
    expect(promptText()).toContain('- File format: webp')
    expect(promptText()).toContain('- Aspect ratio: 3:2')
    expect(promptText()).toContain('- Background: xám trơn')
  })

  it('splits the negative constraints textarea one per line and drops blanks', () => {
    renderBuilder()

    fireEvent.change(screen.getByLabelText('Ràng buộc loại trừ'), {
      target: { value: 'không đeo kính\n\nkhông cười\n' }
    })

    expect(useBuilderStore.getState().state.negativeConstraints).toEqual([
      'không đeo kính',
      'không cười'
    ])
    expect(promptText()).toContain('- không đeo kính')
    expect(promptText()).toContain('- không cười')
  })

  it('keeps the checksum jobs.generate will send in step with the prompt', async () => {
    renderBuilder()

    fireEvent.change(screen.getByLabelText('Pose'), { target: { value: 'ngồi' } })

    const expected = await sha256Hex(promptText())

    await waitFor(() => {
      expect(useBuilderStore.getState().promptSha256).toBe(expected)
    })
    expect(screen.getByText(`Checksum prompt: ${expected}`)).toBeDefined()
  })
})

describe('the mapping table (spec section 4.3, plan decision Q14)', () => {
  it('labels the references that are present, in role order', () => {
    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().putReference(makeReference('outfit'))
    useBuilderStore.getState().putReference(makeReference('identity', { note: 'giữ nếp nhăn' }))

    renderBuilder()

    const rows = within(screen.getByRole('table', { name: 'Bảng ánh xạ reference' }))
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent)
      )

    // No style reference, so identity is Image A rather than Image B.
    expect(rows).toEqual([
      ['Image A', 'Nhận diện', 'identity.png', 'giữ nếp nhăn'],
      ['Image B', 'Trang phục', 'outfit.png', '']
    ])
    expect(promptText()).toContain('- Image A → identity → identity.png')
  })

  it('says so when nothing is attached', () => {
    renderBuilder()

    expect(screen.getByText('Chưa có ảnh tham chiếu nào được đính kèm.')).toBeDefined()
  })
})

describe('what editing the form sends (spec section 5.1)', () => {
  it('calls no bridge command at all, and then only the debounced autosave', async () => {
    vi.useFakeTimers()
    renderBuilder()

    fireEvent.change(screen.getByLabelText('Tên nhân vật'), { target: { value: 'Trần Văn B' } })
    fireEvent.change(screen.getByLabelText('Mô tả nhân vật'), {
      target: { value: 'Nam, tóc ngắn' }
    })
    fireEvent.change(screen.getByLabelText('Pose'), { target: { value: 'đứng' } })
    fireEvent.change(screen.getByLabelText('Biểu cảm'), { target: { value: 'nghiêm' } })
    fireEvent.change(screen.getByLabelText('Số lượng ảnh'), { target: { value: '2' } })

    // The preview is already up to date, and nothing has been sent anywhere.
    expect(promptText()).toContain('Generate 2 images of Trần Văn B.')

    // The loops below are only worth anything if they walk the real contract.
    expect(channelsOtherThan()).toHaveLength(IPC_CHANNEL_NAMES.length)
    expect(channelsOtherThan('draft.save')).toHaveLength(IPC_CHANNEL_NAMES.length - 1)

    for (const channel of channelsOtherThan()) {
      expect(fake.channels[channel], channel).not.toHaveBeenCalled()
    }

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)

    expect(fake.channels['draft.save']).toHaveBeenCalledTimes(1)

    for (const channel of channelsOtherThan('draft.save')) {
      expect(fake.channels[channel], channel).not.toHaveBeenCalled()
    }
  })
})
