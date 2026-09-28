/**
 * The builder shell (plan Task 5.1).
 *
 * Three columns — character direction, reference slots, prompt preview — over a
 * bottom bar that holds preset, anchor, recent jobs and Generate. Plan Tasks
 * 5.4 and 5.5 fill the bottom bar; until then each of its four regions renders
 * a placeholder so the space is reserved and the layout does not move when the
 * real panels arrive.
 *
 * This component holds no state and reads no store. Everything it shows is a
 * node someone else built, which is what makes the layout testable on its own
 * and keeps the seams for the later tasks obvious.
 */
import type { JSX, ReactNode } from 'react'

import { vi } from '../i18n/vi.ts'

export interface LayoutProps {
  /** Preflight banner and other top-of-window messages (plan Task 5.5). */
  readonly banner?: ReactNode
  /** The builder status of spec section 12, shown in the header. */
  readonly status?: ReactNode
  readonly characterDirection: ReactNode
  readonly referenceSlots: ReactNode
  readonly promptPreview: ReactNode
  /** Plan Task 5.4. */
  readonly presetPanel?: ReactNode
  /** Plan Task 5.4. */
  readonly anchorPanel?: ReactNode
  /** Plan Task 5.5. */
  readonly recentJobs?: ReactNode
  /** Plan Task 5.5. */
  readonly generateBar?: ReactNode
}

export function Layout({
  banner,
  status,
  characterDirection,
  referenceSlots,
  promptPreview,
  presetPanel,
  anchorPanel,
  recentJobs,
  generateBar
}: LayoutProps): JSX.Element {
  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">{vi.app.title}</h1>
          <p className="app__subtitle">{vi.app.subtitle}</p>
        </div>
        {status === undefined ? null : <div className="app__status">{status}</div>}
      </header>

      {banner === undefined ? null : <div className="app__banner">{banner}</div>}

      <div className="app__columns">
        <Column title={vi.layout.characterDirection}>{characterDirection}</Column>
        <Column title={vi.layout.referenceSlots}>{referenceSlots}</Column>
        <Column title={vi.layout.promptPreview}>{promptPreview}</Column>
      </div>

      <footer className="app__bottom">
        <BottomRegion title={vi.layout.presets}>{presetPanel}</BottomRegion>
        <BottomRegion title={vi.layout.anchors}>{anchorPanel}</BottomRegion>
        <BottomRegion title={vi.layout.recentJobs}>{recentJobs}</BottomRegion>
        <BottomRegion title={vi.layout.generate}>{generateBar}</BottomRegion>
      </footer>
    </div>
  )
}

function Column({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="column" aria-label={title}>
      <h2 className="column__title">{title}</h2>
      <div className="column__body">{children}</div>
    </section>
  )
}

/** One slot of the bottom bar, with the placeholder a later task replaces. */
function BottomRegion({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <section className="bottom-region" aria-label={title}>
      <h2 className="bottom-region__title">{title}</h2>
      {children === undefined ? (
        <p className="bottom-region__reserved">{vi.layout.reserved}</p>
      ) : (
        children
      )}
    </section>
  )
}
