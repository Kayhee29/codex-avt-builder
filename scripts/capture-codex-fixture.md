# Capturing Codex JSONL fixtures

Manual, opt-in procedure for plan Task 6.3: replace the hand-written fixtures in
`tests/fixtures/codex-jsonl/<version>/` with output recorded from a real Codex
CLI.

**This is the only procedure in the repository that starts the real `codex`.**
It consumes generations and needs a signed-in account, so it is run by a human,
never by the test suite (`AGENTS.md`, spec section 13). Nothing here runs in CI.

## 1. Prerequisites

| Requirement      | Check                 | Expected                     |
| ---------------- | --------------------- | ---------------------------- |
| Codex version    | `codex --version`     | at least `CODEX_MIN_VERSION` |
| Signed in        | `codex login status`  | exit 0, ChatGPT or API key   |
| Image capability | `codex features list` | `image_generation … true`    |
| Sandbox          | `codex doctor`        | `sandbox` row healthy        |

`CODEX_MIN_VERSION` lives in `src/shared/codex-version.ts`. The fixture
directory is named after the version actually captured, so a newer CLI means a
new directory, not an edit of the old one.

### Upgrading

Check how the CLI was installed before upgrading — `codex doctor` reports it on
the `install` row as `managed by npm/bun/pnpm`.

```bash
# standalone install (the OpenAI installer): the CLI updates itself
codex update

# npm-managed install
npm install -g @openai/codex@latest
```

Do not run the npm command against a standalone install. It leaves a second
copy plus the `codex.cmd` shim on `PATH`, and `resolveCodexExecutable` rejects
shims outright (`src/main/codex-resolver.ts`), so the app would stop finding
Codex even though `codex` still works in a shell.

## 2. Use a quiet configuration

A developer's `~/.codex/config.toml` usually carries MCP servers, plugins and a
`notify` hook. They start on every `codex exec`, add startup latency and put
events into the stream that belong to that one machine rather than to the Codex
protocol. Turn them off **per run**, with `-c` overrides, so the captured stream
is portable and the user's config is never edited:

```bash
codex -c mcp_servers.<name>.enabled=false … doctor   # verify: "disabled servers  N"
```

List the server names with `codex doctor` first; pass one `-c` per server.
`-c mcp_servers={}` does **not** work — the table is merged, not replaced.

Keeping the fixtures free of MCP noise is deliberate. Whether the normalizer
survives a _noisy_ stream is checked separately, against `events.jsonl` from the
real app run of plan Task 6.4, on a machine that has those servers configured.

## 3. Prepare a scratch directory

Outside the repository, with one small reference image. `scripts/make-ref-png.mjs`
writes a 64×64 PNG with no dependencies:

```bash
mkdir -p /tmp/codex-capture/outputs
node scripts/make-ref-png.mjs /tmp/codex-capture/ref.png
```

`outputs/` must exist before the run: the prompt tells Codex to copy its image
there, and the `workspace-write` sandbox is rooted at the working directory.

## 4. Record each scenario

Run each from inside the scratch directory. Flags mirror what
`buildCodexArguments` spawns in production (`src/main/codex-runner.ts`), so the
captured stream is the one the app really sees.

### `success.jsonl`

```bash
codex exec --json --sandbox workspace-write --skip-git-repo-check \
  -i ref.png \
  --output-last-message last-message.txt \
  "Generate one 256x256 PNG of a red circle with image_gen, copy it to outputs/out.png, then print DONE" \
  > success.jsonl
```

**Keep `--output-last-message` between the image and the prompt.** `-i/--image`
takes `<FILE>...` and is variadic, so a bare prompt right after it is parsed as
a second image path; Codex then finds no prompt, prints
`Reading prompt from stdin...` and exits 1 against an empty stdin. A flag has to
break the list first. `buildCodexArgs` orders the production command line the
same way for the same reason.

**Close stdin.** With a prompt argument _and_ a piped stdin, Codex appends
stdin as a `<stdin>` block and waits for it to end, so an idle pipe stalls the
run at `Reading additional input from stdin...`. A shell redirect from the
terminal is fine; a driver that spawns Codex must pass `'ignore'` for stdin, as
`CodexRunner` does.

What the 0.158.0 capture actually contained: `thread.started`, `turn.started`,
three `command_execution` items, three `agent_message` items, `turn.completed`
— and **no `image_gen` tool call, no `reasoning` item and no `file_change`
item**. The image comes from the `imagegen` skill, which writes to
`generated_images/` under `CODEX_HOME` and announces nothing. Confirm
`outputs/out.png` exists afterwards; the stream will not tell you it was made.

### `capability-unavailable.jsonl`

**Capturing this needs more than turning the feature off.** `--disable
image_generation` removes the tool, but Codex does not then report the
capability missing: it reaches for the bundled Codex app tools and produces the
image anyway, through `adobe.image_generate` and `photoshop-api.adobe.io`,
uploading a local file with `adobe.asset_openai_file_upload` on the way. Two
more things are needed, both of which a real job already has: the
`-c features.apps=false` that `buildCodexArgs` passes, and a prompt carrying
what `instructions/run-job.md` section 4 demands.

```bash
codex exec --json --sandbox workspace-write --skip-git-repo-check   --disable image_generation   -c features.apps=false   -i ref.png   --output-last-message last-message.txt   "Generate a 256x256 PNG with the built-in image_gen tool and copy it to outputs/out.png. image_gen is the only image source allowed for this job. If image_gen is not available in this session, or the call is refused, stop immediately, write codex-result.json reporting IMAGE_CAPABILITY_UNAVAILABLE, and do not look for another way to produce an image."   > capability-unavailable.jsonl
```

What the 0.158.0 capture contained: three `agent_message` items, two
`command_execution` items, two `file_change` items, no image in `outputs/`, and
a `codex-result.json` carrying `IMAGE_CAPABILITY_UNAVAILABLE`. Confirm all
three of those before keeping the recording.

### `error.jsonl`

Needs a turn that starts and then fails, not one refused up front. Asking for a
model the account cannot use gets there, and unlike the network-disconnection
the plan suggested it changes nothing about the machine:

```bash
codex exec --json --sandbox workspace-write --skip-git-repo-check   -c features.apps=false   -m model-that-does-not-exist-xyz   --output-last-message last-message.txt   "Print DONE"   > error.jsonl
```

Expect `thread.started`, an `item.completed` whose item type is `error`,
`turn.started`, an `error` event and `turn.failed`, and exit 1. The failure is
a plain HTTP 400, so nothing in it needs redacting — which is why the fake's
`nonzero-exit` scenario appends a dirty error of its own instead of a recording
being edited to carry a credential it never had.

## 5. Sanitize

Recorded streams carry machine-specific and account-specific values.
`scripts/sanitize-codex-fixture.mjs` does the mechanical part:

```bash
node scripts/sanitize-codex-fixture.mjs success.jsonl \
  tests/fixtures/codex-jsonl/0.158.0/success.jsonl
```

It replaces the account's user name wherever it appears, maps the thread id and
every other UUID onto stable all-zero placeholders, and cuts an
`aggregated_output` longer than 400 bytes down to a marker — Codex echoes whole
files it reads into that field, and on the first capture one line carried 26 KB
of a third party's document. It prints how many UUIDs it replaced and whether
the user name survived anywhere; both should read clean.

Event order, event names, item ids, item types and `usage` counts are left
exactly as recorded. Read the result before committing it: the script does not
know about a value it has never seen, and a command string can carry anything.

Keep exactly one fake token, `sk-NOT-A-REAL-KEY-000000`, in `error.jsonl`: the
sanitizer of plan Task 3.4 is tested against it and would otherwise have nothing
to redact.

## 6. Install and verify

1. Put the files in `tests/fixtures/codex-jsonl/<captured version>/`.
2. Update the **Fixtures** section of `tests/fake-codex/README.md`: drop the
   `synthetic: true` note, record the Codex version and the capture date, and
   correct the line counts.
3. Run the whole suite.

```bash
pnpm test && pnpm test:e2e
```

If the normalizer fails against a captured stream, **fix the normalizer, not the
fixture** (plan Task 6.3). The fixture is now evidence of what Codex emits; the
code is what has to bend. Spec section 5.5 notes the stream carries no version
marker and changed shape at 0.144 without renaming events, so tolerance is the
design.
