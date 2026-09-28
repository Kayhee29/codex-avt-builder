/**
 * Interrupted-job recovery (plan Task 3.7 and decision Q13, spec sections 7.4
 * and 12).
 *
 * A job directory with a `job.json` and no `result.json` means the app died
 * while that job was running: a crash, a power cut, or the window being closed
 * on a live process. Spec section 12 says such a job shows as `failed` with
 * `INTERRUPTED`, and spec section 7 says the main process is the only thing
 * that ever writes `result.json` — so rather than letting `jobs.list` invent
 * that state for every reader, the state is written down once, at startup,
 * where it belongs.
 *
 * Nothing else is touched. Spec section 10 forbids deleting a job directory or
 * its logs after a failure, so `events.jsonl`, `stderr.log` and any image Codex
 * managed to produce stay exactly where they are; only the missing result file
 * is added.
 *
 * Node built-ins are allowed here; Electron is not imported at all.
 */
import { listJobIds, readJobPacket } from './jobs.ts'
import { buildResult, readResultJson, writeResultJson } from './result-verifier.ts'
import { jobDir, workspaceLayout, type WorkspaceLayout } from './workspace.ts'

/** The message spec section 7.4's `INTERRUPTED` gets in `result.json`. */
export const INTERRUPTED_MESSAGE =
  'This job was still running when the app closed, so it never finished. Duplicate it to try again.'

export interface RecoverOptions {
  /** The workspace root, or the layout {@link workspaceLayout} built from it. */
  readonly workspace: string | WorkspaceLayout
  /** Injected so tests get predictable timestamps. */
  readonly now?: () => Date
  /**
   * Jobs to leave alone.
   *
   * At app startup nothing is running, which is the only moment plan decision
   * Q13 calls for. The predicate exists so a later caller — a diagnostic, or a
   * second window — cannot mark a live run as interrupted underneath itself.
   */
  readonly isRunning?: (jobId: string) => boolean
}

/**
 * Marks every unfinished job `failed` / `INTERRUPTED` and returns their IDs.
 *
 * Runs when the app is ready. A job that already has a `result.json` is left
 * untouched, so this is safe to call more than once.
 */
export async function recoverInterruptedJobs(options: RecoverOptions): Promise<string[]> {
  const layout =
    typeof options.workspace === 'string' ? workspaceLayout(options.workspace) : options.workspace
  const now = options.now ?? (() => new Date())
  const isRunning = options.isRunning ?? (() => false)
  const recovered: string[] = []

  for (const jobId of await listJobIds(layout)) {
    if (isRunning(jobId)) {
      continue
    }

    const directory = jobDir(layout.root, jobId)
    const packet = await readJobPacket(directory)

    if (packet === null) {
      // No readable `job.json`: not a job this app created, or one whose
      // materialization never finished. Either way there is nothing to report
      // a result for, and nothing here deletes it (spec section 10).
      continue
    }

    if ((await readResultJson(directory)) !== null) {
      continue
    }

    await writeResultJson(
      directory,
      buildResult({
        jobId: packet.jobId,
        status: 'failed',
        // The job started when it was created; nothing recorded a later time,
        // and inventing one would be worse than using the one fact on disk.
        startedAt: packet.createdAt,
        completedAt: now().toISOString(),
        // Spec section 7.2: whatever Codex did is unknown, so none of this is
        // claimed. The logs in the job directory are the record of the run.
        executor: { codexVersion: null, executable: null, exitCode: null, signal: null },
        error: { code: 'INTERRUPTED', message: INTERRUPTED_MESSAGE }
      })
    )

    recovered.push(packet.jobId)
  }

  return recovered
}
