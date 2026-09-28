/**
 * The builder store (plan Task 5.1 and decision Q9, spec sections 4.1, 4.2,
 * 4.6 and 12).
 *
 * It owns the `BuilderState` the user is editing, the five slots of spec
 * section 4.2, and the debounced draft autosave of spec section 4.6. It is the
 * only place in the renderer that sends `draft.save`.
 *
 * Status, spec section 12: there is no application-wide `loading` boolean. The
 * store keeps four independent facts — `pristine`, `dirty`, `saving` and
 * `valid` (from `BuilderStateSchema.safeParse`) — and `selectBuilderStatus`
 * folds them into the one word the UI shows. The precedence is documented on
 * that function.
 *
 * Security, spec section 11 and plan decision Q3: a `BuilderReference` is an
 * opaque handle. The store never holds a path, and `toBuilderStateInput` builds
 * every outgoing request field by field so `displayPath` and `thumbnail` cannot
 * travel back to the main process by accident.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'

import type { BuilderReferenceInput, BuilderStateInput, IpcErrorCode } from '@shared/ipc-contract'
import type { ReferenceRole } from '@shared/reference-roles'
import {
  BuilderStateSchema,
  type BuilderReference,
  type BuilderState,
  type OutputRequest
} from '@shared/schemas'
import { createEmptyBuilderState } from '@shared/anchor'

import { bridge } from '../bridge.ts'

/** Spec section 4.6 asks for an autosave; plan Task 5.1 fixes the delay. */
export const AUTOSAVE_DEBOUNCE_MS = 800

/** The five builder statuses of spec section 12. */
export type BuilderStatus = 'clean' | 'dirty' | 'saving' | 'ready' | 'invalid'

/** The character-direction fields of spec section 4.1 that hold free text. */
export type SubjectTextField = 'name' | 'description' | 'pose' | 'expression' | 'notes'

export interface BuilderStore {
  /** The state a job would be generated from. */
  readonly state: BuilderState
  /**
   * The negative-constraints textarea exactly as typed, one constraint per
   * line. `state.negativeConstraints` is the parsed form, with blank lines
   * dropped; keeping the raw text here is what lets the user type a blank line
   * in the middle of the list without the field rewriting itself.
   *
   * Renderer-only presentation state: it never crosses IPC.
   */
  readonly negativeConstraintsText: string
  /** `BuilderStateSchema.safeParse(state).success`, recomputed on every edit. */
  readonly valid: boolean
  /** Nothing has been edited since the store was created or a draft loaded. */
  readonly pristine: boolean
  /** There are edits that the autosave has not yet stored. */
  readonly dirty: boolean
  /** A `draft.save` is in flight. */
  readonly saving: boolean
  /** `savedAt` of the last successful save or load, as ISO 8601. */
  readonly savedAt: string | null
  readonly loadErrorCode: IpcErrorCode | null
  readonly saveErrorCode: IpcErrorCode | null
  readonly pickErrorCode: IpcErrorCode | null

  /** Reads `workspace/drafts/current.json` and adopts it (spec section 4.6). */
  loadDraft: () => Promise<void>
  /** Replaces the whole state, e.g. after applying a preset (plan Task 5.4). */
  adoptState: (state: BuilderState, savedAt?: string | null) => void
  setSubjectField: (field: SubjectTextField, value: string) => void
  setOutput: <K extends keyof OutputRequest>(field: K, value: OutputRequest[K]) => void
  setNegativeConstraintsText: (text: string) => void
  /** Opens the picker for one role and puts what comes back into that slot. */
  pickReference: (role: ReferenceRole) => Promise<void>
  /** Puts a handle into its own slot, leaving every other slot untouched. */
  putReference: (reference: BuilderReference) => void
  removeReference: (role: ReferenceRole) => void
  setReferenceNote: (role: ReferenceRole, note: string) => void
  /** Saves now instead of waiting out the debounce. */
  flushAutosave: () => Promise<void>
  /** Back to a fresh, empty builder. Cancels a pending autosave. */
  reset: () => void
}

/**
 * Strips a reference down to what the renderer is allowed to send back.
 *
 * Written out field by field rather than with a rest spread: a field added to
 * `BuilderReferenceSchema` then fails to compile here instead of being
 * forwarded silently, which is the behaviour spec section 11 wants from the
 * one function that builds outgoing reference payloads.
 */
function toReferenceInput(reference: BuilderReference): BuilderReferenceInput {
  return {
    referenceId: reference.referenceId,
    role: reference.role,
    originalName: reference.originalName,
    mimeType: reference.mimeType,
    sizeBytes: reference.sizeBytes,
    width: reference.width,
    height: reference.height,
    sha256: reference.sha256,
    missing: reference.missing,
    ...(reference.note === undefined ? {} : { note: reference.note })
  }
}

/** A builder state as `draft.save` and `jobs.generate` accept it. */
export function toBuilderStateInput(state: BuilderState): BuilderStateInput {
  return { ...state, references: state.references.map(toReferenceInput) }
}

/** The textarea's lines as the schema wants them: trimmed, no blanks. */
export function parseNegativeConstraints(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** The array back as textarea content, for a draft loaded from disk. */
export function formatNegativeConstraints(constraints: readonly string[]): string {
  return constraints.join('\n')
}

interface BuilderData {
  state: BuilderState
  negativeConstraintsText: string
  valid: boolean
  pristine: boolean
  dirty: boolean
  saving: boolean
  savedAt: string | null
  loadErrorCode: IpcErrorCode | null
  saveErrorCode: IpcErrorCode | null
  pickErrorCode: IpcErrorCode | null
}

function initialData(): BuilderData {
  const state = createEmptyBuilderState()

  return {
    state,
    negativeConstraintsText: '',
    // The empty state is deliberately invalid: no subject name, no description
    // (see `createEmptyBuilderState`). Spec section 12 calls that `invalid`.
    valid: BuilderStateSchema.safeParse(state).success,
    pristine: true,
    dirty: false,
    saving: false,
    savedAt: null,
    loadErrorCode: null,
    saveErrorCode: null,
    pickErrorCode: null
  }
}

/**
 * Builds a builder store.
 *
 * The autosave timer lives in this closure rather than at module scope, so a
 * test can hold an isolated store and `reset()` really does cancel everything
 * that was pending.
 */
export function createBuilderStore(): UseBoundStore<StoreApi<BuilderStore>> {
  let timer: ReturnType<typeof setTimeout> | null = null

  return create<BuilderStore>((set, get) => {
    function cancelScheduledSave(): void {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    function scheduleSave(): void {
      cancelScheduledSave()
      timer = setTimeout(() => {
        timer = null
        void save()
      }, AUTOSAVE_DEBOUNCE_MS)
    }

    /**
     * One `draft.save`.
     *
     * An invalid state is not sent: `draft.save` takes a `BuilderState`, and
     * `SubjectSchema` requires a name and a description, so a half-typed
     * subject would only earn an `INVALID_REQUEST`. The edits stay `dirty`
     * until the state becomes valid, and the next edit schedules another save.
     */
    async function save(): Promise<void> {
      if (get().saving) {
        // A save is already in flight; try again after the next window rather
        // than racing it with a second write of the same file.
        scheduleSave()

        return
      }

      const snapshot = get().state

      if (!get().valid) {
        return
      }

      set({ saving: true, saveErrorCode: null })

      const answer = await bridge()['draft.save']({ state: toBuilderStateInput(snapshot) })

      if (!answer.ok) {
        set({ saving: false, saveErrorCode: answer.code })

        return
      }

      const savedAt = answer.data.savedAt

      set((previous) => ({
        saving: false,
        savedAt,
        saveErrorCode: null,
        // Edits made while the save was in flight are still unsaved.
        dirty: previous.state !== snapshot
      }))
    }

    /** Records a user edit and restarts the autosave window. */
    function edit(state: BuilderState, text?: string): void {
      set({
        state,
        valid: BuilderStateSchema.safeParse(state).success,
        pristine: false,
        dirty: true,
        ...(text === undefined ? {} : { negativeConstraintsText: text })
      })
      scheduleSave()
    }

    function editSubject(field: SubjectTextField, value: string): void {
      edit({ ...get().state, subject: { ...get().state.subject, [field]: value } })
    }

    function editReferences(references: readonly BuilderReference[]): void {
      edit({ ...get().state, references: [...references] })
    }

    return {
      ...initialData(),

      loadDraft: async (): Promise<void> => {
        const answer = await bridge()['draft.load']()

        if (!answer.ok) {
          set({ loadErrorCode: answer.code })

          return
        }

        set({ loadErrorCode: null })

        const draft = answer.data.draft

        if (draft !== null) {
          get().adoptState(draft.state, draft.savedAt)
        }
      },

      adoptState: (state: BuilderState, savedAt: string | null = null): void => {
        cancelScheduledSave()
        set({
          state,
          negativeConstraintsText: formatNegativeConstraints(state.negativeConstraints),
          valid: BuilderStateSchema.safeParse(state).success,
          pristine: true,
          dirty: false,
          saving: false,
          savedAt,
          saveErrorCode: null
        })
      },

      setSubjectField: (field: SubjectTextField, value: string): void => {
        editSubject(field, value)
      },

      setOutput: <K extends keyof OutputRequest>(field: K, value: OutputRequest[K]): void => {
        edit({ ...get().state, output: { ...get().state.output, [field]: value } })
      },

      setNegativeConstraintsText: (text: string): void => {
        edit({ ...get().state, negativeConstraints: parseNegativeConstraints(text) }, text)
      },

      pickReference: async (role: ReferenceRole): Promise<void> => {
        const answer = await bridge()['dialog.selectReference']({ role })

        if (!answer.ok) {
          set({ pickErrorCode: answer.code })

          return
        }

        set({ pickErrorCode: null })

        const reference = answer.data.reference

        // `null` is the user closing the picker without choosing a file.
        if (reference !== null) {
          get().putReference(reference)
        }
      },

      putReference: (reference: BuilderReference): void => {
        const current = get().state.references
        const existing = current.find((candidate) => candidate.role === reference.role)
        // The note is direction for the slot, not for the file, so replacing
        // the image keeps it (spec section 4.2 lists replace and remove as
        // different operations; only remove clears the slot).
        const note = reference.note ?? existing?.note
        const placed = note === undefined || note === '' ? reference : { ...reference, note }

        editReferences(
          existing === undefined
            ? [...current, placed]
            : current.map((candidate) => (candidate.role === reference.role ? placed : candidate))
        )
      },

      removeReference: (role: ReferenceRole): void => {
        const current = get().state.references

        if (!current.some((reference) => reference.role === role)) {
          return
        }

        editReferences(current.filter((reference) => reference.role !== role))
      },

      setReferenceNote: (role: ReferenceRole, note: string): void => {
        const current = get().state.references

        if (!current.some((reference) => reference.role === role)) {
          return
        }

        editReferences(
          current.map((reference) => (reference.role === role ? { ...reference, note } : reference))
        )
      },

      flushAutosave: async (): Promise<void> => {
        cancelScheduledSave()
        await save()
      },

      reset: (): void => {
        cancelScheduledSave()
        set(initialData())
      }
    }
  })
}

/** The store the app uses. Tests call `reset()` between cases. */
export const useBuilderStore = createBuilderStore()

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * The one status word the UI shows, from the four independent facts the store
 * keeps (spec section 12).
 *
 * Precedence, highest first:
 *
 * 1. `saving` — a write is in flight, and that is what the user should see.
 * 2. `clean` — nothing has been edited yet. This outranks `invalid` so that a
 *    brand new builder reads "chưa có thay đổi" rather than accusing the user
 *    of bad data before they have typed anything.
 * 3. `invalid` — the state does not satisfy `BuilderStateSchema`.
 * 4. `dirty` — valid, with edits the autosave has not stored yet.
 * 5. `ready` — valid and saved.
 */
export function selectBuilderStatus(store: BuilderStore): BuilderStatus {
  if (store.saving) {
    return 'saving'
  }

  if (store.pristine) {
    return 'clean'
  }

  if (!store.valid) {
    return 'invalid'
  }

  return store.dirty ? 'dirty' : 'ready'
}

/** The reference in one slot, or `null` when the slot is empty. */
export function selectReference(store: BuilderStore, role: ReferenceRole): BuilderReference | null {
  return store.state.references.find((reference) => reference.role === role) ?? null
}

/** The roles whose file has disappeared since it was chosen (spec 4.2). */
export function selectMissingRoles(store: BuilderStore): ReferenceRole[] {
  return store.state.references
    .filter((reference) => reference.missing)
    .map((reference) => reference.role)
}

/**
 * Whether the builder itself allows a job to start.
 *
 * Validity plus "no reference has gone missing": generating with a missing
 * file would only fail in the materializer with `MISSING_REFERENCE`
 * (spec sections 5.2 and 7.4), so the UI refuses it first.
 *
 * This deliberately does not require `selectBuilderStatus(store) === 'ready'`.
 * A valid state is generatable the moment it is valid; making the user wait
 * out the 800 ms autosave window would be an artefact of the save, not of the
 * job. The generate bar of plan Task 5.5 combines this with "no run is
 * currently active", which is the jobs store's business.
 */
export function selectCanGenerate(store: BuilderStore): boolean {
  return store.valid && selectMissingRoles(store).length === 0
}
