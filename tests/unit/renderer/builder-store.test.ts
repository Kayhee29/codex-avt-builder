// @vitest-environment jsdom
/**
 * The builder store (plan Task 5.1, spec sections 4.6, 11 and 12).
 *
 * Three things are under test: the status derivation of spec section 12, the
 * 800 ms draft autosave of spec section 4.6, and the rule that no path ever
 * travels from the renderer to the main process (spec section 11).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BuilderStateInputSchema } from '@shared/ipc-contract'

import {
  AUTOSAVE_DEBOUNCE_MS,
  selectBuilderStatus,
  selectCanGenerate,
  selectMissingRoles,
  selectReference,
  toBuilderStateInput,
  useBuilderStore
} from '../../../src/renderer/store/builder.ts'

import { installFakeBridge, makeReference, makeValidState, type FakeBridge } from './harness.ts'

let fake: FakeBridge

function status(): string {
  return selectBuilderStatus(useBuilderStore.getState())
}

beforeEach(() => {
  vi.useFakeTimers()
  fake = installFakeBridge()
  useBuilderStore.getState().reset()
})

afterEach(() => {
  useBuilderStore.getState().reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('builder status (spec section 12)', () => {
  it('starts clean and invalid, because the empty state has no subject yet', () => {
    const store = useBuilderStore.getState()

    expect(store.pristine).toBe(true)
    expect(store.valid).toBe(false)
    expect(status()).toBe('clean')
  })

  it('turns dirty when the subject name is typed into a state that is valid', () => {
    useBuilderStore.getState().adoptState(makeValidState())
    expect(status()).toBe('clean')

    useBuilderStore.getState().setSubjectField('name', 'Nguyễn Văn B')

    expect(useBuilderStore.getState().dirty).toBe(true)
    expect(status()).toBe('dirty')
  })

  it('stays invalid while the subject is only half filled in', () => {
    useBuilderStore.getState().setSubjectField('name', 'Nguyễn Văn A')

    // A name without a description does not satisfy `SubjectSchema`, so the
    // state is still invalid even though it now has an edit in it.
    expect(useBuilderStore.getState().dirty).toBe(true)
    expect(status()).toBe('invalid')
  })

  it('reaches ready once a valid state has been autosaved', async () => {
    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().setSubjectField('pose', 'đứng thẳng, nhìn thẳng ống kính')

    await useBuilderStore.getState().flushAutosave()

    expect(useBuilderStore.getState().savedAt).toBe('2026-09-28T10:00:00.000Z')
    expect(status()).toBe('ready')
  })

  it('falls back to invalid when the name is deleted again', () => {
    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().setSubjectField('name', '')

    expect(status()).toBe('invalid')
  })

  it('reports saving while a draft.save is in flight', async () => {
    let release: (() => void) | undefined
    fake.channels['draft.save'].mockImplementation(
      async () =>
        new Promise((resolve) => {
          release = (): void => {
            resolve({ ok: true, data: { savedAt: '2026-09-28T10:00:00.000Z' } })
          }
        })
    )

    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().setSubjectField('pose', 'ngồi')

    const flushed = useBuilderStore.getState().flushAutosave()
    await vi.advanceTimersByTimeAsync(0)

    expect(status()).toBe('saving')

    release?.()
    await flushed

    expect(status()).toBe('ready')
  })
})

describe('draft autosave (spec section 4.6)', () => {
  it('does not save before the debounce window is over', async () => {
    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().setSubjectField('pose', 'đứng')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1)

    expect(fake.channels['draft.save']).not.toHaveBeenCalled()
  })

  it('saves exactly once however many keystrokes fall inside the window', async () => {
    useBuilderStore.getState().adoptState(makeValidState())

    for (const value of ['đ', 'đứ', 'đứn', 'đứng']) {
      useBuilderStore.getState().setSubjectField('pose', value)
      await vi.advanceTimersByTimeAsync(100)
    }

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS)

    expect(fake.channels['draft.save']).toHaveBeenCalledTimes(1)
    expect(useBuilderStore.getState().dirty).toBe(false)
  })

  it('never sends an invalid state, because draft.save would only refuse it', async () => {
    useBuilderStore.getState().setSubjectField('name', 'Nguyễn Văn A')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)

    expect(fake.channels['draft.save']).not.toHaveBeenCalled()
    expect(useBuilderStore.getState().dirty).toBe(true)
  })

  it('keeps the edits dirty and records the code when the save is refused', async () => {
    fake.answer('draft.save', { ok: false, code: 'IO_ERROR', message: 'disk is full' })

    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().setSubjectField('pose', 'đứng')

    await useBuilderStore.getState().flushAutosave()

    expect(useBuilderStore.getState().saveErrorCode).toBe('IO_ERROR')
    expect(useBuilderStore.getState().dirty).toBe(true)
  })

  it('adopts a loaded draft without marking it dirty or saving it again', async () => {
    fake.answer('draft.load', {
      ok: true,
      data: {
        draft: {
          state: makeValidState({ negativeConstraints: ['không đeo kính', 'không mũ'] }),
          savedAt: '2026-09-27T08:30:00.000Z'
        }
      }
    })

    await useBuilderStore.getState().loadDraft()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 2)

    const store = useBuilderStore.getState()

    expect(store.pristine).toBe(true)
    expect(store.savedAt).toBe('2026-09-27T08:30:00.000Z')
    expect(store.negativeConstraintsText).toBe('không đeo kính\nkhông mũ')
    expect(fake.channels['draft.save']).not.toHaveBeenCalled()
  })
})

describe('what crosses IPC (spec section 11, plan decision Q3)', () => {
  it('strips displayPath and thumbnail from every reference it sends', async () => {
    useBuilderStore.getState().adoptState(makeValidState())
    useBuilderStore.getState().putReference(makeReference('style'))

    await useBuilderStore.getState().flushAutosave()

    const request = fake.channels['draft.save'].mock.calls[0]?.[0] as { state: unknown }
    const parsed = BuilderStateInputSchema.safeParse(request.state)

    // `BuilderStateInputSchema` is strict, so this fails if either field rode
    // along: main must never receive a path it handed out for display.
    expect(parsed.success).toBe(true)
    expect(JSON.stringify(request.state)).not.toContain('displayPath')
    expect(JSON.stringify(request.state)).not.toContain('thumbnail')
  })

  it('carries the note of a slot but not its handle-only fields', () => {
    const input = toBuilderStateInput(
      makeValidState({ references: [makeReference('identity', { note: 'giữ nguyên nếp nhăn' })] })
    )

    expect(input.references[0]).toEqual({
      referenceId: '00000000-0000-4000-8000-000000000002',
      role: 'identity',
      originalName: 'identity.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
      width: 512,
      height: 512,
      sha256: 'a'.repeat(64),
      missing: false,
      note: 'giữ nguyên nếp nhăn'
    })
  })
})

describe('reference slots as the store sees them', () => {
  it('blocks generating while a reference file has gone missing', () => {
    useBuilderStore.getState().adoptState(makeValidState())
    expect(selectCanGenerate(useBuilderStore.getState())).toBe(true)

    useBuilderStore.getState().putReference(makeReference('outfit', { missing: true }))

    expect(selectMissingRoles(useBuilderStore.getState())).toEqual(['outfit'])
    expect(selectCanGenerate(useBuilderStore.getState())).toBe(false)
  })

  it('places a picked reference in its own slot', async () => {
    fake.answer('dialog.selectReference', {
      ok: true,
      data: { reference: makeReference('equipment') }
    })

    await useBuilderStore.getState().pickReference('equipment')

    expect(fake.channels['dialog.selectReference']).toHaveBeenCalledWith({ role: 'equipment' })
    expect(selectReference(useBuilderStore.getState(), 'equipment')?.originalName).toBe(
      'equipment.png'
    )
  })

  it('changes nothing when the user closes the picker without choosing', async () => {
    useBuilderStore.getState().adoptState(makeValidState())

    await useBuilderStore.getState().pickReference('style')

    expect(useBuilderStore.getState().state.references).toEqual([])
    expect(useBuilderStore.getState().pristine).toBe(true)
  })
})
