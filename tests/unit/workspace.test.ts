import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ensureWorkspaceLayout,
  isInsideRoot,
  jobDir,
  resolveWorkspaceRoot,
  safeJoin,
  safeJoinLexical,
  UnsafePathError,
  WORKSPACE_DIRECTORIES,
  WORKSPACE_ENV_VAR,
  workspaceLayout,
  type WorkspaceHost
} from '../../src/main/workspace.ts'
import {
  createTempWorkspace,
  linkDirectory,
  linkFile,
  type TempWorkspace
} from '../helpers/tmp-workspace.ts'

function host(overrides: Partial<WorkspaceHost> = {}): WorkspaceHost {
  return {
    isPackaged: false,
    getPath: () => join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'studio'),
    getAppPath: () => join('C:', 'projects', 'reference-image-studio'),
    ...overrides
  }
}

describe('resolveWorkspaceRoot', () => {
  it('keeps the workspace in the project while developing (plan Task 6.5)', () => {
    expect(resolveWorkspaceRoot(host(), {})).toBe(
      resolve(join('C:', 'projects', 'reference-image-studio', 'workspace'))
    )
  })

  it('moves it into user data once the app is packaged', () => {
    expect(resolveWorkspaceRoot(host({ isPackaged: true }), {})).toBe(
      resolve(join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'studio', 'workspace'))
    )
  })

  it('lets the harness of plan Task 6.1 override the root', () => {
    const root = resolveWorkspaceRoot(host({ isPackaged: true }), {
      [WORKSPACE_ENV_VAR]: join('C:', 'tmp', 'ws')
    })

    expect(root).toBe(resolve(join('C:', 'tmp', 'ws')))
  })

  it('ignores an empty override', () => {
    expect(resolveWorkspaceRoot(host(), { [WORKSPACE_ENV_VAR]: '   ' })).toBe(
      resolve(join('C:', 'projects', 'reference-image-studio', 'workspace'))
    )
  })
})

describe('ensureWorkspaceLayout', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace()
  })

  afterEach(async () => {
    await workspace.remove()
  })

  it('creates drafts, presets, anchors and jobs (spec section 9)', async () => {
    const layout = await ensureWorkspaceLayout(workspace.root)

    for (const name of WORKSPACE_DIRECTORIES) {
      await expect(safeJoin(layout.root, name)).resolves.toBe(join(layout.root, name))
    }
  })

  it('is safe to run again on an existing workspace', async () => {
    await writeFile(join(workspace.drafts, 'current.json'), '{}', 'utf8')
    await ensureWorkspaceLayout(workspace.root)

    await expect(safeJoin(workspace.root, 'drafts', 'current.json')).resolves.toBe(
      join(workspace.drafts, 'current.json')
    )
  })

  it('reports the same paths as workspaceLayout', () => {
    expect(workspaceLayout(workspace.root)).toEqual({
      root: workspace.root,
      drafts: join(workspace.root, 'drafts'),
      presets: join(workspace.root, 'presets'),
      anchors: join(workspace.root, 'anchors'),
      jobs: join(workspace.root, 'jobs')
    })
  })
})

describe('jobDir', () => {
  const root = resolve(join('C:', 'tmp', 'ws'))

  it('builds the directory of a valid job ID', () => {
    expect(jobDir(root, '2026-09-28-richard-nixon-001')).toBe(
      join(root, 'jobs', '2026-09-28-richard-nixon-001')
    )
  })

  // Spec section 6.1: an ID that fails the regex never becomes a directory.
  it.each(['../etc', 'nixon', '2026-09-28-Richard-001', '2026-09-28-nixon-001/../x', ''])(
    'refuses %j',
    (jobId) => {
      expect(() => jobDir(root, jobId)).toThrow(UnsafePathError)
    }
  )
})

describe('safeJoin', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace()
  })

  afterEach(async () => {
    await workspace.remove()
  })

  it('joins ordinary parts', async () => {
    await expect(
      safeJoin(workspace.root, 'jobs', '2026-09-28-nixon-001', 'job.json')
    ).resolves.toBe(join(workspace.root, 'jobs', '2026-09-28-nixon-001', 'job.json'))
  })

  it('names a file that does not exist yet', async () => {
    await expect(
      safeJoin(workspace.root, 'jobs', 'not-created-yet', 'inputs', 'style.png')
    ).resolves.toBe(join(workspace.root, 'jobs', 'not-created-yet', 'inputs', 'style.png'))
  })

  it('refuses a traversal part', async () => {
    await expect(safeJoin(workspace.root, '..', 'x')).rejects.toThrow(UnsafePathError)
    await expect(safeJoin(workspace.root, 'jobs', '..', '..', 'x')).rejects.toThrow(UnsafePathError)
  })

  it('refuses an absolute part', async () => {
    await expect(safeJoin(workspace.root, join('C:', 'x'))).rejects.toThrow(UnsafePathError)
    await expect(safeJoin(workspace.root, '/etc/passwd')).rejects.toThrow(UnsafePathError)
  })

  it('refuses a part carrying a separator, so nothing hides inside one', async () => {
    await expect(safeJoin(workspace.root, 'jobs/../..')).rejects.toThrow(UnsafePathError)
    await expect(safeJoin(workspace.root, 'jobs\\..\\..')).rejects.toThrow(UnsafePathError)
  })

  it('refuses an empty part and a bare dot', async () => {
    await expect(safeJoin(workspace.root, '')).rejects.toThrow(UnsafePathError)
    await expect(safeJoin(workspace.root, '.')).rejects.toThrow(UnsafePathError)
  })

  it('refuses the root itself, since safeJoin always descends', async () => {
    await expect(safeJoin(workspace.root)).rejects.toThrow(UnsafePathError)
  })

  it('reports why it refused', async () => {
    await expect(safeJoin(workspace.root, '..')).rejects.toMatchObject({ reason: 'traversal' })
    await expect(safeJoin(workspace.root, join('C:', 'x'))).rejects.toMatchObject({
      reason: 'absolute-part'
    })
  })

  it('is not fooled by a sibling directory sharing the root prefix', () => {
    expect(isInsideRoot(workspace.root, `${workspace.root}-other`)).toBe(false)
    expect(isInsideRoot(workspace.root, join(workspace.root, 'jobs'))).toBe(true)
    expect(isInsideRoot(workspace.root, workspace.root)).toBe(false)
  })

  it('accepts a root that is itself reached through a link', async (context) => {
    const linkPath = join(workspace.base, 'linked-workspace')
    const kind = await linkDirectory(workspace.root, linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating directory links')

      return
    }

    await expect(safeJoin(linkPath, 'jobs')).resolves.toBe(join(linkPath, 'jobs'))
  })

  // Spec section 11: a path is refused once it leaves the workspace, whether it
  // spells `..` or hides the escape behind a link.
  it('refuses a directory link pointing out of the workspace', async (context) => {
    const outside = join(workspace.base, 'outside')

    await mkdir(outside, { recursive: true })

    const linkPath = join(workspace.jobs, 'escape')
    const kind = await linkDirectory(outside, linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating directory links')

      return
    }

    await expect(safeJoin(workspace.root, 'jobs', 'escape')).rejects.toMatchObject({
      reason: 'escapes-root'
    })
    await expect(safeJoin(workspace.root, 'jobs', 'escape', 'job.json')).rejects.toMatchObject({
      reason: 'escapes-root'
    })
  })

  it('refuses a file link pointing out of the workspace', async (context) => {
    const secret = join(workspace.base, 'secret.txt')

    await writeFile(secret, 'not for Codex', 'utf8')

    const linkPath = join(workspace.drafts, 'current.json')
    const kind = await linkFile(secret, linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating file symlinks without elevation')

      return
    }

    await expect(safeJoin(workspace.root, 'drafts', 'current.json')).rejects.toMatchObject({
      reason: 'escapes-root'
    })
  })

  it('accepts a link that stays inside the workspace', async (context) => {
    const linkPath = join(workspace.jobs, 'shortcut')
    const kind = await linkDirectory(workspace.presets, linkPath)

    if (kind === 'none') {
      context.skip('this machine does not allow creating directory links')

      return
    }

    await expect(safeJoin(workspace.root, 'jobs', 'shortcut')).resolves.toBe(linkPath)
  })
})

describe('safeJoinLexical', () => {
  const root = resolve(join('C:', 'tmp', 'ws'))

  it('makes the same checks without touching the filesystem', () => {
    expect(safeJoinLexical(root, 'jobs', 'x')).toBe(`${root}${sep}jobs${sep}x`)
    expect(() => safeJoinLexical(root, '..')).toThrow(UnsafePathError)
    expect(() => safeJoinLexical(root, join('C:', 'x'))).toThrow(UnsafePathError)
  })
})
