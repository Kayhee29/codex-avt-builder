/**
 * The library store: presets and anchor versions (plan Task 5.4, spec sections
 * 4.4 and 4.5).
 *
 * Plan decision Q9 named a store for the builder and a store for the jobs list,
 * written when those were the only two domains the renderer had. The library is
 * the third, and it gets its own store for the same reasons: two panels read
 * the same two lists — the anchor panel needs the presets too, because a new
 * draft merges preset defaults under anchor defaults (spec section 4.4) — and
 * both lists change when either panel writes.
 *
 * Q9's actual rule is kept: there is no application-wide `loading` boolean
 * (spec section 12). `refreshing` and `saving` belong to this list and to
 * nothing else.
 *
 * The entries carry the handle for the stored image beside the metadata (plan
 * decision Q18), which is the only way the renderer can put a preset's style
 * image or an anchor's identity image into a slot: it holds opaque handles and
 * never a path (spec section 11, plan decision Q3).
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'

import type {
  AnchorEntry,
  AnchorInput,
  IpcErrorCode,
  IpcResult,
  PresetEntry,
  PresetInput
} from '@shared/ipc-contract'

import { bridge } from '../bridge.ts'

export interface LibraryStore {
  /** Every stored preset, by id (spec section 4.4). */
  readonly presets: readonly PresetEntry[]
  /** Every stored anchor **version**, newest version of each anchor first. */
  readonly anchors: readonly AnchorEntry[]
  readonly refreshing: boolean
  readonly saving: boolean
  readonly listErrorCode: IpcErrorCode | null
  readonly writeErrorCode: IpcErrorCode | null

  /** Re-reads both lists. */
  refresh: () => Promise<void>
  /** Saves a preset and re-reads the lists. Answers whether it was stored. */
  savePreset: (preset: PresetInput) => Promise<boolean>
  deletePreset: (id: string) => Promise<boolean>
  /** Saves a new anchor version; main picks the number (spec section 4.5). */
  saveAnchor: (anchor: AnchorInput) => Promise<boolean>
  reset: () => void
}

interface LibraryData {
  presets: readonly PresetEntry[]
  anchors: readonly AnchorEntry[]
  refreshing: boolean
  saving: boolean
  listErrorCode: IpcErrorCode | null
  writeErrorCode: IpcErrorCode | null
}

function initialData(): LibraryData {
  return {
    presets: [],
    anchors: [],
    refreshing: false,
    saving: false,
    listErrorCode: null,
    writeErrorCode: null
  }
}

export function createLibraryStore(): UseBoundStore<StoreApi<LibraryStore>> {
  return create<LibraryStore>((set, get) => {
    /**
     * Runs one write, then re-reads the lists.
     *
     * Every write changes what the two panels show — a saved anchor adds a
     * version, a deleted preset removes a row — so re-reading is part of the
     * action rather than something each caller has to remember.
     */
    async function write(run: () => Promise<IpcResult<unknown>>): Promise<boolean> {
      set({ saving: true, writeErrorCode: null })

      const answer = await run()

      if (!answer.ok) {
        set({ saving: false, writeErrorCode: answer.code })

        return false
      }

      set({ saving: false, writeErrorCode: null })
      await get().refresh()

      return true
    }

    return {
      ...initialData(),

      refresh: async (): Promise<void> => {
        set({ refreshing: true })

        const [presets, anchors] = await Promise.all([
          bridge()['library.listPresets'](),
          bridge()['library.listAnchors']()
        ])

        if (!presets.ok || !anchors.ok) {
          set({
            refreshing: false,
            listErrorCode: presets.ok ? (anchors.ok ? null : anchors.code) : presets.code
          })

          return
        }

        set({
          refreshing: false,
          listErrorCode: null,
          presets: presets.data.presets,
          anchors: sortAnchorEntries(anchors.data.anchors)
        })
      },

      savePreset: async (preset: PresetInput): Promise<boolean> =>
        write(async () => bridge()['library.savePreset']({ preset })),

      deletePreset: async (id: string): Promise<boolean> =>
        write(async () => bridge()['library.deletePreset']({ id })),

      saveAnchor: async (anchor: AnchorInput): Promise<boolean> =>
        write(async () => bridge()['library.saveAnchor']({ anchor })),

      reset: (): void => {
        set(initialData())
      }
    }
  })
}

/** The store the app uses. Tests call `reset()` between cases. */
export const useLibraryStore = createLibraryStore()

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Anchor versions grouped by anchor, newest version first inside each anchor.
 *
 * Spec section 4.5 keeps every version rather than overwriting one, so the
 * panel lists them all and the newest is simply the first row of its group.
 */
export function sortAnchorEntries(entries: readonly AnchorEntry[]): AnchorEntry[] {
  return [...entries].sort(
    (left, right) =>
      left.anchor.id.localeCompare(right.anchor.id) || right.anchor.version - left.anchor.version
  )
}

/** The preset a state names in `source.preset`, or `null` (spec section 4.4). */
export function selectPresetEntry(store: LibraryStore, id: string | null): PresetEntry | null {
  return id === null ? null : (store.presets.find((entry) => entry.preset.id === id) ?? null)
}
