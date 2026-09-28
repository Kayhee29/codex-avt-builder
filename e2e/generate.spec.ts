/**
 * Generate, end to end (plan Task 6.2, spec section 13).
 *
 * Acceptance criteria 14.7, 14.8, 14.9, 14.10 and 14.12: pressing Generate
 * materializes an immutable job directory with every reference copied into
 * `inputs/`, the main process runs `codex exec` as a child process, the UI
 * shows the progress that came out of the JSONL stream, a successful job has
 * `job.json`, `prompt.md`, `inputs/`, an output image, `events.jsonl` and a
 * valid `result.json`, and none of it asked for an API key.
 *
 * The run passes through five states in well under a second, so the sequence is
 * recorded by a `MutationObserver` installed before the click rather than by
 * polling: polling would see whichever two states it happened to land on. The
 * observer reads `data-state` on the run panel, which is the value the main
 * process set (spec section 5.5) and not a translated word.
 *
 * The Codex that runs is always `tests/fake-codex/fake-codex.mjs`
 * (`STUDIO_CODEX_LAUNCHER=fake`). No automated test starts the real CLI.
 */
import { expect, test, type Studio } from './fixtures.ts'
import { installRunStateRecorder, recordedRunStates } from './helpers/run-states.ts'

test.describe('generate', () => {
  test('runs a job through every state and writes a complete job directory', async ({ studio }) => {
    const { page, workspace } = studio

    await prepareJob(studio)
    await installRunStateRecorder(page)
    await page.locator('.generate > button').click()

    expect(await studio.waitForTerminalState()).toBe('succeeded')

    // Spec sections 5.5 and 12, in the order the state machine sets them.
    expect(await recordedRunStates(page)).toEqual([
      'queued',
      'preflight',
      'running',
      'verifying',
      'succeeded'
    ])

    const [jobId] = await workspace.listJobIds()

    expect(jobId).toBeDefined()

    const packet = await workspace.readJobPacket(jobId ?? '')

    // Spec section 14.7: every active reference was copied into the job.
    expect(packet.references.map((reference) => reference.path)).toEqual([
      'inputs/style.png',
      'inputs/identity.jpg'
    ])
    expect(packet.references.map((reference) => reference.label)).toEqual(['Image A', 'Image B'])
    expect(packet.subject.name).toBe('Nguyễn Văn A')
    // The field this job would otherwise lose (spec section 6.2).
    expect(packet.negativeConstraints).toEqual(['không chữ', 'không watermark'])

    const result = await workspace.readResult(jobId ?? '')

    // Spec section 14.10: a real result, with the image measured by main.
    expect(result.status).toBe('succeeded')
    expect(result.error).toBeNull()
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]?.path).toBe('outputs/001.png')
    expect(result.outputs[0]?.width).toBe(2)
    expect(result.executor.exitCode).toBe(0)
    expect(await workspace.listOutputs(jobId ?? '')).toEqual(['001.png'])

    // Spec section 14.9: the activity line came out of the JSONL stream.
    await expect(studio.runPanel()).toContainText('Thành công')

    const recent = studio.region('Job gần đây')

    await expect(recent).toContainText(jobId ?? '')
    await expect(recent).toContainText('Thành công')
    await expect(recent.getByRole('button', { name: 'Mở thư mục' })).toBeEnabled()
  })

  test('reopens a completed job from recent jobs and duplicates it into a draft', async ({
    studio
  }) => {
    const { page, workspace } = studio

    await prepareJob(studio)
    await page.locator('.generate > button').click()
    expect(await studio.waitForTerminalState()).toBe('succeeded')

    const recent = studio.region('Job gần đây')

    await expect(recent).toContainText('Thành công')

    // Spec section 4.6: a finished job is immutable, so duplicating it starts a
    // fresh draft from its packet and the handles main minted for its inputs.
    await recent.getByRole('button', { name: 'Nhân bản' }).click()
    await expect(recent).toContainText('Đã dựng nháp mới từ job này.')

    await expect(page.getByLabel('Tên nhân vật')).toHaveValue('Nguyễn Văn A')
    await expect(page.getByLabel('Ràng buộc loại trừ')).toHaveValue('không chữ\nkhông watermark')
    await expect(page.locator('section.slot[data-role="style"]')).toContainText('style-source.png')
    await expect(page.locator('section.slot[data-role="identity"]')).toContainText(
      'identity-source.jpg'
    )

    // The renderer holds opaque handles and never a path (plan decision Q3), so
    // nothing about the job's `inputs/` reaches the saved draft's state.
    await expect
      .poll(async () => (await workspace.readDraft())?.state.references.length, { timeout: 10_000 })
      .toBe(2)
    expect(JSON.stringify((await workspace.readDraft())?.state)).not.toContain('inputs/')

    // Spec section 10: the duplicate is a new draft, not a second run of the
    // old job, and it has not started anything.
    expect(await workspace.listJobIds()).toHaveLength(1)
  })
})

/** A valid draft with two references, ready for Generate. */
async function prepareJob(studio: Studio): Promise<void> {
  const { page, workspace } = studio

  await page.getByLabel('Tên nhân vật').fill('Nguyễn Văn A')
  await page.getByLabel('Mô tả nhân vật').fill('Nam, ngoài 50 tuổi')
  await page.getByLabel('Ràng buộc loại trừ').fill('không chữ\nkhông watermark')

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
