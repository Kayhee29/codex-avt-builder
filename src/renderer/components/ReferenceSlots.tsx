/**
 * The five reference slots (plan Task 5.3, spec section 4.2).
 *
 * Exactly five, in the fixed order of `REFERENCE_ROLES`, each one independent.
 * This component adds only what is about the set rather than about one slot:
 * the warning that a reference file has disappeared, which also blocks Generate
 * (`selectCanGenerate`), and the error from a picker that could not be opened.
 */
import type { JSX } from 'react'

import { REFERENCE_ROLES } from '@shared/reference-roles'

import { ipcErrorText, referenceRoleName, vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'

import { ReferenceSlot } from './ReferenceSlot.tsx'

export function ReferenceSlots(): JSX.Element {
  // The reference array itself is subscribed to, not `selectMissingRoles`:
  // zustand compares snapshots by identity, and a selector that builds a fresh
  // array every call re-renders forever. The array only changes when a slot
  // does, so this is also the narrower subscription.
  const references = useBuilderStore((store) => store.state.references)
  const pickErrorCode = useBuilderStore((store) => store.pickErrorCode)
  const missingRoles = references
    .filter((reference) => reference.missing)
    .map((reference) => reference.role)

  return (
    <div className="slots">
      {missingRoles.length === 0 ? null : (
        <p className="slots__warning" role="alert">
          {vi.reference.missingBlocksGenerate} (
          {missingRoles.map((role) => referenceRoleName(role)).join(', ')})
        </p>
      )}

      {pickErrorCode === null ? null : (
        <p className="slots__warning" role="alert">
          {vi.reference.pickFailed} {ipcErrorText(pickErrorCode)}
        </p>
      )}

      {REFERENCE_ROLES.map((role) => (
        <ReferenceSlot key={role} role={role} />
      ))}
    </div>
  )
}
