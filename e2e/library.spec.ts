/**
 * Presets and anchors, end to end (plan Task 6.2, spec section 13).
 *
 * Acceptance criteria 14.4 and 14.5: a preset can be saved, listed, loaded and
 * merged in the right order, and an anchor can be saved, versioned and reused
 * without locking outfit, equipment, pose or expression.
 *
 * Applying a preset is deliberately two steps (plan decision Q5), so both are
 * exercised: cancelling the confirmation must leave the draft exactly as it
 * was, and only confirming may change it.
 *
 * Saving the second version goes through the `Lưu vào` select rather than
 * saving the same name twice: `library.saveAnchor` needs an existing anchor id
 * to produce `v2`, and a second save by name would mint a new anchor instead.
 */
import { expect, test, type Studio } from './fixtures.ts'

test.describe('library', () => {
  test('saves a preset, lists it and applies it back onto a changed draft', async ({ studio }) => {
    const { page, workspace } = studio

    await fillSubject(studio, 'Nguyễn Văn A', 'Nam, ngoài 50 tuổi')
    await page.getByLabel('Pose', { exact: true }).fill('đứng thẳng')
    await page.getByLabel('Nền', { exact: true }).fill('giấy ấm')
    await page.getByLabel('Ràng buộc loại trừ').fill('không chữ')

    await workspace.offerImage('style')
    await studio.page
      .locator('section.slot[data-role="style"]')
      .getByRole('button', { name: 'Chọn ảnh' })
      .click()
    await expect(studio.page.locator('section.slot[data-role="style"]')).toContainText(
      'style-source.png'
    )

    const presets = studio.region('Preset')

    await presets.getByLabel('Tên preset').fill('Chibi master')
    await presets.getByRole('button', { name: 'Lưu preset từ draft' }).click()

    // Spec section 4.4 and plan decision Q4: the metadata and a copy of the
    // style image land together under `workspace/presets/<id>/`.
    await expect
      .poll(async () => workspace.listPresetIds(), { timeout: 10_000 })
      .toEqual(['chibi-master'])
    await expect(presets).toContainText('Chibi master')

    // Now move the draft away from the preset, so applying it has work to do.
    await page.getByLabel('Pose', { exact: true }).fill('ngồi xổm')
    await page.getByLabel('Nền', { exact: true }).fill('nền tối')
    await page.getByLabel('Ràng buộc loại trừ').fill('')

    await presets.getByRole('button', { name: 'Áp dụng' }).click()

    const dialog = page.getByRole('dialog', { name: 'Áp preset lên draft hiện tại' })

    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Pose')
    await expect(dialog).toContainText('Nền')

    // Cancelling applies nothing (plan decision Q5).
    await dialog.getByRole('button', { name: 'Hủy', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByLabel('Pose', { exact: true })).toHaveValue('ngồi xổm')

    await presets.getByRole('button', { name: 'Áp dụng' }).click()
    await page
      .getByRole('dialog', { name: 'Áp preset lên draft hiện tại' })
      .getByRole('button', { name: 'Áp preset' })
      .click()

    await expect(page.getByLabel('Pose', { exact: true })).toHaveValue('đứng thẳng')
    await expect(page.getByLabel('Nền', { exact: true })).toHaveValue('giấy ấm')
    await expect(page.getByLabel('Ràng buộc loại trừ')).toHaveValue('không chữ')

    await expect
      .poll(async () => (await workspace.readDraft())?.state.source.preset, { timeout: 10_000 })
      .toBe('chibi-master')
  })

  test('versions an anchor and builds a new draft from it', async ({ studio }) => {
    const { page, workspace } = studio

    await fillSubject(studio, 'Nguyễn Văn A', 'Nam, ngoài 50 tuổi, tóc bạc hai bên')
    await page.getByLabel('Pose', { exact: true }).fill('đứng thẳng')

    await workspace.offerImage('identity')
    await studio.page
      .locator('section.slot[data-role="identity"]')
      .getByRole('button', { name: 'Chọn ảnh' })
      .click()
    await expect(studio.page.locator('section.slot[data-role="identity"]')).toContainText(
      'identity-source.jpg'
    )

    await workspace.offerImage('outfit')
    await studio.page
      .locator('section.slot[data-role="outfit"]')
      .getByRole('button', { name: 'Chọn ảnh' })
      .click()
    await expect(studio.page.locator('section.slot[data-role="outfit"]')).toContainText(
      'outfit-source.webp'
    )

    const anchors = studio.region('Anchor')

    await anchors.getByLabel('Tên anchor').fill('Nguyễn Văn A')
    await anchors.getByLabel('Đặc điểm cố định').fill('đường chân tóc\nquai hàm')
    await anchors.getByRole('button', { name: 'Lưu anchor từ draft' }).click()

    await expect
      .poll(async () => workspace.listAnchorVersions('nguyen-van-a'), { timeout: 10_000 })
      .toEqual(['v1'])

    // Spec section 4.5: saving again creates a new version and never
    // overwrites one, which is why the target has to be the existing anchor.
    await anchors.getByLabel('Lưu vào').selectOption('nguyen-van-a')
    await anchors.getByRole('button', { name: 'Lưu anchor từ draft' }).click()

    await expect
      .poll(async () => workspace.listAnchorVersions('nguyen-van-a'), { timeout: 10_000 })
      .toEqual(['v1', 'v2'])
    expect(await workspace.listAnchorIds()).toEqual(['nguyen-van-a'])
    await expect(anchors).toContainText('Nguyễn Văn A (v2)')
    await expect(anchors).toContainText('Nguyễn Văn A (v1)')

    // Loading replaces the draft, so it asks first (plan Task 5.4).
    await anchors.getByRole('button', { name: 'Tạo draft mới' }).first().click()

    const dialog = page.getByRole('dialog', { name: 'Tạo draft mới từ anchor' })

    await expect(dialog).toContainText('Nguyễn Văn A (v2)')
    await dialog.getByRole('button', { name: 'Tạo draft mới' }).click()

    // Spec sections 4.5 and 14.5: the identity comes back, and everything the
    // anchor deliberately does not pin is left for the user to fill in.
    await expect(studio.page.locator('section.slot[data-role="identity"]')).toContainText(
      'identity.jpg'
    )
    await expect(studio.page.locator('section.slot[data-role="outfit"]')).toContainText(
      'Chưa chọn ảnh.'
    )
    await expect(page.getByLabel('Pose', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Biểu cảm', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('Mô tả nhân vật')).toHaveValue(
      'Nam, ngoài 50 tuổi, tóc bạc hai bên'
    )

    await expect
      .poll(async () => (await workspace.readDraft())?.state.source.anchor, { timeout: 10_000 })
      .toBe('nguyen-van-a')
  })
})

async function fillSubject(studio: Studio, name: string, description: string): Promise<void> {
  await studio.page.getByLabel('Tên nhân vật').fill(name)
  await studio.page.getByLabel('Mô tả nhân vật').fill(description)
}
