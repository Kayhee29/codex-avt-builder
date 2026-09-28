import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  CodexResolveError,
  isUsableExecutable,
  minimalCodexEnv,
  packageCandidates,
  pathCandidates,
  resolveCodexExecutable
} from '../../src/main/codex-resolver.ts'
import { createTempDir } from '../helpers/tmp-workspace.ts'

/** The file name the npm package ships for Windows x64 (spec section 5.3). */
const WINDOWS_BINARY = 'codex-x86_64-pc-windows-msvc.exe'

let temp: { path: string; remove(): Promise<void> }

/** Nothing here may reach PATH or npm, so every probe is given explicitly. */
const NO_NPM = async (): Promise<readonly string[]> => []

beforeEach(async () => {
  temp = await createTempDir()
})

afterEach(async () => {
  await temp.remove()
})

async function writeExecutable(path: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'not really a binary', 'utf8')

  if (process.platform !== 'win32') {
    await chmod(path, 0o755)
  }

  return path
}

/** `<prefix>/node_modules/@openai/codex/bin/<name>`, the layout on Windows. */
async function writeNpmGlobalPackage(prefix: string, name = WINDOWS_BINARY): Promise<string> {
  return writeExecutable(join(prefix, 'node_modules', '@openai', 'codex', 'bin', name))
}

describe('resolveCodexExecutable: npm global package', () => {
  it('finds the real binary inside the npm-global @openai/codex package', async () => {
    const prefix = join(temp.path, 'npm')
    const binary = await writeNpmGlobalPackage(prefix)

    const launcher = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: {},
      npmPrefixes: async () => [prefix]
    })

    expect(launcher).toEqual({ command: binary, prefixArgs: [], source: 'npm-global' })
  })

  it('finds the binary under lib/node_modules, the layout npm uses on POSIX', async () => {
    const prefix = join(temp.path, 'usr-local')
    const binary = await writeExecutable(
      join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex-x86_64-apple-darwin')
    )

    const launcher = await resolveCodexExecutable({
      platform: 'darwin',
      arch: 'x64',
      env: {},
      npmPrefixes: async () => [prefix]
    })

    expect(launcher).toEqual({ command: binary, prefixArgs: [], source: 'npm-global' })
  })

  it('finds the binary in a per-platform optional dependency package', async () => {
    const prefix = join(temp.path, 'npm')
    const binary = await writeExecutable(
      join(prefix, 'node_modules', '@openai', 'codex-win32-x64', 'bin', 'codex.exe')
    )

    const launcher = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: {},
      npmPrefixes: async () => [prefix]
    })

    expect(launcher.command).toBe(binary)
    expect(launcher.source).toBe('npm-global')
  })

  it('prefers the npm package over a real codex.exe on PATH', async () => {
    const prefix = join(temp.path, 'npm')
    const packaged = await writeNpmGlobalPackage(prefix)
    const onPath = join(temp.path, 'bin')

    await writeExecutable(join(onPath, 'codex.exe'))

    const launcher = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: onPath },
      npmPrefixes: async () => [prefix]
    })

    expect(launcher.command).toBe(packaged)
    expect(launcher.source).toBe('npm-global')
  })
})

describe('resolveCodexExecutable: PATH', () => {
  it('accepts a real codex.exe on PATH when there is no npm package', async () => {
    const directory = join(temp.path, 'bin')
    const binary = await writeExecutable(join(directory, 'codex.exe'))

    const launcher = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: directory },
      npmPrefixes: NO_NPM
    })

    expect(launcher).toEqual({ command: binary, prefixArgs: [], source: 'path' })
  })

  it('refuses the npm shims and reports CODEX_NOT_FOUND (the reason this task exists)', async () => {
    const directory = join(temp.path, 'bin')

    // Exactly what `npm install -g @openai/codex` leaves on a Windows PATH.
    await writeExecutable(join(directory, 'codex.cmd'))
    await writeExecutable(join(directory, 'codex.ps1'))
    await writeExecutable(join(directory, 'codex.bat'))
    await writeExecutable(join(directory, 'codex'))

    const error = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: directory },
      npmPrefixes: NO_NPM
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CodexResolveError)
    expect((error as CodexResolveError).code).toBe('CODEX_NOT_FOUND')
    expect((error as CodexResolveError).attempts).toContain(join(directory, 'codex.exe'))
    expect((error as CodexResolveError).attempts).not.toContain(join(directory, 'codex.cmd'))
  })

  it('probes every PATH entry in order and records what it tried', async () => {
    const first = join(temp.path, 'a')
    const second = join(temp.path, 'b')
    const binary = await writeExecutable(join(second, 'codex.exe'))

    await mkdir(first, { recursive: true })

    const launcher = await resolveCodexExecutable({
      platform: 'win32',
      arch: 'x64',
      env: { PATH: [first, second].join(delimiter) },
      npmPrefixes: NO_NPM
    })

    expect(launcher.command).toBe(binary)
  })
})

describe('resolveCodexExecutable: settings override', () => {
  it('uses the configured executable and reports source "settings"', async () => {
    const binary = await writeExecutable(join(temp.path, 'custom', WINDOWS_BINARY))

    const launcher = await resolveCodexExecutable({
      codexExecutable: binary,
      platform: 'win32',
      arch: 'x64',
      env: {},
      npmPrefixes: NO_NPM
    })

    expect(launcher).toEqual({ command: binary, prefixArgs: [], source: 'settings' })
  })

  it('fails with CODEX_NOT_FOUND naming the path when the file does not exist', async () => {
    const missing = join(temp.path, 'nowhere', WINDOWS_BINARY)

    const error = await resolveCodexExecutable({
      codexExecutable: missing,
      platform: 'win32',
      arch: 'x64',
      env: {},
      npmPrefixes: NO_NPM
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CodexResolveError)
    expect((error as CodexResolveError).code).toBe('CODEX_NOT_FOUND')
    expect((error as CodexResolveError).message).toContain(missing)
    expect((error as CodexResolveError).message).toContain('does not exist')
  })

  it('refuses a configured .cmd shim even though the file exists', async () => {
    const shim = await writeExecutable(join(temp.path, 'custom', 'codex.cmd'))

    const error = await resolveCodexExecutable({
      codexExecutable: shim,
      platform: 'win32',
      arch: 'x64',
      env: {},
      npmPrefixes: NO_NPM
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(CodexResolveError)
    expect((error as CodexResolveError).message).toContain('shim')
  })

  it('never falls back to another executable when the override is broken', async () => {
    const prefix = join(temp.path, 'npm')

    await writeNpmGlobalPackage(prefix)

    await expect(
      resolveCodexExecutable({
        codexExecutable: join(temp.path, 'nowhere.exe'),
        platform: 'win32',
        arch: 'x64',
        env: {},
        npmPrefixes: async () => [prefix]
      })
    ).rejects.toBeInstanceOf(CodexResolveError)
  })

  it('treats a blank override as no override', async () => {
    const directory = join(temp.path, 'bin')
    const binary = await writeExecutable(join(directory, 'codex.exe'))

    const launcher = await resolveCodexExecutable({
      codexExecutable: '   ',
      platform: 'win32',
      arch: 'x64',
      env: { PATH: directory },
      npmPrefixes: NO_NPM
    })

    expect(launcher.command).toBe(binary)
  })
})

describe('isUsableExecutable', () => {
  it('refuses .cmd, .bat and .ps1 on Windows', async () => {
    for (const name of ['codex.cmd', 'codex.bat', 'codex.ps1', 'codex']) {
      const path = await writeExecutable(join(temp.path, 'shims', name))

      expect(await isUsableExecutable(path, 'win32')).toBe(false)
    }
  })

  it('accepts a regular .exe on Windows', async () => {
    const path = await writeExecutable(join(temp.path, 'ok', WINDOWS_BINARY))

    expect(await isUsableExecutable(path, 'win32')).toBe(true)
  })

  it('refuses a directory that happens to be named like the binary', async () => {
    const path = join(temp.path, 'dir', WINDOWS_BINARY)

    await mkdir(path, { recursive: true })

    expect(await isUsableExecutable(path, 'win32')).toBe(false)
  })

  it.skipIf(process.platform === 'win32')(
    'requires an execute bit on macOS and Linux',
    async () => {
      const path = join(temp.path, 'posix', 'codex')

      await mkdir(join(temp.path, 'posix'), { recursive: true })
      await writeFile(path, '#!/bin/sh\n', 'utf8')
      await chmod(path, 0o644)

      expect(await isUsableExecutable(path, 'linux')).toBe(false)

      await chmod(path, 0o755)

      expect(await isUsableExecutable(path, 'linux')).toBe(true)
    }
  )
})

describe('pathCandidates', () => {
  it('only ever looks for codex.exe on Windows', () => {
    const candidates = pathCandidates(
      { PATH: [join('C:', 'a'), join('C:', 'b')].join(delimiter) },
      'win32'
    )

    expect(candidates).toEqual([join('C:', 'a', 'codex.exe'), join('C:', 'b', 'codex.exe')])
  })

  it('drops relative and empty PATH entries', () => {
    const candidates = pathCandidates(
      { PATH: ['', '.', 'relative', '/usr/bin'].join(delimiter) },
      'linux'
    )

    expect(candidates).toEqual([join('/usr/bin', 'codex')])
  })

  it('reads a lowercase Path, which is how Windows spells it', () => {
    expect(pathCandidates({ Path: join('C:', 'a') }, 'win32')).toEqual([
      join('C:', 'a', 'codex.exe')
    ])
  })
})

describe('packageCandidates', () => {
  it('probes the triple-named binary before the plain one', () => {
    const candidates = packageCandidates([join('C:', 'npm')], 'win32', 'x64')

    expect(candidates[0]).toBe(
      join('C:', 'npm', 'node_modules', '@openai', 'codex', 'bin', WINDOWS_BINARY)
    )
    expect(candidates).toContain(
      join('C:', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.exe')
    )
  })

  it('covers the per-platform package as well as the main one', () => {
    const candidates = packageCandidates(['/usr/local'], 'linux', 'x64')

    expect(candidates).toContain(
      join('/usr/local', 'lib', 'node_modules', '@openai', 'codex-linux-x64', 'bin', 'codex')
    )
  })
})

describe('minimalCodexEnv', () => {
  it('never passes OPENAI_API_KEY or any other secret to the child', () => {
    const env = minimalCodexEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/someone',
        CODEX_HOME: '/home/someone/.codex',
        OPENAI_API_KEY: 'sk-should-never-be-forwarded',
        ANTHROPIC_API_KEY: 'should-never-be-forwarded',
        AWS_SECRET_ACCESS_KEY: 'should-never-be-forwarded'
      },
      'linux'
    )

    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      CODEX_HOME: '/home/someone/.codex'
    })
  })

  it('keeps the Windows variables a process needs to start at all', () => {
    const env = minimalCodexEnv(
      {
        PATH: 'C:\\Windows',
        SYSTEMROOT: 'C:\\Windows',
        USERPROFILE: 'C:\\Users\\someone',
        OPENAI_API_KEY: 'sk-should-never-be-forwarded'
      },
      'win32'
    )

    expect(env['SYSTEMROOT']).toBe('C:\\Windows')
    expect(env['USERPROFILE']).toBe('C:\\Users\\someone')
    expect(env['OPENAI_API_KEY']).toBeUndefined()
  })
})
