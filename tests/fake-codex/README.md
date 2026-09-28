# Fake Codex

`fake-codex.mjs` stands in for the Codex CLI in every automated test.

Automated tests never start the real `codex`: they must not consume a
generation, must not depend on the user being signed in and must pass on a
machine where Codex is not installed at all (spec section 13, `AGENTS.md`). The
only place the real CLI appears is the manual, opt-in smoke test of plan
Task 6.4.

## How a test starts it

Through the launcher of plan decision Q8, so the runner appends
`exec --json …` exactly the way it does in production and a test can assert the
argv without needing a real `.exe`:

```ts
import { fakeCodexLauncher } from '../helpers/fake-codex.ts'

const launcher = fakeCodexLauncher({ scenario: 'capability-unavailable' })
// { command: process.execPath, prefixArgs: [<this file>], source: 'path',
//   env: { FAKE_CODEX_SCENARIO: 'capability-unavailable' } }
```

**Put the `FAKE_CODEX_*` variables on the launcher, not on `process.env`.** A
Codex child only ever receives the allowlist `minimalCodexEnv` builds (spec
section 5.3: `PATH`, the home directory, `CODEX_HOME` and the system variables
needed to start a binary, and nothing else, so `OPENAI_API_KEY` cannot leak
into it). That allowlist drops `FAKE_CODEX_SCENARIO` along with everything else
it does not name, so a scenario exported in the parent process silently does
nothing and every test runs `success`. `CodexLauncher.env` is merged on top of
the allowlist for exactly this; the launcher `resolveCodexExecutable` returns
in production never carries any. There is a regression test for this in
`tests/integration/codex-preflight.test.ts`.

## What it answers

| Invocation     | Behaviour                                                       |
| -------------- | --------------------------------------------------------------- |
| `--version`    | prints `codex-cli 0.158.0` on stdout, exits 0                   |
| `login status` | prints on **stderr** and exits with `FAKE_CODEX_LOGIN`          |
| `exec …`       | records argv, replays a fixture, acts out `FAKE_CODEX_SCENARIO` |
| anything else  | prints the argv on stderr and exits 64                          |

`login status` printing on stderr is not an accident: the real 0.27.0 binary on
the development machine does exactly that and still exits 0, so only the exit
code is part of the contract (spec section 5.3).

## Environment variables

| Variable                   | Default   | What it does                                            |
| -------------------------- | --------- | ------------------------------------------------------- |
| `FAKE_CODEX_SCENARIO`      | `success` | which scenario `exec` acts out                          |
| `FAKE_CODEX_VERSION`       | `0.158.0` | what `--version` claims                                 |
| `FAKE_CODEX_LOGIN`         | `0`       | exit code of `login status`                             |
| `FAKE_CODEX_LINE_DELAY_MS` | `2`       | pause between JSONL lines, so the runner sees a stream  |
| `FAKE_CODEX_JOB_ID`        | —         | job ID to report when the directory holds no `job.json` |

## Scenarios

Every scenario writes `argv.json` into its working directory first, then
replays its fixture on stdout line by line, then does the following. `jobDir` is
the value of `-C`, or the working directory when there is none.

| `FAKE_CODEX_SCENARIO`    | Fixture                         | Afterwards                                                                                                  | Exit |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---- |
| `success`                | `success.jsonl`                 | copies `style-2x3.png` to `outputs/001.png`, writes a valid `codex-result.json`                             | 0    |
| `capability-unavailable` | `capability-unavailable.jsonl`  | writes `codex-result.json` with `IMAGE_CAPABILITY_UNAVAILABLE`, whose message holds a path and a fake token | 0    |
| `invalid-result`         | `success.jsonl`                 | writes a real image but a `codex-result.json` the schema refuses (unknown `error.code`, extra field)        | 0    |
| `nonzero-exit`           | `error.jsonl`                   | writes no `codex-result.json` at all                                                                        | 1    |
| `hang`                   | `success.jsonl` (first 3 lines) | waits to be killed                                                                                          | —    |
| `outputs-outside-job`    | `success.jsonl`                 | puts an image **next to** the job directory and declares `outputs/../../fake-codex-escape.png`              | 0    |

Notes for the tasks that consume this:

- `argv.json` records the argv, the working directory, the scenario and the
  **names** of the child's environment variables — never their values. A test
  asserting that `OPENAI_API_KEY` did not reach the child reads `envKeys`;
  writing the values would put the developer's own secrets on disk.
- `--output-last-message <path>` is honoured: the last `agent_message` in the
  fixture is written there, as the real CLI does.
- `outputs-outside-job` is refused twice over by the verifier of plan Task 3.6:
  the declared path fails the `outputs/…` regex in `codex-result.schema.json`
  before `safeJoin` ever sees it. A test that wants to exercise the symlink
  clause of spec section 7.3 should build that case itself with `linkFile` from
  `tests/helpers/tmp-workspace.ts`, which reports when Windows refuses to
  create the link so the test can skip instead of passing for the wrong reason.
- The "exit 0 but `outputs` is empty" case of spec section 7.3 has no scenario;
  it is one hand-written `codex-result.json` in the verifier's own test.
- `hang` exits 143 on `SIGTERM`, `SIGINT` or `SIGHUP`. On Windows the runner
  kills the tree with `taskkill /T /F` (plan decision Q12), which the fake
  cannot intercept — that is the behaviour under test.

## Fixtures

`tests/fixtures/codex-jsonl/0.158.0/` holds the JSONL the fake replays.

> **`synthetic: true`.** These three files are **hand-written**, not captured
> from a real Codex CLI. No machine here runs a Codex new enough to produce
> them: the installed CLI is 0.27.0, which has no `image_gen` tool and emits the
> older `task_started` / `agent_message` / `exec_command_begin` vocabulary.

They follow the event schema spec section 5.5 fixes for `CODEX_MIN_VERSION` and
above — `thread.started`, `turn.started`, `item.started`, `item.completed`,
`turn.completed`, `error` — with `item.type` drawn from the list that section
gives: `agent_message`, `reasoning`, `command_execution`, `file_change`,
`mcp_tool_call`, `web_search`, `todo_list` and other tool calls. `success.jsonl`
also carries one `item.updated`, which that list does not mention, so the
normalizer's "ignore what you do not know, but still log it" path is exercised
by realistic input rather than only by invented input.

Because the shapes are inferred from prose rather than observed, the normalizer
of plan Task 3.4 reads an item's type from `item.type` **or** `item.item_type`
and never fails on a field it does not find. Spec section 5.5 says the stream
carries no version marker and that the schema changed shape in 0.144 without
changing event names, so tolerance here is the design, not a workaround.

**Plan Task 6.3 replaces these files** with output captured from a real 0.158.0
CLI, after the manual upgrade. When it does: if the normalizer fails against the
captured stream, fix the normalizer, not the fixture, and update this section
with the Codex version and the capture date.

| Fixture                        | Lines | What it shows                                                                                      |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------- |
| `success.jsonl`                | 15    | reasoning, a shell command, an `image_gen` tool call, a copy, a file change, a final agent message |
| `capability-unavailable.jsonl` | 8     | Codex finding no `image_gen` and reporting it instead of generating                                |
| `error.jsonl`                  | 6     | a failed copy and an `error` event whose message carries an absolute path and a fake bearer token  |

The token in `error.jsonl` and in the `capability-unavailable` result message is
`sk-NOT-A-REAL-KEY-000000`. It exists so the sanitizer of plan Task 3.4 has
something to redact; it is not a credential.
