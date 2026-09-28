// @vitest-environment jsdom
/**
 * The jobs store (plan Task 5.1, spec sections 5.5 and 12).
 *
 * The run state comes from the main process and is never inferred here, so what
 * is worth testing is the bookkeeping: keeping the newest event per job,
 * dropping one that arrived late, and letting go of the subscription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  selectActiveProgress,
  selectIsRunning,
  useJobsStore
} from '../../../src/renderer/store/jobs.ts'

import { installFakeBridge, makeProgress, type FakeBridge } from './harness.ts'

let fake: FakeBridge

beforeEach(() => {
  fake = installFakeBridge()
  useJobsStore.getState().reset()
})

afterEach(() => {
  useJobsStore.getState().reset()
  vi.unstubAllGlobals()
})

describe('progress events', () => {
  it('keeps the newest event per job', () => {
    useJobsStore.getState().applyProgress(makeProgress({ seq: 1, state: 'queued' }))
    useJobsStore.getState().applyProgress(makeProgress({ seq: 2, state: 'running' }))

    expect(selectActiveProgress(useJobsStore.getState())?.state).toBe('running')
    expect(selectIsRunning(useJobsStore.getState())).toBe(true)
  })

  it('drops an event that arrives out of order', () => {
    useJobsStore
      .getState()
      .applyProgress(makeProgress({ seq: 5, state: 'running', activity: 'Đang gọi image_gen' }))
    useJobsStore.getState().applyProgress(makeProgress({ seq: 4, state: 'preflight' }))

    expect(selectActiveProgress(useJobsStore.getState())?.seq).toBe(5)
    expect(selectActiveProgress(useJobsStore.getState())?.activity).toBe('Đang gọi image_gen')
  })

  it('clears the active job once the run reaches a terminal state', () => {
    useJobsStore.getState().applyProgress(makeProgress({ seq: 1, state: 'running' }))
    useJobsStore.getState().applyProgress(makeProgress({ seq: 9, state: 'succeeded' }))

    expect(useJobsStore.getState().activeJobId).toBeNull()
    expect(selectIsRunning(useJobsStore.getState())).toBe(false)
    expect(useJobsStore.getState().progressByJobId['2026-09-28-nguyen-van-a-001']?.state).toBe(
      'succeeded'
    )
  })
})

describe('subscription', () => {
  it('re-reads the job list when a run ends and unsubscribes on demand', async () => {
    const unsubscribe = useJobsStore.getState().subscribeToProgress()

    expect(fake.progressListenerCount()).toBe(1)

    fake.emitProgress(makeProgress({ seq: 1, state: 'running' }))
    expect(fake.channels['jobs.list']).not.toHaveBeenCalled()

    fake.emitProgress(makeProgress({ seq: 2, state: 'failed' }))
    await vi.waitFor(() => {
      expect(fake.channels['jobs.list']).toHaveBeenCalledTimes(1)
    })

    unsubscribe()
    expect(fake.progressListenerCount()).toBe(0)
  })
})

describe('recent jobs list', () => {
  it('records the error code when the list cannot be read', async () => {
    fake.answer('jobs.list', { ok: false, code: 'IO_ERROR', message: 'workspace unreadable' })

    await useJobsStore.getState().refresh()

    expect(useJobsStore.getState().listErrorCode).toBe('IO_ERROR')
    expect(useJobsStore.getState().refreshing).toBe(false)
  })
})
