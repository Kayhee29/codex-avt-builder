# Reference Image Studio — run instructions

Job ID: `{{jobId}}`

This file is materialized into every job directory as `run-instructions.md`. It is
the detailed form of the fixed orchestration instruction that Reference Image
Studio passes to `codex exec`.

## 1. Your role

You are the **executor** for this job, not the prompt author and not a reviewer.

The creative direction has already been decided by the user in the app. Execute
it exactly as written:

- Do not reinterpret, expand, improve or summarize the user's creative intent.
- Do not add, remove, swap or reassign reference images.
- Do not rewrite `prompt.md`.
- If the job is genuinely unusable, stop and report it (section 6), rather than
  guessing at what was meant.

## 2. Working directory and files to read

The current working directory is the job directory. Read these three files
before doing anything else:

| File                  | What it holds                                                 |
| --------------------- | ------------------------------------------------------------- |
| `run-instructions.md` | this file                                                     |
| `job.json`            | the immutable job packet: subject, references, output request |
| `prompt.md`           | the full image prompt, already assembled by the app           |

The job directory also contains:

```text
inputs/    the reference images, copied in by the app (read only)
outputs/   where you put the generated images
```

Do not read files outside this directory, with one exception: the Codex
image-generation output folder described in section 4.

## 3. Reference images

The images attached to your message are the references listed in the
`references` array of `job.json`, **in the same order**: the Nth attachment is
the Nth entry of that array. The array is already sorted by role, and each entry
carries the `label` that `prompt.md` refers to, plus a `note` describing what to
take from that image.

Roles the user left empty are simply absent from the array, so do not assume
five attachments and do not infer a role from an attachment's position. Match
each attachment to its entry, then use the entry's `role` and `label`.

What each role decides:

| `role`      | Decides                                                  |
| ----------- | -------------------------------------------------------- |
| `style`     | proportions, linework, palette, texture, render language |
| `identity`  | face, hair, age, recognizable features                   |
| `outfit`    | garment design, fabric, colors, insignia                 |
| `equipment` | objects, weapons, scale, detail, how they are held       |
| `extra`     | one additional visual cue                                |

Use the attached images. Do not try to re-read `inputs/` as a substitute — the
attachments are what the image tool can actually see.

If an entry in `references` has no corresponding attached image, stop and report
`MISSING_REFERENCE` (section 6).

## 4. Generate the images

Use the **built-in `image_gen` tool**. It is the only image source allowed for
this job.

- `job.json` → `output` carries the request: `aspectRatio`, `background`,
  `format` and `count`. Generate `count` images.
- `prompt.md` is the prompt. Pass its content, together with the attached
  references, to `image_gen`.
- `image_gen` does not need an API key and does not need network access from the
  sandbox. It runs on the model side.
- If `image_gen` is not available in this session, or the call is refused, stop
  and report `IMAGE_CAPABILITY_UNAVAILABLE` (section 6). Do not look for another
  way to produce an image.

`image_gen` writes its files to the Codex image-generation output folder, which
is `generated_images/` under `$CODEX_HOME` (`~/.codex` when `CODEX_HOME` is not
set). That folder is outside the job directory; reading it in order to copy the
images out is the one exception to section 2.

## 5. Copy the outputs into `outputs/`

The job is only complete once every generated image exists inside the job
directory. Files left behind in the Codex output folder do not count.

Copy each generated image from the Codex output folder into `outputs/` and name
it with a zero-padded three-digit sequence number in generation order, plus the
extension matching the file's real format:

```text
outputs/001.png
outputs/002.png
```

Rules:

- Allowed extensions: `.png`, `.jpg`, `.webp`. The extension must match the
  actual bytes; the app re-checks the format with magic bytes.
- Copy the file as-is. Do not resize, recompress, crop or otherwise edit it.
- No subdirectories, no symlinks, no paths outside `outputs/`.
- Do not delete or overwrite anything already in the job directory.

## 6. Write `codex-result.json`

Write exactly one `codex-result.json` in the job directory, at the end of the
run, in every case — success or failure. It must validate against
`schemas/codex-result.schema.json` of the project. The shape is:

Success:

```json
{
  "schemaVersion": 1,
  "jobId": "{{jobId}}",
  "status": "succeeded",
  "outputs": [{ "path": "outputs/001.png" }],
  "error": null
}
```

Failure:

```json
{
  "schemaVersion": 1,
  "jobId": "{{jobId}}",
  "status": "failed",
  "outputs": [],
  "error": {
    "code": "IMAGE_CAPABILITY_UNAVAILABLE",
    "message": "Short, user-facing reason. No absolute paths, no credentials."
  }
}
```

Field rules:

- `schemaVersion` is `1`.
- `jobId` must be the job ID above, unchanged.
- `status` is `"succeeded"` or `"failed"`, nothing else.
- `outputs` lists only the files you actually copied into `outputs/`, each as a
  relative path of the form `outputs/<name>.<png|jpg|webp>`. `status: "succeeded"`
  with an empty `outputs` array is rejected.
- `error` is `null` on success, and an object with `code` and `message` on
  failure.

The four error codes you may use:

| Code                           | Use it when                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `INVALID_JOB`                  | `job.json` or `prompt.md` is missing, unreadable or inconsistent   |
| `MISSING_REFERENCE`            | a reference declared in `job.json` is not attached or not readable |
| `IMAGE_CAPABILITY_UNAVAILABLE` | the `image_gen` tool is absent or refused in this session          |
| `GENERATION_FAILED`            | `image_gen` ran but produced no usable image                       |

Any other code makes the app mark the job `INVALID_RESULT`.

Never write `result.json`. That file is the app's verified verdict and the app
alone owns it.

## 7. Prohibitions

- Do not call external APIs or any HTTP endpoint, and do not write code that
  would. The project has no API integration and no fallback path.
- Do not read, request, set or use API keys or any other credential.
  `OPENAI_API_KEY` is deliberately absent from your environment.
- Do not enable network access for the sandbox, and do not ask for it to be
  enabled.
- Do not write, move or delete any file outside this job directory.
- Do not modify `job.json`, `prompt.md`, `run-instructions.md` or anything in
  `inputs/`. They are the immutable record of what was requested.
- Do not install packages, and do not run anything that is not needed to
  generate and copy these images.

## 8. Finishing

When you are done, write `codex-result.json` and stop. Print a short final
message describing what happened; the app captures it in `last-message.txt`. The
app then verifies `outputs/` and `codex-result.json` itself and writes the
authoritative `result.json`. A zero exit code on its own is not treated as
success.
