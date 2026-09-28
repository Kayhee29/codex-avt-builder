// @vitest-environment jsdom
/**
 * The builder shell and the app wiring (plan Task 5.1).
 *
 * The layout test is about the seams: three columns now, and four bottom-bar
 * regions that plan Tasks 5.4 and 5.5 fill without moving anything. The app
 * test is about the three things that must happen exactly once when the window
 * opens, and about letting the progress subscription go again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { App } from '../../../src/renderer/app.tsx'
import { Layout } from '../../../src/renderer/components/Layout.tsx'
import { useBuilderStore } from '../../../src/renderer/store/builder.ts'
import { useJobsStore } from '../../../src/renderer/store/jobs.ts'

import { installFakeBridge, type FakeBridge } from './harness.ts'

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

describe('Layout', () => {
  it('shows the three columns of the builder', () => {
    render(
      <Layout
        characterDirection={<p>chỉ đạo</p>}
        referenceSlots={<p>tham chiếu</p>}
        promptPreview={<p>xem trước</p>}
      />
    )

    expect(screen.getByRole('region', { name: 'Chỉ đạo nhân vật' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Ảnh tham chiếu' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Xem trước prompt' })).toBeDefined()
  })

  it('reserves the four bottom-bar regions later tasks fill', () => {
    render(<Layout characterDirection={null} referenceSlots={null} promptPreview={null} />)

    for (const name of ['Preset', 'Anchor', 'Job gần đây', 'Tạo ảnh']) {
      const region = screen.getByRole('region', { name })

      expect(region.textContent).toContain('Phần này được hoàn thiện ở bước sau.')
    }
  })

  it('lets a later task replace a reserved region', () => {
    render(
      <Layout
        characterDirection={null}
        referenceSlots={null}
        promptPreview={null}
        generateBar={<button type="button">Tạo ảnh ngay</button>}
      />
    )

    expect(screen.getByRole('button', { name: 'Tạo ảnh ngay' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'Tạo ảnh' }).textContent).not.toContain(
      'Phần này được hoàn thiện ở bước sau.'
    )
  })
})

describe('App', () => {
  it('loads the draft, reads the job list and subscribes to progress once', async () => {
    const view = render(<App />)

    await vi.waitFor(() => {
      expect(fake.channels['draft.load']).toHaveBeenCalledTimes(1)
      expect(fake.channels['jobs.list']).toHaveBeenCalledTimes(1)
    })

    expect(fake.progressListenerCount()).toBe(1)

    view.unmount()

    expect(fake.progressListenerCount()).toBe(0)
  })

  it('shows the builder status of spec section 12 in the header', () => {
    render(<App />)

    expect(screen.getByText('Chưa có thay đổi')).toBeDefined()
  })
})
