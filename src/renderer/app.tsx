/**
 * The application component (plan Task 5.1).
 *
 * It wires the stores to the layout and does the three things that have to
 * happen once, when the window opens: load the saved draft, read the recent
 * jobs list and subscribe to `jobs.onProgress`. The subscription's unsubscribe
 * function is the effect's cleanup, so nothing is left listening.
 *
 * The bootstrap that mounts this into `index.html` lives in `main.tsx`, which
 * keeps this module importable by a test without a `#root` element.
 */
import { useEffect, type JSX } from 'react'

import { builderStatusText, vi } from './i18n/vi.ts'
import { Layout } from './components/Layout.tsx'
import { selectBuilderStatus, useBuilderStore } from './store/builder.ts'
import { useJobsStore } from './store/jobs.ts'
import './styles/app.css'

export function App(): JSX.Element {
  const status = useBuilderStore(selectBuilderStatus)
  const loadDraft = useBuilderStore((store) => store.loadDraft)
  const refreshJobs = useJobsStore((store) => store.refresh)
  const subscribeToProgress = useJobsStore((store) => store.subscribeToProgress)

  useEffect(() => {
    void loadDraft()
  }, [loadDraft])

  useEffect(() => {
    void refreshJobs()
  }, [refreshJobs])

  useEffect(() => subscribeToProgress(), [subscribeToProgress])

  return (
    <Layout
      status={builderStatusText(status)}
      characterDirection={<Placeholder />}
      referenceSlots={<Placeholder />}
      promptPreview={<Placeholder />}
    />
  )
}

/** Stands in for the panels plan Tasks 5.2 and 5.3 put in the three columns. */
function Placeholder(): JSX.Element {
  return <p className="column__reserved">{vi.layout.reserved}</p>
}
