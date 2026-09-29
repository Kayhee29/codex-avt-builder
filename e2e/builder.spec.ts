/**
 * The builder, end to end (plan Task 6.2, spec section 13).
 *
 * Acceptance criteria 14.1, 14.2, 14.3 and 14.6: the user has a desktop UI for
 * creative direction, every role can be chosen, previewed, replaced and removed
 * on its own, the prompt preview updates before anything runs, and none of it
 * starts Codex.
 *
 * "On its own" is the claim worth proving here, so the replace test compares
 * the four other slots byte for byte around the replacement rather than
 * spot-checking one field.
 */
import { REFERENCE_ROLES } from '../src/shared/reference-roles.ts'

import { expect, test, type Studio } from './fixtures.ts'
import { ROLE_FIXTURES, type FixtureRole } from './helpers/workspace.ts'

/** The Vietnamese heading of each slot, from `src/renderer/i18n/vi.ts`. */
const ROLE_NAMES: Record<FixtureRole, string> = {
  style: 'Phong cách',
  identity: 'Nhận diện',
  outfit: 'Trang phục',
  equipment: 'Trang bị',
  extra: 'Bổ sung'
}

test.describe('builder', () => {
  test('fills five independent slots and leaves four alone when one is replaced', async ({
    studio
  }) => {
    const { page, workspace } = studio

    await expect(studio.region('Ảnh tham chiếu')).toBeVisible()

    for (const role of REFERENCE_ROLES) {
      await workspace.offerImage(role)
      await slot(studio, role).getByRole('button', { name: 'Chọn ảnh' }).click()
      await expect(slot(studio, role)).toContainText(`${role}-source.`)
    }

    // Each fixture has its own dimensions, so a slot holding the wrong file
    // cannot pass this (tests/fixtures/images/README.md).
    for (const role of REFERENCE_ROLES) {
      const { width, height } = ROLE_FIXTURES[role]

      await expect(slot(studio, role)).toContainText(`${String(width)} × ${String(height)}`)
    }

    // The prompt preview is a pure function of the state and needs no Codex
    // (spec sections 4.3 and 5.1): all five labels are there before Generate.
    const preview = studio.region('Xem trước prompt')

    for (const label of ['Image A', 'Image B', 'Image C', 'Image D', 'Image E']) {
      await expect(preview).toContainText(label)
    }

    const untouched = ['style', 'identity', 'equipment', 'extra'] as const
    const before = await Promise.all(untouched.map(async (role) => metadata(studio, role)))

    await workspace.offerImage('outfit', 'outfit-replacement.webp')
    await slot(studio, 'outfit').getByRole('button', { name: 'Thay ảnh' }).click()
    await expect(slot(studio, 'outfit')).toContainText('outfit-replacement.webp')

    // Spec section 14.2: replacing one role changes nothing about the others.
    expect(await Promise.all(untouched.map(async (role) => metadata(studio, role)))).toEqual(before)

    // Removing one slot is just as local.
    await slot(studio, 'extra').getByRole('button', { name: 'Gỡ ảnh' }).click()
    await expect(slot(studio, 'extra')).toContainText('Chưa chọn ảnh.')
    expect(await metadata(studio, 'style')).toEqual(before[0])

    await page.getByLabel('Tên nhân vật').fill('Nguyễn Văn A')
    await page.getByLabel('Mô tả nhân vật').fill('Nam, ngoài 50 tuổi')

    // Spec section 4.6: the draft is autosaved, with the paths main resolved
    // for the four handles that are left (plan decision Q3).
    await expect
      .poll(async () => Object.keys((await workspace.readDraft())?.referencePaths ?? {}).length, {
        timeout: 10_000
      })
      .toBe(4)

    const draft = await workspace.readDraft()

    expect(draft?.state.subject.name).toBe('Nguyễn Văn A')
    expect(draft?.state.references.map((reference) => reference.role).sort()).toEqual([
      'equipment',
      'identity',
      'outfit',
      'style'
    ])
    // Spec section 14.6: nothing in the builder ran Codex, so no job exists.
    expect(await workspace.listJobIds()).toEqual([])
  })

  test('saves a half-typed draft and keeps Generate off (plan decision Q22)', async ({
    studio
  }) => {
    const { page, workspace } = studio

    await page.getByLabel('Tên nhân vật').fill('Ngu')

    // A name and nothing else: valid against `DraftStateSchema`, invalid
    // against `BuilderStateSchema`, and the app must store it rather than
    // throw the work away when the window closes.
    await expect
      .poll(async () => (await workspace.readDraft())?.state.subject.name, { timeout: 10_000 })
      .toBe('Ngu')

    expect((await workspace.readDraft())?.state.subject.description).toBe('')
    await expect(generateButton(studio)).toBeDisabled()
    // The hint names the one field that is empty rather than saying something
    // required is missing: with the rest of the form on dropdowns, these two are
    // the only fields that can be.
    await expect(studio.region('Tạo ảnh').first()).toContainText(
      'Chưa tạo ảnh được, còn thiếu: Mô tả nhân vật.'
    )

    await page.getByLabel('Mô tả nhân vật').fill('Nam, ngoài 50 tuổi')
    await expect(generateButton(studio)).toBeEnabled()
  })
})

function slot(studio: Studio, role: string) {
  return studio.page.locator(`section.slot[data-role="${role}"]`)
}

/** The whole metadata block of one slot: file name, source path and size. */
async function metadata(studio: Studio, role: FixtureRole): Promise<string> {
  const heading = await slot(studio, role).locator('.slot__name').innerText()

  expect(heading).toBe(ROLE_NAMES[role])

  return slot(studio, role).locator('.slot__meta').innerText()
}

function generateButton(studio: Studio) {
  return studio.page.locator('.generate > button')
}
