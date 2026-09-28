// @vitest-environment jsdom
/**
 * The whole window mounts (plan Tasks 5.1 to 5.6).
 *
 * `Layout` left a region for each panel and rendered a placeholder until one
 * arrived. This is the check that every one of them is now filled and that the
 * window as a whole survives being mounted with the bridge answering — the one
 * failure no single component test can see, because each of them renders its
 * own component and never the app.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

import { App } from '../../../src/renderer/app.tsx'

import { installFakeBridge } from './harness.ts'

beforeEach(() => {
  installFakeBridge()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('mounts every region of the window, with no placeholder left', async () => {
  render(<App />)

  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Preset' })).toBeDefined()
  })

  for (const name of [
    'Chỉ đạo nhân vật',
    'Ảnh tham chiếu',
    'Xem trước prompt',
    'Preset',
    'Anchor',
    'Job gần đây',
    'Tạo ảnh',
    'Trạng thái Codex CLI'
  ]) {
    expect(screen.getByRole('region', { name }), name).toBeDefined()
  }

  expect(screen.queryByText('Phần này được hoàn thiện ở bước sau.')).toBeNull()
})
