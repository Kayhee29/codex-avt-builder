/**
 * The anchor panel (plan Task 5.4, spec section 4.5).
 *
 * An anchor pins the continuity of one character: its identity image, the
 * stable description and the immutable traits. Saving writes a **new version**
 * and never overwrites one, which is why saving offers a target — a new anchor,
 * or the next version of one that already exists — instead of a plain "save".
 * Main picks the version number (`nextAnchorVersion`), so the renderer never
 * names one.
 *
 * Loading builds a whole new draft with `newDraftFromAnchor` and replaces the
 * current one, so it asks first whenever the builder holds anything. Merge
 * order is spec section 4.4's: the preset the draft names, then the anchor,
 * then whatever the user types next.
 *
 * Spec sections 4.5 and 14.5: outfit, equipment, pose and expression stay
 * mutable and are left for the user to fill in. `newDraftFromAnchor` is what
 * guarantees that — the anchor contributes no value for any of them — and
 * `tests/unit/renderer/preset-panel.test.tsx` checks it through this panel.
 *
 * The identity image travels as the handle main sent with the entry (plan
 * decisions Q17 and Q18); the renderer holds opaque handles and never a path.
 */
import { useState, type ChangeEvent, type JSX } from 'react'

import { newDraftFromAnchor } from '@shared/anchor'
import type { AnchorEntry, AnchorInput, JobSummary } from '@shared/ipc-contract'

import { ipcErrorText, vi } from '../i18n/vi.ts'
import { selectHasContent, selectReference, useBuilderStore } from '../store/builder.ts'
import { useJobsStore } from '../store/jobs.ts'
import { selectPresetEntry, useLibraryStore } from '../store/library.ts'

import { ApplyPreviewDialog } from './ApplyPreviewDialog.tsx'

/** The separator of the `<jobId>#<outputIndex>` value of the output select. */
const APPROVED_OUTPUT_SEPARATOR = '#'

/** One line per trait, blanks dropped, the same rule the form uses elsewhere. */
export function parseTraits(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function AnchorPanel(): JSX.Element {
  const anchors = useLibraryStore((store) => store.anchors)
  const writeErrorCode = useLibraryStore((store) => store.writeErrorCode)
  const saving = useLibraryStore((store) => store.saving)
  const saveAnchor = useLibraryStore((store) => store.saveAnchor)

  const state = useBuilderStore((store) => store.state)
  const hasContent = useBuilderStore(selectHasContent)
  const adoptState = useBuilderStore((store) => store.adoptState)
  const flushAutosave = useBuilderStore((store) => store.flushAutosave)
  const identity = useBuilderStore((store) => selectReference(store, 'identity'))

  const jobs = useJobsStore((store) => store.jobs)

  const [name, setName] = useState('')
  const [targetId, setTargetId] = useState('')
  const [immutableText, setImmutableText] = useState('')
  const [mutableText, setMutableText] = useState('')
  const [approved, setApproved] = useState('')
  const [pending, setPending] = useState<AnchorEntry | null>(null)

  const outputs = approvedOutputOptions(jobs)
  const anchorName = name.trim() === '' ? state.subject.name.trim() : name.trim()

  /** Replaces the draft with one built from `entry` (spec section 4.4). */
  function loadAnchor(entry: AnchorEntry): void {
    const preset = selectPresetEntry(useLibraryStore.getState(), state.source.preset)

    adoptState(
      newDraftFromAnchor(preset?.preset ?? null, entry.anchor, {
        identityReference: entry.identityReference,
        styleReference: preset?.styleReference ?? null
      })
    )
    // `adoptState` reports the new state as already saved, so the draft on disk
    // has to be brought level with it right away.
    void flushAutosave()
    setPending(null)
  }

  return (
    <div className="library">
      {writeErrorCode === null ? null : (
        <p className="library__error" role="alert">
          {vi.library.saveFailed} {ipcErrorText(writeErrorCode)}
        </p>
      )}

      {anchors.length === 0 ? (
        <p className="library__empty">{vi.library.anchorsEmpty}</p>
      ) : (
        <ul className="library__list">
          {anchors.map((entry) => (
            <li className="library__row" key={`${entry.anchor.id}-${String(entry.anchor.version)}`}>
              <span className="library__name">
                {entry.anchor.name} (v{entry.anchor.version})
              </span>
              <span className="library__actions">
                <button
                  type="button"
                  onClick={(): void => {
                    if (hasContent) {
                      setPending(entry)
                    } else {
                      loadAnchor(entry)
                    }
                  }}
                >
                  {vi.library.loadAnchor}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="field">
        <label className="field__label" htmlFor="anchor-name">
          {vi.library.anchorName}
        </label>
        <input
          id="anchor-name"
          type="text"
          value={name}
          placeholder={state.subject.name === '' ? vi.library.anchorNamePlaceholder : ''}
          onChange={(event: ChangeEvent<HTMLInputElement>): void => {
            setName(event.target.value)
          }}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="anchor-target">
          {vi.library.anchorTarget}
        </label>
        <select
          id="anchor-target"
          value={targetId}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            setTargetId(event.target.value)
          }}
        >
          <option value="">{vi.library.anchorNew}</option>
          {latestPerAnchor(anchors).map((entry) => (
            <option key={entry.anchor.id} value={entry.anchor.id}>
              {entry.anchor.name} (v{entry.anchor.version + 1})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="anchor-immutable">
          {vi.library.immutableTraits}
        </label>
        <textarea
          id="anchor-immutable"
          rows={2}
          value={immutableText}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
            setImmutableText(event.target.value)
          }}
        />
        <span className="field__hint">{vi.library.traitsHint}</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="anchor-mutable">
          {vi.library.mutableTraits}
        </label>
        <textarea
          id="anchor-mutable"
          rows={2}
          value={mutableText}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>): void => {
            setMutableText(event.target.value)
          }}
        />
        <span className="field__hint">{vi.library.mutableHint}</span>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="anchor-approved">
          {vi.library.approvedOutput}
        </label>
        <select
          id="anchor-approved"
          value={approved}
          onChange={(event: ChangeEvent<HTMLSelectElement>): void => {
            setApproved(event.target.value)
          }}
        >
          <option value="">{vi.library.approvedOutputNone}</option>
          {outputs.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {identity === null ? <p className="library__hint">{vi.library.needIdentity}</p> : null}

      <button
        type="button"
        disabled={saving || identity === null || anchorName === ''}
        onClick={(): void => {
          if (identity === null || anchorName === '') {
            return
          }

          void saveAnchor(
            anchorInput({
              id: targetId === '' ? null : targetId,
              name: anchorName,
              identityReferenceId: identity.referenceId,
              identityDescription: state.subject.description,
              immutableTraits: parseTraits(immutableText),
              mutableTraits: parseTraits(mutableText),
              approved
            })
          )
        }}
      >
        {vi.library.saveAnchor}
      </button>

      {pending === null ? null : (
        <ApplyPreviewDialog
          title={vi.library.loadAnchorTitle}
          message={`${pending.anchor.name} (v${String(pending.anchor.version)}) — ${
            vi.library.loadAnchorMessage
          }`}
          confirmLabel={vi.library.loadAnchorConfirm}
          onConfirm={(): void => {
            loadAnchor(pending)
          }}
          onCancel={(): void => {
            setPending(null)
          }}
        />
      )}
    </div>
  )
}

/** One option per output of every finished job (spec section 4.5). */
export function approvedOutputOptions(
  jobs: readonly JobSummary[]
): { value: string; label: string }[] {
  return jobs
    .filter((job) => job.state === 'succeeded' && job.outputCount > 0)
    .flatMap((job) =>
      Array.from({ length: job.outputCount }, (_unused, index) => ({
        value: `${job.jobId}${APPROVED_OUTPUT_SEPARATOR}${String(index)}`,
        label: `${job.jobId} — ${vi.library.approvedOutputOption} ${String(index + 1)}`
      }))
    )
}

/** The newest stored version of each anchor, for the "save into" select. */
export function latestPerAnchor(entries: readonly AnchorEntry[]): AnchorEntry[] {
  const seen = new Set<string>()

  return entries.filter((entry) => {
    // `sortAnchorEntries` puts the highest version of each anchor first.
    if (seen.has(entry.anchor.id)) {
      return false
    }

    seen.add(entry.anchor.id)

    return true
  })
}

/**
 * The request `library.saveAnchor` takes.
 *
 * The approved output is named by its job and its index in that job's
 * `result.json`, never by a file name, so no path crosses IPC (plan Task 1.6).
 */
function anchorInput(fields: {
  id: string | null
  name: string
  identityReferenceId: string
  identityDescription: string
  immutableTraits: string[]
  mutableTraits: string[]
  approved: string
}): AnchorInput {
  const output = parseApprovedOutput(fields.approved)

  return {
    id: fields.id,
    name: fields.name,
    identityReferenceId: fields.identityReferenceId,
    approvedOutput: output,
    identityDescription: fields.identityDescription,
    immutableTraits: fields.immutableTraits,
    mutableTraits: fields.mutableTraits,
    sourceJobId: output?.jobId ?? null
  }
}

/** `<jobId>#<index>` back into the pair, or `null` for "no approved output". */
export function parseApprovedOutput(value: string): { jobId: string; outputIndex: number } | null {
  const separator = value.lastIndexOf(APPROVED_OUTPUT_SEPARATOR)

  if (separator === -1) {
    return null
  }

  const index = Number.parseInt(value.slice(separator + 1), 10)

  return Number.isNaN(index) ? null : { jobId: value.slice(0, separator), outputIndex: index }
}
