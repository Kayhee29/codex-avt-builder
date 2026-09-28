/**
 * A throwaway workspace on disk for the main-process tests.
 *
 * Tests never touch the repository's own `workspace/`: every one of them gets
 * its own directory under the OS temp directory and removes it afterwards.
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureWorkspaceLayout, type WorkspaceLayout } from '../../src/main/workspace.ts'

const PREFIX = 'reference-image-studio-'

export interface TempWorkspace extends WorkspaceLayout {
  /** The temp directory holding the workspace, for files outside the root. */
  readonly base: string
  remove(): Promise<void>
}

/** Creates `<tmp>/<random>/workspace` with the four directories of spec section 9. */
export async function createTempWorkspace(): Promise<TempWorkspace> {
  const base = await mkdtemp(join(tmpdir(), PREFIX))
  const layout = await ensureWorkspaceLayout(join(base, 'workspace'))

  return {
    ...layout,
    base,
    remove: async () => {
      await rm(base, { recursive: true, force: true })
    }
  }
}

/** A bare temp directory, for source images that live outside the workspace. */
export async function createTempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), PREFIX))

  return {
    path,
    remove: async () => {
      await rm(path, { recursive: true, force: true })
    }
  }
}

/** Which kind of link this machine let the test create, if any. */
export type LinkKind = 'symlink' | 'junction' | 'none'

/**
 * Links `linkPath` to the directory `target`.
 *
 * Creating a symlink on Windows normally needs elevation or developer mode, so
 * this falls back to a directory junction, which needs neither and which
 * `realpath` resolves the same way. `'none'` means the OS refused both and the
 * caller should skip the test rather than pretend it passed.
 */
export async function linkDirectory(target: string, linkPath: string): Promise<LinkKind> {
  try {
    await symlink(target, linkPath, 'dir')

    return 'symlink'
  } catch {
    try {
      await symlink(target, linkPath, 'junction')

      return 'junction'
    } catch {
      return 'none'
    }
  }
}

/** Links `linkPath` to the file `target`, or reports that the OS refused. */
export async function linkFile(target: string, linkPath: string): Promise<LinkKind> {
  try {
    await symlink(target, linkPath, 'file')

    return 'symlink'
  } catch {
    return 'none'
  }
}
