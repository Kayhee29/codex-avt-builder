/**
 * Recording the run-state sequence from inside the window (plan Task 6.2).
 *
 * A run passes through `queued`, `preflight`, `running`, `verifying` and a
 * terminal state (spec sections 5.5 and 12) in a few hundred milliseconds, so
 * polling from the outside would only ever catch two or three of them. A
 * `MutationObserver` installed before Generate is pressed sees every render
 * instead, and reads `data-state` on the run panel — the value the main process
 * set, rather than the Vietnamese word it is displayed as.
 *
 * The scripts are strings on purpose. This suite is type-checked by
 * `tsconfig.node.json`, which has no DOM lib, and a string body keeps the
 * browser globals out of a project that must not know about them; the whole
 * point of `src/renderer/` being its own project is that nothing else has a
 * `document`.
 */
import type { Page } from '@playwright/test'

/** Where the recorded states are kept inside the window. */
const STATES_GLOBAL = '__studioRunStates'

const INSTALL_RECORDER = `(() => {
  window.${STATES_GLOBAL} = [];
  const record = () => {
    const panel = document.querySelector('section.run');
    const state = panel === null ? null : panel.getAttribute('data-state');
    const seen = window.${STATES_GLOBAL};
    if (state !== null && state !== '' && seen[seen.length - 1] !== state) {
      seen.push(state);
    }
  };
  record();
  new MutationObserver(record).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-state']
  });
})()`

/** Starts recording. Call it before the click that starts a run. */
export async function installRunStateRecorder(page: Page): Promise<void> {
  await page.evaluate(INSTALL_RECORDER)
}

/** Every distinct run state the panel showed, in the order it showed them. */
export async function recordedRunStates(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`window.${STATES_GLOBAL} ?? []`)
}
