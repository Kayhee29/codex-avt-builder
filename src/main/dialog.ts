/**
 * The reference file picker (plan Task 2.3, spec section 4.2).
 *
 * `dialog.selectReference(role)` is the only way a file from outside the
 * workspace enters the app, and it is the user who chooses it (spec section
 * 11). What comes back is a `BuilderReference`: an opaque id plus metadata, and
 * no path.
 *
 * The Electron dialog arrives as an injected function, so the tests drive this
 * module without a window. {@link electronShowOpenDialog} loads Electron lazily
 * and is what the IPC layer of plan Task 4.2 passes in.
 */
import type { ReferenceRole } from '../shared/reference-roles.ts'
import type { BuilderReference } from '../shared/schemas.ts'

import type { ReferenceRegistry } from './reference-registry.ts'

/** The formats of spec section 4.2, as file dialog filters. */
export const IMAGE_FILE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const

/**
 * The three strings the OS dialog shows. Vietnamese, per plan decision Q10.
 * `src/renderer/i18n/vi.ts` collects the renderer's strings from plan Task 5.1
 * on; these belong to the main process, so they live here and can be replaced
 * through {@link SelectReferenceOptions}.
 */
export const REFERENCE_DIALOG_TEXT = {
  title: 'Chọn ảnh tham chiếu',
  buttonLabel: 'Chọn ảnh',
  filterName: 'Ảnh PNG, JPEG, WebP'
} as const

/** The subset of `Electron.OpenDialogOptions` this module sets. */
export interface OpenDialogRequest {
  readonly title: string
  readonly buttonLabel: string
  readonly properties: readonly ['openFile']
  readonly filters: readonly { readonly name: string; readonly extensions: readonly string[] }[]
}

/** What `dialog.showOpenDialog` answers. */
export interface OpenDialogAnswer {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

export type ShowOpenDialog = (request: OpenDialogRequest) => Promise<OpenDialogAnswer>

export interface SelectReferenceOptions {
  readonly registry: ReferenceRegistry
  readonly showOpenDialog: ShowOpenDialog
  /** Overrides the dialog strings; defaults to {@link REFERENCE_DIALOG_TEXT}. */
  readonly text?: typeof REFERENCE_DIALOG_TEXT
  /** Passed through to the image inspector; defaults to the 20 MB of spec 4.2. */
  readonly maxBytes?: number
}

/**
 * Opens the picker for one slot and returns the handle for the chosen file, or
 * `null` when the user cancelled.
 *
 * The dialog is single-select: a role holds at most one reference (spec section
 * 4.2). An unsupported or unreadable file throws `ImageInspectError`, which the
 * IPC layer turns into a sanitized error envelope; nothing is registered in
 * that case, so a refused file leaves no id behind.
 */
export async function selectReference(
  role: ReferenceRole,
  options: SelectReferenceOptions
): Promise<BuilderReference | null> {
  const text = options.text ?? REFERENCE_DIALOG_TEXT
  const answer = await options.showOpenDialog({
    title: text.title,
    buttonLabel: text.buttonLabel,
    properties: ['openFile'],
    filters: [{ name: text.filterName, extensions: IMAGE_FILE_EXTENSIONS }]
  })

  const [absPath] = answer.filePaths

  if (answer.canceled || absPath === undefined) {
    return null
  }

  return options.registry.createReference(absPath, {
    role,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes })
  })
}

/**
 * The production dialog. Electron is imported lazily so importing this module
 * in a plain Node test does not pull in the browser runtime.
 */
export async function electronShowOpenDialog(
  request: OpenDialogRequest
): Promise<OpenDialogAnswer> {
  const { dialog } = await import('electron')

  return dialog.showOpenDialog({
    title: request.title,
    buttonLabel: request.buttonLabel,
    properties: ['openFile'],
    filters: request.filters.map((filter) => ({
      name: filter.name,
      extensions: [...filter.extensions]
    }))
  })
}
