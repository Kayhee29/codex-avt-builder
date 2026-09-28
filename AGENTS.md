# AGENTS.md

Instructions for coding agents working **in this repository**.

This is not the file Codex receives when a job runs. That one is
`instructions/run-job.md`, which is materialized into each job directory as
`run-instructions.md`. Do not confuse the two.

## What this project is

Reference Image Studio is a local, single-user Electron desktop app. The user
assembles a reference-first image job in a builder UI; when they press
**Generate**, the main process materializes an immutable job directory and runs
the locally installed **Codex CLI** (`codex exec`) against it. Codex generates
the images with its built-in `image_gen` tool.

The project never calls OpenAI or any image API itself. There is no HTTP
backend, no API route, no model SDK and no API key anywhere in the repo. If
Codex or its image capability is unavailable, the job fails with a clear error
code — there is no fallback.

## Authoritative documents

Read these before changing anything. Section numbers in code comments and commit
messages refer to them.

| Document                                                                     | Role                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| `docs/superpowers/specs/2026-09-28-reference-image-studio-design.md`         | the spec: behavior, contracts, security boundaries    |
| `docs/superpowers/plans/2026-09-28-reference-image-studio-implementation.md` | the plan: 7 phases of numbered tasks, one commit each |

Both are authored Vietnamese documents. Do not reformat them and do not edit
them as a side effect of a code task; prettier is configured to skip `docs/`.
Spec changes are their own task (plan Task 6.4 back-ports the Q1–Q13 decisions).

## Repository layout

```text
src/main/        Electron main process: workspace, job materializer, Codex runner, IPC
src/preload/     contextBridge allowlist; the only surface the renderer can reach
src/renderer/    React 19 UI; no Node, no filesystem, no child process
src/shared/      pure TypeScript shared by main and renderer (schemas, prompt builder)
schemas/         JSON Schema generated from src/shared/schemas.ts
instructions/    run-job.md, the template Codex receives per job
tests/unit/      vitest, no I/O outside a tmp dir
tests/integration/ vitest against a tmp workspace and the fake Codex
tests/fake-codex/  scriptable stand-in for the Codex executable
e2e/             Playwright driving the built Electron app
workspace/       local runtime data: drafts, presets, anchors, jobs
docs/            spec and plan
```

Directories appear as the plan's tasks create them; several are still empty.

## Commands

| Command                             | What it does                                                   |
| ----------------------------------- | -------------------------------------------------------------- |
| `pnpm install`                      | install dependencies (pnpm only)                               |
| `pnpm dev`                          | run the app with electron-vite                                 |
| `pnpm build`                        | build main, preload and renderer into `out/`                   |
| `pnpm typecheck`                    | `tsc --noEmit` over the node project and the web project       |
| `pnpm lint`                         | eslint                                                         |
| `pnpm format` / `pnpm format:check` | prettier                                                       |
| `pnpm test`                         | vitest, unit and integration                                   |
| `pnpm test:e2e`                     | build, then Playwright against the built Electron app          |
| `pnpm export-schemas`               | regenerate `schemas/*.json` from `src/shared/schemas.ts` (zod) |
| `pnpm package`                      | build, then a portable Windows exe in `dist/`                  |
| `pnpm package:dir`                  | the same, unpacked into `dist/win-unpacked/` (faster)          |

Before any commit: `pnpm typecheck`, `pnpm lint` and `pnpm test` must pass.

## Rules

### Automated tests never invoke the real Codex CLI

This is the one rule with no exceptions. Unit, integration and e2e tests must
never spawn the installed `codex` binary, never consume a generation and never
depend on the user being logged in.

Tests drive the runner through the injected launcher (plan decision Q8):

```ts
// production
{ command: '<resolved codex executable>', prefixArgs: [] }
// tests
{ command: process.execPath, prefixArgs: ['tests/fake-codex/fake-codex.mjs'] }
```

`tests/fake-codex/fake-codex.mjs` replays recorded JSONL fixtures and is
scripted through the `FAKE_CODEX_SCENARIO` environment variable. If you need
behavior the fake does not have, extend the fake and add a fixture — do not
reach for the real CLI.

The only place real Codex appears is the manual, opt-in smoke test in plan
Task 6.4, run by a human.

### Security invariants (spec section 11)

Do not relax any of these to make something work:

- `BrowserWindow` keeps `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true`.
- `will-navigate` is blocked and `setWindowOpenHandler` returns `deny`.
- The preload exposes only the allowlisted IPC commands from
  `src/shared/ipc-contract.ts`. Never expose raw `ipcRenderer`.
- The renderer never sends a path, executable, working directory, shell
  argument or raw command over IPC. It sends opaque `referenceId` handles; the
  main process owns the registry that maps them to absolute paths.
- Codex is spawned with `spawn`, an argument array and `shell: false`. Never
  `shell: true`, never `--full-auto`, never
  `--dangerously-bypass-approvals-and-sandbox`, never
  `--sandbox danger-full-access`, never sandbox network access.
- No user text reaches the command line. Only a job ID validated against the
  regex in spec section 6.1 does.
- Paths are normalized and path traversal is refused; symlinks are not accepted
  as job inputs or as outputs.

### Contracts

- `job.json` is written once and never modified. It holds no run state.
- The main process always writes `result.json`, including when Codex never ran.
  Codex never writes `result.json`, and the UI never reads `codex-result.json`.
- A zero exit code alone is never success. Verification is spec section 7.3.
- `src/shared/schemas.ts` (zod) is the source of truth; `schemas/*.json` is
  generated by `pnpm export-schemas` and a test fails if the two drift.

### Style

- Code, identifiers, comments, log messages, error codes and commit messages are
  in **English**.
- User-facing UI strings are in **Vietnamese**, collected in
  `src/renderer/i18n/vi.ts`. Do not scatter display strings through components.
- TypeScript is strict, including `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. Do not add `any` or `@ts-expect-error` to get
  past them.
- Prefer pure functions in `src/shared/` so they can be unit tested without
  Electron.

### Working the plan

- Do one numbered task per commit, using the commit message the plan gives.
- Do not implement ahead of the current task. Later tasks depend on files not
  existing yet.
- Write the tests the task lists before the implementation.
- Never commit anything under `workspace/jobs/` or `workspace/drafts/`, or any
  generated image. `.gitignore` covers this; preset and anchor JSON stay
  trackable on purpose.

## Status

Phase 0 of the plan is done: the app scaffold, this file, `README.md` and
`instructions/run-job.md`. Phase 1 (`src/shared/`: reference roles, zod schemas,
job ID, prompt builder, preset merge, IPC contract) is next.
