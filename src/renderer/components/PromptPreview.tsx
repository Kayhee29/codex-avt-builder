/**
 * The live prompt preview (plan Task 5.2, spec sections 4.3 and 5.1).
 *
 * The prompt and the mapping table stand side by side, and both come from the
 * store's `prompt`, which is `buildPrompt` run in the renderer. The UI builder
 * is the source of truth for the prompt (spec section 4.3) and exactly one
 * module assembles it, so what is shown here is byte for byte what the
 * materializer will write into `prompt.md`.
 *
 * Nothing here runs Codex and nothing here sends an IPC command (spec section
 * 5.1). The checksum under the prompt is the one `jobs.generate` sends along,
 * which is also how a user can see that the preview and the job agree.
 */
import type { JSX } from 'react'

import { vi } from '../i18n/vi.ts'
import { useBuilderStore } from '../store/builder.ts'

import { ReferenceMapping } from './ReferenceMapping.tsx'

export function PromptPreview(): JSX.Element {
  const prompt = useBuilderStore((store) => store.prompt)
  const promptFailed = useBuilderStore((store) => store.promptFailed)
  const promptSha256 = useBuilderStore((store) => store.promptSha256)

  return (
    <div className="preview">
      <p className="preview__note">{vi.preview.noCodex}</p>

      {promptFailed ? <p className="preview__error">{vi.preview.failed}</p> : null}

      <div className="preview__panes">
        <pre className="preview__markdown" aria-label={vi.preview.heading}>
          {prompt?.markdown ?? ''}
        </pre>
        <ReferenceMapping rows={prompt?.mapping ?? []} />
      </div>

      <p className="preview__checksum">
        {vi.preview.checksum}: {promptSha256 ?? vi.preview.checksumPending}
      </p>
    </div>
  )
}
