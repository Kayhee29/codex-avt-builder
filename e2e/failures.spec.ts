/**
 * The failure paths, end to end (plan Task 6.2, spec section 13).
 *
 * Acceptance criterion 14.11: a missing Codex CLI, a missing login or a missing
 * image capability produces a clear failed state and never a fallback to an
 * API. Spec section 2 allows no fallback at all, so what these tests really
 * check is that the job stops with a code and a `result.json` that says why.
 *
 * `CODEX_NOT_FOUND` is observable before Generate is even pressed: the
 * preflight banner calls `system.preflight` when it mounts (plan Task 5.5), so
 * the cheapest assertion is the one on the banner, and the job that follows
 * proves the same code reaches `result.json`.
 */
import { expect, test, type Studio } from './fixtures.ts'

test.describe('failures', () => {
  test.describe('with no Codex on the machine', () => {
    test.use({ codexLauncher: 'missing' })

    test('says so in the banner and fails the job with CODEX_NOT_FOUND', async ({ studio }) => {
      const { page, workspace } = studio

      // The banner ran preflight on mount, and preflight never runs
      // `codex exec`, so this costs no generation (spec section 5.3).
      await expect(studio.region('Trạng thái Codex CLI')).toContainText(
        'Không tìm thấy Codex CLI trên máy này.'
      )

      await prepareJob(studio)
      await page.locator('.generate > button').click()

      expect(await studio.waitForTerminalState()).toBe('failed')

      const [jobId] = await workspace.listJobIds()
      const result = await workspace.readResult(jobId ?? '')

      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('CODEX_NOT_FOUND')
      // Spec section 7.2: Codex never ran, so there is nothing to record.
      expect(result.executor).toEqual({
        codexVersion: null,
        executable: null,
        exitCode: null,
        signal: null
      })
      expect(result.outputs).toEqual([])
      // Spec sections 2 and 14.11: no fallback produced an image anyway.
      expect(await workspace.listOutputs(jobId ?? '')).toEqual([])

      await expect(studio.region('Job gần đây')).toContainText(
        'Không tìm thấy Codex CLI trên máy này.'
      )
    })
  })

  test.describe('when Codex has no image capability', () => {
    test.use({ codexScenario: 'capability-unavailable' })

    test('fails the job with IMAGE_CAPABILITY_UNAVAILABLE and a sanitized message', async ({
      studio
    }) => {
      const { page, workspace } = studio

      await prepareJob(studio)
      await page.locator('.generate > button').click()

      expect(await studio.waitForTerminalState()).toBe('failed')

      const [jobId] = await workspace.listJobIds()
      const result = await workspace.readResult(jobId ?? '')

      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('IMAGE_CAPABILITY_UNAVAILABLE')
      expect(result.error?.message).toContain('image_gen')
      // Spec section 11: the message Codex wrote carried an absolute path and a
      // bearer token, and neither value may survive into the result. The words
      // around them stay, so the sentence still explains itself.
      expect(result.error?.message).not.toContain('sk-')
      expect(result.error?.message).not.toContain('C:\\Users')
      expect(result.error?.message).toContain('[redacted]')
      expect(result.error?.message).toContain('[path]')
      expect(result.outputs).toEqual([])

      await expect(studio.region('Job gần đây')).toContainText(
        'Codex trên máy này không có khả năng tạo ảnh.'
      )
    })
  })

  test.describe('while Codex is stuck', () => {
    test.use({ codexScenario: 'hang' })

    test('cancels the run and writes a cancelled result', async ({ studio }) => {
      const { page, workspace } = studio

      await prepareJob(studio)
      await page.locator('.generate > button').click()

      // Cancel is accepted from `queued`, `preflight` and `running`
      // (spec section 5.5, plan decision Q20).
      await studio.waitForRunState(['running'])
      await studio.runPanel().getByRole('button', { name: 'Hủy job' }).click()

      expect(await studio.waitForTerminalState()).toBe('cancelled')

      const [jobId] = await workspace.listJobIds()
      const result = await workspace.readResult(jobId ?? '')

      expect(result.status).toBe('cancelled')
      expect(result.error?.code).toBe('CANCELLED')
      expect(await workspace.listOutputs(jobId ?? '')).toEqual([])

      await expect(studio.region('Job gần đây')).toContainText('Đã hủy')
      // Spec section 10: a cancelled job keeps its directory and its log.
      await expect(studio.region('Job gần đây')).toContainText(jobId ?? '')
    })
  })
})

/** A valid draft with two references, ready for Generate. */
async function prepareJob(studio: Studio): Promise<void> {
  const { page, workspace } = studio

  await page.getByLabel('Tên nhân vật').fill('Nguyễn Văn A')
  await page.getByLabel('Mô tả nhân vật').fill('Nam, ngoài 50 tuổi')

  for (const role of ['style', 'identity'] as const) {
    await workspace.offerImage(role)
    await page
      .locator(`section.slot[data-role="${role}"]`)
      .getByRole('button', { name: 'Chọn ảnh' })
      .click()
    await expect(page.locator(`section.slot[data-role="${role}"]`)).toContainText(`${role}-source.`)
  }

  await expect(page.locator('.generate > button')).toBeEnabled()
}
