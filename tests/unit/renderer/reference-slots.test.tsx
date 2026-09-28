// @vitest-environment jsdom
/**
 * The five reference slots (plan Task 5.3, spec sections 4.2 and 14.2).
 *
 * The load-bearing case is the second one: replacing one slot must leave the
 * other four exactly as they were. "Exactly" is checked two ways — the four
 * survive as the *same objects*, and their JSON serialisation is unchanged
 * byte for byte — because a store that rebuilt every reference on every edit
 * would pass a shallow equality check while still being the bug spec section
 * 4.2 forbids.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { REFERENCE_ROLES, type ReferenceRole } from '@shared/reference-roles'
import type { BuilderReference } from '@shared/schemas'

import { ReferenceSlots } from '../../../src/renderer/components/ReferenceSlots.tsx'
import {
  selectCanGenerate,
  selectReference,
  useBuilderStore
} from '../../../src/renderer/store/builder.ts'

import { installFakeBridge, makeReference, makeValidState, type FakeBridge } from './harness.ts'

let fake: FakeBridge

/** The Vietnamese slot headings, which are how a slot is addressed in the UI. */
const SLOT_NAME: Record<ReferenceRole, string> = {
  style: 'Phong cách',
  identity: 'Nhận diện',
  outfit: 'Trang phục',
  equipment: 'Trang bị',
  extra: 'Bổ sung'
}

function slot(role: ReferenceRole): ReturnType<typeof within> {
  return within(screen.getByRole('region', { name: SLOT_NAME[role] }))
}

function referenceIn(role: ReferenceRole): BuilderReference | null {
  return selectReference(useBuilderStore.getState(), role)
}

/** Fills all five slots, each with its own note. */
function fillEverySlot(): void {
  useBuilderStore.getState().adoptState(makeValidState())

  for (const role of REFERENCE_ROLES) {
    useBuilderStore.getState().putReference(makeReference(role, { note: `ghi chú ${role}` }))
  }
}

beforeEach(() => {
  fake = installFakeBridge()
  useBuilderStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useBuilderStore.getState().reset()
  vi.unstubAllGlobals()
})

describe('a slot on its own (spec section 4.2)', () => {
  it('renders exactly the five roles, in the fixed order', () => {
    render(<ReferenceSlots />)

    const headings = screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)

    expect(headings).toEqual(['Phong cách', 'Nhận diện', 'Trang phục', 'Trang bị', 'Bổ sung'])
  })

  it('asks the picker for its own role and nothing else', async () => {
    fake.answer('dialog.selectReference', { ok: true, data: { reference: makeReference('extra') } })
    render(<ReferenceSlots />)

    fireEvent.click(slot('extra').getByRole('button', { name: 'Chọn ảnh' }))

    await waitFor(() => {
      expect(referenceIn('extra')).not.toBeNull()
    })
    expect(fake.channels['dialog.selectReference']).toHaveBeenCalledTimes(1)
    expect(fake.channels['dialog.selectReference']).toHaveBeenCalledWith({ role: 'extra' })
    expect(useBuilderStore.getState().state.references).toHaveLength(1)
  })

  it('shows the file name, the shortened source path and the thumbnail', () => {
    fillEverySlot()
    render(<ReferenceSlots />)

    const identity = slot('identity')

    expect(identity.getByText('identity.png')).toBeDefined()
    expect(identity.getByText('…\\references\\identity.png')).toBeDefined()
    expect(identity.getByRole('img', { name: 'identity.png' }).getAttribute('src')).toBe(
      'data:image/png;base64,AAAA'
    )
  })

  it('keeps a note per role', () => {
    fillEverySlot()
    render(<ReferenceSlots />)

    fireEvent.change(slot('outfit').getByLabelText('Ghi chú cho vai trò này'), {
      target: { value: 'giữ nguyên phù hiệu vai trái' }
    })

    expect(referenceIn('outfit')?.note).toBe('giữ nguyên phù hiệu vai trái')
    expect(referenceIn('identity')?.note).toBe('ghi chú identity')
  })

  it('drops the note of the slot it removes, and only that one', () => {
    fillEverySlot()
    render(<ReferenceSlots />)

    fireEvent.click(slot('equipment').getByRole('button', { name: 'Gỡ ảnh' }))

    expect(referenceIn('equipment')).toBeNull()
    expect(slot('equipment').getByText('Chưa chọn ảnh.')).toBeDefined()
    expect(useBuilderStore.getState().state.references).toHaveLength(4)
    expect(referenceIn('style')?.note).toBe('ghi chú style')
  })
})

describe('replacing one slot leaves the others untouched (spec section 14.2)', () => {
  it('rewrites outfit and nothing else', async () => {
    fillEverySlot()

    const untouched = REFERENCE_ROLES.filter((role) => role !== 'outfit')
    const before = new Map(untouched.map((role) => [role, referenceIn(role)]))
    const beforeJson = new Map(
      untouched.map((role) => [role, JSON.stringify(referenceIn(role))] as const)
    )
    const beforeOutfit = referenceIn('outfit')

    fake.answer('dialog.selectReference', {
      ok: true,
      data: {
        reference: makeReference('outfit', {
          referenceId: '00000000-0000-4000-8000-0000000000ff',
          originalName: 'outfit-v2.webp',
          mimeType: 'image/webp',
          sha256: 'b'.repeat(64)
        })
      }
    })

    render(<ReferenceSlots />)
    fireEvent.click(slot('outfit').getByRole('button', { name: 'Thay ảnh' }))

    await waitFor(() => {
      expect(referenceIn('outfit')?.originalName).toBe('outfit-v2.webp')
    })

    // The slot that was replaced really changed.
    expect(referenceIn('outfit')).not.toBe(beforeOutfit)
    expect(referenceIn('outfit')?.sha256).toBe('b'.repeat(64))

    for (const role of untouched) {
      // Same object, so nothing rebuilt them…
      expect(referenceIn(role), role).toBe(before.get(role))
      // …and the same bytes, which is the claim spec section 14.2 makes.
      expect(JSON.stringify(referenceIn(role)), role).toBe(beforeJson.get(role))
    }

    expect(useBuilderStore.getState().state.references).toHaveLength(5)
  })

  it('keeps the replaced slot its own note, because remove is the way to clear it', async () => {
    fillEverySlot()

    fake.answer('dialog.selectReference', {
      ok: true,
      data: {
        reference: makeReference('outfit', {
          referenceId: '00000000-0000-4000-8000-0000000000ff',
          originalName: 'outfit-v2.webp'
        })
      }
    })

    render(<ReferenceSlots />)
    fireEvent.click(slot('outfit').getByRole('button', { name: 'Thay ảnh' }))

    await waitFor(() => {
      expect(referenceIn('outfit')?.originalName).toBe('outfit-v2.webp')
    })
    expect(referenceIn('outfit')?.note).toBe('ghi chú outfit')
  })

  it('changes nothing at all when the picker is closed without a choice', async () => {
    fillEverySlot()

    const before = useBuilderStore.getState().state.references

    render(<ReferenceSlots />)
    fireEvent.click(slot('style').getByRole('button', { name: 'Thay ảnh' }))

    await waitFor(() => {
      expect(fake.channels['dialog.selectReference']).toHaveBeenCalledTimes(1)
    })
    expect(useBuilderStore.getState().state.references).toBe(before)
  })
})

describe('a reference whose file has gone (spec section 4.2)', () => {
  it('warns on the slot, warns above the list and blocks Generate', () => {
    fillEverySlot()
    useBuilderStore
      .getState()
      .putReference(makeReference('identity', { note: 'ghi chú identity', missing: true }))

    render(<ReferenceSlots />)

    expect(
      slot('identity').getByText('Tệp gốc không còn tồn tại. Hãy chọn lại ảnh cho vai trò này.')
    ).toBeDefined()
    expect(screen.getByRole('alert').textContent).toContain(
      'Còn ảnh tham chiếu không tồn tại nên chưa thể tạo ảnh.'
    )
    expect(selectCanGenerate(useBuilderStore.getState())).toBe(false)
  })

  it('lets Generate through again once the file is replaced', async () => {
    fillEverySlot()
    useBuilderStore.getState().putReference(makeReference('style', { missing: true }))
    expect(selectCanGenerate(useBuilderStore.getState())).toBe(false)

    fake.answer('dialog.selectReference', {
      ok: true,
      data: { reference: makeReference('style', { originalName: 'style-again.png' }) }
    })

    render(<ReferenceSlots />)
    fireEvent.click(slot('style').getByRole('button', { name: 'Thay ảnh' }))

    await waitFor(() => {
      expect(selectCanGenerate(useBuilderStore.getState())).toBe(true)
    })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a picker the main process refused', async () => {
    fake.answer('dialog.selectReference', {
      ok: false,
      code: 'IO_ERROR',
      message: 'dialog unavailable'
    })

    render(<ReferenceSlots />)
    fireEvent.click(slot('style').getByRole('button', { name: 'Chọn ảnh' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Không đọc hoặc ghi được dữ liệu trên đĩa.'
      )
    })
  })
})
