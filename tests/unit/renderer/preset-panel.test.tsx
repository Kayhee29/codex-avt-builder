// @vitest-environment jsdom
/**
 * The preset and anchor panels (plan Task 5.4, spec sections 4.4 and 4.5).
 *
 * The three claims the plan makes about applying a preset are the first three
 * cases: the dialog lists exactly the fields that would change, cancelling
 * changes nothing at all, and applying never touches the identity reference.
 * The last one is checked by object identity as well as by value, because a
 * merge that rebuilt the identity slot with the same contents would still be
 * the bug spec section 4.4 forbids.
 *
 * The anchor cases cover the other half of the task: a new draft built from an
 * anchor, the warning before the current draft is replaced, and spec sections
 * 4.5 and 14.5 — outfit, equipment, pose and expression stay free.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { BuilderReference } from '@shared/schemas'

import { AnchorPanel } from '../../../src/renderer/components/AnchorPanel.tsx'
import { PresetPanel } from '../../../src/renderer/components/PresetPanel.tsx'
import { selectReference, useBuilderStore } from '../../../src/renderer/store/builder.ts'
import { useJobsStore } from '../../../src/renderer/store/jobs.ts'
import { useLibraryStore } from '../../../src/renderer/store/library.ts'

import {
  installFakeBridge,
  makeAnchorEntry,
  makeJobSummary,
  makePresetEntry,
  makeReference,
  makeValidState,
  type FakeBridge
} from './harness.ts'

let fake: FakeBridge

function builder(): ReturnType<typeof useBuilderStore.getState> {
  return useBuilderStore.getState()
}

function referenceIn(role: BuilderReference['role']): BuilderReference | null {
  return selectReference(builder(), role)
}

function dialog(): ReturnType<typeof within> {
  return within(screen.getByRole('dialog'))
}

beforeEach(() => {
  fake = installFakeBridge()
  builder().reset()
  useJobsStore.getState().reset()
  useLibraryStore.getState().reset()
})

afterEach(() => {
  cleanup()
  builder().reset()
  useJobsStore.getState().reset()
  useLibraryStore.getState().reset()
  vi.unstubAllGlobals()
})

async function listPresets(...entries: ReturnType<typeof makePresetEntry>[]): Promise<void> {
  fake.answer('library.listPresets', { ok: true, data: { presets: entries } })
  await useLibraryStore.getState().refresh()
}

async function listAnchors(...entries: ReturnType<typeof makeAnchorEntry>[]): Promise<void> {
  fake.answer('library.listAnchors', { ok: true, data: { anchors: entries } })
  await useLibraryStore.getState().refresh()
}

describe('applying a preset (spec section 4.4, plan decision Q5)', () => {
  const PRESET = makePresetEntry({
    negativeConstraints: ['không chữ'],
    composition: { pose: 'Toàn thân, đứng thẳng' },
    output: { aspectRatio: '3:4', background: 'giấy ấm', format: 'webp' }
  })

  beforeEach(() => {
    builder().adoptState(makeValidState({ output: { ...makeValidState().output, count: 2 } }))
  })

  it('lists exactly the fields the apply would change, and no others', async () => {
    await listPresets(PRESET)
    render(<PresetPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))

    // Exactly the fields this preset changes, in the order of `PRESET_FIELDS`.
    // Expression and the composition note are absent because the preset sets
    // neither, which is the "skips fields that already match" half of Q5.
    expect(
      dialog()
        .getAllByRole('rowheader')
        .map((cell: HTMLElement) => cell.textContent)
    ).toEqual([
      'Tỉ lệ khung hình',
      'Nền',
      'Định dạng file',
      'Pose',
      'Ràng buộc loại trừ',
      'Preset đang dùng'
    ])
  })

  it('shows the empty marker for a field the draft has not filled in', async () => {
    await listPresets(PRESET)
    render(<PresetPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))

    // `subject.pose` is empty in the draft, so the "from" cell has no value.
    expect(dialog().getAllByText('(trống)').length).toBeGreaterThan(0)
  })

  it('changes nothing when the dialog is cancelled', async () => {
    await listPresets(PRESET)

    const before = builder().state

    render(<PresetPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Hủy' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(builder().state).toBe(before)
    expect(fake.channels['draft.save']).not.toHaveBeenCalled()
  })

  it('applies only on confirm, and saves the result straight away', async () => {
    await listPresets(PRESET)
    render(<PresetPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Áp preset' }))

    expect(builder().state.output.format).toBe('webp')
    expect(builder().state.subject.pose).toBe('Toàn thân, đứng thẳng')
    expect(builder().state.source.preset).toBe('chibi-master-v1')
    // `count` is not a preset field, so the draft keeps its own value.
    expect(builder().state.output.count).toBe(2)

    await waitFor(() => {
      expect(fake.channels['draft.save']).toHaveBeenCalledTimes(1)
    })
  })

  it('never touches the identity reference or its note (spec section 4.4)', async () => {
    builder().putReference(makeReference('identity', { note: 'giữ nguyên nếp nhăn' }))

    const identityBefore = referenceIn('identity')

    await listPresets(
      makePresetEntry({ roleNotes: { identity: 'ghi đè nhận diện', outfit: 'ghi chú trang phục' } })
    )
    render(<PresetPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Áp preset' }))

    expect(referenceIn('identity')).toBe(identityBefore)
    expect(referenceIn('identity')?.note).toBe('giữ nguyên nếp nhăn')
  })

  it('puts the preset style image into the style slot through its handle', async () => {
    const styleHandle = makeReference('style', { originalName: 'master-style.png' })

    await listPresets(
      makePresetEntry(
        {
          styleReference: {
            path: 'style.png',
            originalName: 'master-style.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
            sha256: 'a'.repeat(64)
          }
        },
        styleHandle
      )
    )
    render(<PresetPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Áp dụng' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Áp preset' }))

    expect(referenceIn('style')?.referenceId).toBe(styleHandle.referenceId)
  })
})

describe('saving and deleting a preset', () => {
  it('sends the draft as a preset, without the identity note', async () => {
    builder().adoptState(makeValidState({ negativeConstraints: ['không chữ'] }))
    builder().putReference(makeReference('style', { note: 'nét thô' }))
    builder().putReference(makeReference('identity', { note: 'giữ nếp nhăn' }))
    builder().setSubjectField('pose', 'Toàn thân')

    fake.answer('library.savePreset', {
      ok: true,
      data: { preset: makePresetEntry() }
    })

    render(<PresetPanel />)
    fireEvent.change(screen.getByLabelText('Tên preset'), { target: { value: 'Chibi master' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu preset từ draft' }))

    await waitFor(() => {
      expect(fake.channels['library.savePreset']).toHaveBeenCalledTimes(1)
    })

    const request = fake.channels['library.savePreset'].mock.calls[0]?.[0] as {
      preset: { roleNotes: Record<string, string>; styleReferenceId: string | null; name: string }
    }

    expect(request.preset.name).toBe('Chibi master')
    expect(request.preset.styleReferenceId).toBe(makeReference('style').referenceId)
    expect(request.preset.roleNotes).toEqual({ style: 'nét thô' })
  })

  it('asks before it deletes, and deletes only on confirm', async () => {
    await listPresets(makePresetEntry())
    fake.answer('library.deletePreset', { ok: true, data: { id: 'chibi-master-v1' } })

    render(<PresetPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Xóa' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Hủy' }))

    expect(fake.channels['library.deletePreset']).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Xóa' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Xóa preset' }))

    await waitFor(() => {
      expect(fake.channels['library.deletePreset']).toHaveBeenCalledWith({ id: 'chibi-master-v1' })
    })
  })
})

describe('anchors (spec section 4.5)', () => {
  it('builds a new draft from the anchor and leaves the mutable fields free', async () => {
    await listAnchors(
      makeAnchorEntry({ immutableTraits: ['tóc bạc hai bên'], mutableTraits: ['trang phục'] })
    )
    render(<AnchorPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Tạo draft mới' }))

    const state = builder().state

    expect(state.subject.name).toBe('Nguyễn Văn A')
    expect(state.subject.description).toBe('Nam, ngoài 50 tuổi, tóc bạc hai bên')
    expect(state.source.anchor).toBe('nguyen-van-a')
    expect(referenceIn('identity')?.note).toBe('tóc bạc hai bên')

    // Spec sections 4.5 and 14.5: none of these four is pinned by an anchor.
    expect(state.subject.pose).toBeUndefined()
    expect(state.subject.expression).toBeUndefined()
    expect(referenceIn('outfit')).toBeNull()
    expect(referenceIn('equipment')).toBeNull()
  })

  it('warns before it replaces a draft that holds something', async () => {
    builder().adoptState(makeValidState())
    await listAnchors(makeAnchorEntry())
    render(<AnchorPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Tạo draft mới' }))

    expect(dialog().getByText(/Nội dung đang nhập sẽ mất/)).toBeDefined()
    expect(builder().state.source.anchor).toBeNull()

    fireEvent.click(dialog().getByRole('button', { name: 'Hủy' }))

    expect(builder().state.subject.name).toBe('Nguyễn Văn A')
    expect(builder().state.source.anchor).toBeNull()
  })

  it('replaces the draft once the warning is confirmed', async () => {
    builder().adoptState(makeValidState({ subject: { name: 'Ai đó', description: 'mô tả' } }))
    await listAnchors(makeAnchorEntry())
    render(<AnchorPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Tạo draft mới' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Tạo draft mới' }))

    expect(builder().state.source.anchor).toBe('nguyen-van-a')
    await waitFor(() => {
      expect(fake.channels['draft.save']).toHaveBeenCalled()
    })
  })

  it('merges the preset the draft names underneath the anchor', async () => {
    fake.answer('library.listPresets', {
      ok: true,
      data: {
        presets: [
          makePresetEntry({
            output: { aspectRatio: '9:16', background: 'nền tối', format: 'webp' }
          })
        ]
      }
    })
    fake.answer('library.listAnchors', { ok: true, data: { anchors: [makeAnchorEntry()] } })
    await useLibraryStore.getState().refresh()

    builder().adoptState(
      makeValidState({
        subject: { name: 'Ai đó', description: 'mô tả' },
        source: { preset: 'chibi-master-v1', anchor: null }
      })
    )
    render(<AnchorPanel />)

    fireEvent.click(screen.getByRole('button', { name: 'Tạo draft mới' }))
    fireEvent.click(dialog().getByRole('button', { name: 'Tạo draft mới' }))

    // Preset defaults first, anchor defaults over them (spec section 4.4).
    expect(builder().state.output.format).toBe('webp')
    expect(builder().state.subject.name).toBe('Nguyễn Văn A')
  })

  it('needs an identity reference before it will save an anchor', async () => {
    builder().adoptState(makeValidState())
    render(<AnchorPanel />)

    expect(screen.getByRole('button', { name: 'Lưu anchor từ draft' })).toHaveProperty(
      'disabled',
      true
    )
    expect(screen.getByText(/Cần có ảnh nhận diện/)).toBeDefined()
  })

  it('saves a new anchor with the traits typed into the panel', async () => {
    builder().adoptState(makeValidState())
    builder().putReference(makeReference('identity'))
    fake.answer('library.saveAnchor', { ok: true, data: { anchor: makeAnchorEntry() } })

    render(<AnchorPanel />)
    fireEvent.change(screen.getByLabelText('Đặc điểm cố định'), {
      target: { value: 'tóc bạc hai bên\nsẹo trán' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu anchor từ draft' }))

    await waitFor(() => {
      expect(fake.channels['library.saveAnchor']).toHaveBeenCalledTimes(1)
    })
    expect(fake.channels['library.saveAnchor'].mock.calls[0]?.[0]).toEqual({
      anchor: {
        id: null,
        name: 'Nguyễn Văn A',
        identityReferenceId: makeReference('identity').referenceId,
        approvedOutput: null,
        identityDescription: 'Nam, ngoài 50 tuổi, tóc bạc hai bên',
        immutableTraits: ['tóc bạc hai bên', 'sẹo trán'],
        mutableTraits: [],
        sourceJobId: null
      }
    })
  })

  it('names an approved output by job and index, never by file name', async () => {
    builder().adoptState(makeValidState())
    builder().putReference(makeReference('identity'))
    useJobsStore.setState({ jobs: [makeJobSummary({ outputCount: 2 })] })
    fake.answer('library.saveAnchor', { ok: true, data: { anchor: makeAnchorEntry() } })

    render(<AnchorPanel />)
    fireEvent.change(screen.getByLabelText('Ảnh đã duyệt'), {
      target: { value: '2026-09-28-nguyen-van-a-001#1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu anchor từ draft' }))

    await waitFor(() => {
      expect(fake.channels['library.saveAnchor']).toHaveBeenCalledTimes(1)
    })

    const request = fake.channels['library.saveAnchor'].mock.calls[0]?.[0] as {
      anchor: { approvedOutput: unknown; sourceJobId: string | null }
    }

    expect(request.anchor.approvedOutput).toEqual({
      jobId: '2026-09-28-nguyen-van-a-001',
      outputIndex: 1
    })
    expect(request.anchor.sourceJobId).toBe('2026-09-28-nguyen-van-a-001')
  })

  it('offers the next version number of an anchor that already exists', async () => {
    await listAnchors(makeAnchorEntry({ version: 1 }), makeAnchorEntry({ version: 2 }))
    builder().adoptState(makeValidState())
    builder().putReference(makeReference('identity'))
    fake.answer('library.saveAnchor', { ok: true, data: { anchor: makeAnchorEntry() } })

    render(<AnchorPanel />)
    fireEvent.change(screen.getByLabelText('Lưu vào'), { target: { value: 'nguyen-van-a' } })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu anchor từ draft' }))

    await waitFor(() => {
      expect(fake.channels['library.saveAnchor']).toHaveBeenCalledTimes(1)
    })

    const request = fake.channels['library.saveAnchor'].mock.calls[0]?.[0] as {
      anchor: { id: string | null }
    }

    // Main picks the number; the renderer only says which anchor to extend.
    expect(request.anchor.id).toBe('nguyen-van-a')
    expect(screen.getByRole('option', { name: 'Nguyễn Văn A (v3)' })).toBeDefined()
  })
})
