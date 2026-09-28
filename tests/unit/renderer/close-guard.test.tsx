// @vitest-environment jsdom
/**
 * The window half of the close guard (plan Task 5.6, spec sections 4.6 and 10).
 *
 * The dialog itself is the main process's (`tests/unit/close-guard.test.ts`).
 * What is under test here is what the renderer owns: the warning that a close
 * would cancel the run, and the draft being written out as the window goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { CloseGuard } from '../../../src/renderer/components/CloseGuard.tsx'
import { useBuilderStore } from '../../../src/renderer/store/builder.ts'
import { useJobsStore } from '../../../src/renderer/store/jobs.ts'

import { installFakeBridge, makeProgress, makeValidState, type FakeBridge } from './harness.ts'

let fake: FakeBridge

beforeEach(() => {
  fake = installFakeBridge()
  useBuilderStore.getState().reset()
  useJobsStore.getState().reset()
})

afterEach(() => {
  cleanup()
  useBuilderStore.getState().reset()
  useJobsStore.getState().reset()
  vi.unstubAllGlobals()
})

describe('the in-window warning (spec section 10)', () => {
  it('says nothing while no run is in flight', () => {
    render(<CloseGuard />)

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('warns while a run is in flight', () => {
    render(<CloseGuard />)

    act(() => {
      useJobsStore.getState().applyProgress(makeProgress({ state: 'running', seq: 1 }))
    })

    expect(screen.getByRole('status').textContent).toBe(
      'Đang có job chạy. Đóng cửa sổ bây giờ sẽ hủy job đó.'
    )
  })

  it('stops warning once the run has ended', () => {
    render(<CloseGuard />)

    act(() => {
      useJobsStore.getState().applyProgress(makeProgress({ state: 'running', seq: 1 }))
      useJobsStore.getState().applyProgress(makeProgress({ state: 'cancelled', seq: 2 }))
    })

    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('the draft when the window goes away (spec section 4.6)', () => {
  it('writes the draft out on beforeunload', () => {
    useBuilderStore.getState().adoptState(makeValidState())
    render(<CloseGuard />)

    act(() => {
      useBuilderStore.getState().setSubjectField('pose', 'đứng thẳng')
    })
    // Well inside the 800 ms autosave window, so nothing has been saved yet.
    expect(fake.channels['draft.save']).not.toHaveBeenCalled()

    window.dispatchEvent(new Event('beforeunload'))

    expect(fake.channels['draft.save']).toHaveBeenCalledTimes(1)
  })

  it('stops listening when it is unmounted', () => {
    useBuilderStore.getState().adoptState(makeValidState())

    const view = render(<CloseGuard />)

    act(() => {
      useBuilderStore.getState().setSubjectField('pose', 'đứng thẳng')
    })
    view.unmount()

    window.dispatchEvent(new Event('beforeunload'))

    expect(fake.channels['draft.save']).not.toHaveBeenCalled()
  })
})
