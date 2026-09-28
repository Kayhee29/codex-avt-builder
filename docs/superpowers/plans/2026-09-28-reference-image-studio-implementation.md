# Reference Image Studio — Implementation Plan

**Trạng thái:** Bản nháp để duyệt

**Ngày:** 2026-09-28

**Spec:** [2026-09-28-reference-image-studio-design.md](../specs/2026-09-28-reference-image-studio-design.md)

## 0. Cách đọc plan này

- Plan chia thành 7 giai đoạn, mỗi giai đoạn gồm các task nhỏ, mỗi task kết thúc bằng một commit chạy được và test xanh.
- Mỗi task ghi rõ file tạo hoặc sửa, test cần viết trước, tiêu chí pass, và message commit.
- Thứ tự task là thứ tự phụ thuộc. Task trong cùng giai đoạn có thể làm song song nếu không dùng chung file.
- Test tự động không bao giờ gọi Codex thật. Codex thật chỉ xuất hiện ở task cuối cùng, chạy thủ công.
- Mọi số mục dạng "mục 5.3" trỏ về spec.

## 1. Điều kiện tiên quyết trên máy phát triển

| Hạng mục | Yêu cầu | Trạng thái ngày 2026-09-28 |
|---|---|---|
| Node.js | 22 trở lên | 25.2.1 |
| pnpm | 9 trở lên | 11.2.2 |
| Codex CLI | lớn hơn hoặc bằng `CODEX_MIN_VERSION` = 0.158.0 | **0.27.0, phải nâng cấp** |
| Đăng nhập Codex | `codex login status` trả exit code 0 | đã đăng nhập bằng ChatGPT |
| Windows | Windows 10 build 1809 trở lên, sandbox elevated đã setup | build 19045, sandbox chưa kiểm tra |

Lệnh nâng cấp Codex, chạy thủ công trước giai đoạn 6:

```bash
npm install -g @openai/codex@latest
```

Sau khi nâng cấp, chạy `codex --version`, `codex login status` và `codex doctor`, rồi ghi kết quả vào mục 17 của spec nếu khác với những gì đã kiểm chứng.

## 2. Quyết định kỹ thuật bổ sung

Spec để ngỏ một số điểm. Plan chốt như sau và các quyết định này cần được back-port vào spec khi được duyệt.

| # | Điểm spec để ngỏ | Quyết định |
|---|---|---|
| Q1 | Toolchain | `electron-vite` 5 (main, preload, renderer cùng một config), TypeScript strict, React 19, `vitest` 5 cho unit và integration, `@playwright/test` với Electron launcher cho end-to-end, `electron-builder` chỉ để đóng gói ở cuối. Package manager là pnpm. |
| Q2 | Schema nguồn chuẩn | `zod` 4 trong `src/shared/schemas.ts` là nguồn chuẩn. Script `scripts/export-schemas.ts` sinh `schemas/*.json` bằng `z.toJSONSchema`. Một test so sánh file đã sinh với file trong repo để không lệch. Codex đọc file JSON; app validate bằng zod. |
| Q3 | Renderer không gửi path (mục 8, 11) | `dialog.selectReference(role)` trả về `referenceId` cùng metadata và thumbnail. Main giữ registry `referenceId → absolute path`. Builder state chỉ chứa `referenceId`. Draft do main ghi có chứa path, và khi `draft.load()` main tự đăng ký lại các path đó vào registry. |
| Q4 | Preset và anchor chứa ảnh (mục 4.4, 4.5) | Ảnh được copy vào `workspace/presets/<presetId>/style.<ext>` và `workspace/anchors/<anchorId>/v<N>/identity.<ext>` cùng lúc với metadata JSON, theo đúng lý do đã dùng cho job inputs. |
| Q5 | Áp preset lên draft có dữ liệu (mục 4.4) | Áp preset là hành động explicit. Hàm thuần `previewPresetApply(draft, preset)` trả danh sách field sẽ đổi; UI hiển thị rồi mới `applyPreset`. Sau khi áp, edit của người dùng thắng. Thứ tự merge khi tạo draft mới từ anchor: preset defaults, rồi anchor defaults, rồi giá trị người dùng nhập. |
| Q6 | "Revision" (mục 4.6, 10) | Không có trong phiên bản đầu. Retry luôn là duplicate job thành draft mới rồi Generate thành job mới. |
| Q7 | IPC bổ sung (mục 8) | Thêm `system.preflight()`, `system.getSettings()`, `system.setSettings(patch)` (chỉ có `codexExecutable`), `library.deletePreset(id)`. Không thêm gì khác. |
| Q8 | Fake Codex trong test (mục 13) | Codex runner nhận `launcher = { command, prefixArgs }`. Production: `{ command: <exe đã resolve>, prefixArgs: [] }`. Test: `{ command: process.execPath, prefixArgs: ['tests/fake-codex/fake-codex.mjs'] }`. Argument `exec --json ...` luôn nối sau `prefixArgs`, nên test kiểm tra được đúng argv mà không cần file `.exe`. |
| Q9 | State renderer | `zustand`, một store cho builder, một store cho jobs. Không có boolean `loading` chung (mục 12). |
| Q10 | Ngôn ngữ UI | Chuỗi hiển thị tiếng Việt, tập trung trong `src/renderer/i18n/vi.ts`. Code, identifier, log và error code bằng tiếng Anh. |
| Q11 | Đo ảnh | Magic bytes PNG, JPEG, WebP tự viết trong `src/main/image-inspect.ts` (vài chục dòng). Kích thước dùng package `image-size`. Không dùng `file-type` vì chỉ cần ba định dạng. |
| Q12 | Kill cây process (mục 5.3) | Windows: spawn `taskkill /T /F /PID <pid>`. macOS và Linux: spawn Codex với `detached: true` và gửi `SIGTERM` tới `-pid`. |
| Q13 | Job bị gián đoạn (mục 7.4, 12) | Khi app khởi động, main quét `workspace/jobs/*`; job có `job.json` mà không có `result.json` được ghi `result.json` với `failed` / `INTERRUPTED`. |
| Q14 | Nhãn Image A/B khi có slot trống (mục 4.3) | Nhãn gán **tuần tự cho các reference đang có**, sau khi sắp theo thứ tự role. Thiếu `style` thì `identity` thành `Image A`. Lý do: nhãn trong `prompt.md` phải khớp thứ tự đính kèm `-i` ở mục 5.3; nếu nhãn cố định theo role thì `Image B` sẽ là ảnh đính kèm thứ nhất và model hiểu sai. `job.json` luôn ghi `label` tường minh nên runtime không phải suy đoán. |
| Q15 | Content Security Policy | Không đặt CSP bằng thẻ meta trong `index.html` vì sẽ chặn preamble React Fast Refresh khi `pnpm dev`. Thay bằng `session.defaultSession.webRequest.onHeadersReceived` chỉ áp dụng khi đóng gói, làm trong Task 4.2. Nếu bật CSP thì phải cho phép `img-src data:` vì `JobSummary` mang `thumbnailDataUrl`. |
| Q16 | `promptConventions` của preset (mục 4.4) | Spec cho preset trường này nhưng prompt bảy phần ở mục 4.3 không có chỗ cho nó và `BuilderState` không có field tương ứng. `applyPreset` gộp nó vào composition note (`subject.notes`) dưới dạng các mệnh đề ngăn bằng `; `, có khử trùng lặp nên áp hai lần không đổi. Cần back-port vào spec 4.4 ở Task 6.4. |
| Q17 | Chữ ký hàm ở Task 1.5 xung đột với Q3 | `previewPresetApply` và `newDraftFromAnchor` không thể tự đặt ảnh style hoặc identity vào slot, vì `BuilderReference` là handle chỉ main process mới đúc được. Cả hai nhận thêm một options tùy chọn mang handle mà caller đã resolve (`styleReference`, `identityReference`). Không có handle thì slot để trống, và preview nói đúng như vậy. |
| Q18 | `library.listPresets` và `listAnchors` (mục 8) | Trả `PresetEntry { preset, styleReference }` và `AnchorEntry { anchor, identityReference }` thay vì object trần, vì renderer cần handle cho ảnh đã lưu mới áp preset hoặc load anchor được. |
| Q19 | `BuilderReference` thiếu thumbnail | Mục 4.2 yêu cầu thumbnail mỗi slot và Task 2.3 trả thumbnail, nhưng schema hiện chưa có field. Task 2.3 thêm field này vào `BuilderReferenceSchema`, chạy `pnpm export-schemas` và commit `schemas/draft.schema.json` đã sinh lại. |

## 3. Cấu trúc thư mục mục tiêu

Theo mục 9 của spec, bổ sung các file sau:

```text
src/main/
  codex-resolver.ts        resolve executable thật (mục 5.3)
  codex-preflight.ts       version + login status
  codex-runner.ts          spawn, JSONL, cancel
  jsonl-normalizer.ts      event Codex -> ProgressEvent
  result-verifier.ts       codex-result.json + outputs -> result.json
  image-inspect.ts         magic bytes, kích thước
  reference-registry.ts    referenceId -> absolute path
  settings.ts              app settings (codexExecutable)
  recovery.ts              INTERRUPTED khi khởi động
src/shared/
  codex-version.ts         CODEX_MIN_VERSION
  job-id.ts                sinh + validate job ID (mục 6.1)
  preset-merge.ts          previewPresetApply, applyPreset
  anchor.ts                version anchor
  progress.ts              kiểu ProgressEvent, RunState
scripts/
  export-schemas.ts
tests/
  unit/                    vitest, không I/O ngoài tmp dir
  integration/             vitest, dùng tmp workspace + fake codex
  fixtures/
    images/                png, jpg, webp nhỏ, một file sai magic bytes
    codex-jsonl/0.158.0/   success.jsonl, capability-unavailable.jsonl, error.jsonl
  fake-codex/fake-codex.mjs
e2e/                       Playwright Electron
```

## 4. Giai đoạn và task

### Giai đoạn 0: Khung dự án

#### Task 0.1: Scaffold electron-vite và cấu hình chất lượng

**Files:** `package.json`, `electron.vite.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`, `.eslintrc.cjs` hoặc `eslint.config.js`, `.prettierrc`, `.gitignore`, `.editorconfig`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/app.tsx`.

**Bước:**

1. `pnpm create @quick-start/electron` với template react-ts, hoặc tạo tay theo tài liệu electron-vite 5.
2. Bật `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` trong tsconfig.
3. `BrowserWindow` với `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`. Chặn `will-navigate`, `setWindowOpenHandler` trả `deny` (mục 11).
4. `.gitignore`: `node_modules`, `out`, `dist`, `workspace/drafts`, `workspace/jobs`, `workspace/**/*.png|jpg|jpeg|webp`, `.vite`. Giữ `workspace/presets/*.json` và `workspace/anchors/**/*.json` có thể track (mục 9).
5. Script npm: `dev`, `build`, `typecheck`, `lint`, `test`, `test:e2e`, `export-schemas`.
6. Một test smoke `tests/unit/smoke.test.ts` để xác nhận vitest chạy.

**Pass khi:** `pnpm typecheck`, `pnpm lint`, `pnpm test` xanh; `pnpm dev` mở cửa sổ trắng có chữ "Reference Image Studio".

**Commit:** `chore: scaffold electron-vite app with strict TypeScript and vitest`

#### Task 0.2: AGENTS.md, README và template instruction cho Codex

**Files:** `AGENTS.md`, `README.md`, `instructions/run-job.md`.

**Bước:**

1. `AGENTS.md` ở root: mô tả ngắn cho agent làm việc trong repo (không phải cho Codex khi chạy job): cấu trúc, lệnh test, quy tắc không gọi Codex thật trong test.
2. `instructions/run-job.md` là template được materialize thành `run-instructions.md` (mục 5.4). Nội dung: vai trò executor, đọc `job.json` và `prompt.md`, ảnh đính kèm theo thứ tự `label`, dùng `image_gen`, copy từ `$CODEX_HOME/generated_images/` vào `outputs/<NNN>.<ext>`, ghi `codex-result.json` theo `schemas/codex-result.schema.json`, các mã lỗi Codex được phép dùng (mục 7.1), cấm gọi API, cấm bật network, cấm sửa file ngoài job directory.
3. `README.md`: mục tiêu, điều kiện tiên quyết (mục 1 của plan), cách chạy, cách chạy smoke test thủ công.

**Pass khi:** review tay; template không chứa placeholder nào ngoài `{{jobId}}`.

**Commit:** `docs: add AGENTS.md, README and Codex run-job instruction template`

### Giai đoạn 1: Shared core (TypeScript thuần, không Electron)

#### Task 1.1: Reference roles và thứ tự

**Files:** `src/shared/reference-roles.ts`, `tests/unit/reference-roles.test.ts`.

**Test trước:**

- `REFERENCE_ROLES` đúng thứ tự `style, identity, outfit, equipment, extra`.
- `labelFor(index)` trả `Image A`… `Image E`.
- `sortReferences(refs)` sắp theo thứ tự role và ném lỗi nếu trùng role.

**Commit:** `feat(shared): define reference roles, ordering and labels`

#### Task 1.2: Zod schemas và export JSON Schema

**Files:** `src/shared/schemas.ts`, `scripts/export-schemas.ts`, `schemas/job.schema.json`, `schemas/codex-result.schema.json`, `schemas/result.schema.json`, `schemas/preset.schema.json`, `schemas/anchor.schema.json`, `schemas/draft.schema.json`, `tests/unit/schemas.test.ts`, `tests/unit/schemas-sync.test.ts`.

**Schema cần có (theo mục 6, 7, 4.4, 4.5):** `JobPacket`, `CodexResult`, `Result`, `Preset`, `Anchor`, `Draft`, `BuilderState`, `ProgressEvent`, `Settings`. `jobId` dùng regex mục 6.1. `sha256` là `^[a-f0-9]{64}$`. `references[].path` phải khớp `^inputs/(style|identity|outfit|equipment|extra)\.(png|jpg|webp)$`. `outputs[].path` phải khớp `^outputs/[A-Za-z0-9._-]+\.(png|jpg|webp)$`.

**Test trước:**

- Ví dụ JSON trong spec mục 6.2 và 7.2 parse thành công.
- `job.json` có thêm trường `status` bị từ chối (strict object).
- `codex-result.json` có `error.code` ngoài bốn mã cho phép bị từ chối.
- `schemas-sync.test.ts`: chạy export vào tmp dir và so sánh byte với `schemas/*.json`; fail kèm hướng dẫn chạy `pnpm export-schemas`.

**Commit:** `feat(shared): add zod schemas and exported JSON Schema files`

#### Task 1.3: Job ID

**Files:** `src/shared/job-id.ts`, `tests/unit/job-id.test.ts`.

**API:** `slugifySubject(name): string`, `buildJobId(date, slug, seq): string`, `isValidJobId(id): boolean`, `JOB_ID_REGEX`.

**Test trước:**

- `"Richard Nixon"` thành `richard-nixon`; `"Nguyễn Văn A"` thành `nguyen-van-a`; chuỗi toàn ký tự đặc biệt thành `job`; slug dài bị cắt ở 24 ký tự và không kết thúc bằng `-`.
- `buildJobId` ra `2026-09-28-richard-nixon-001` và khớp regex.
- `isValidJobId` từ chối `../x`, chữ hoa, khoảng trắng, slug rỗng.

**Commit:** `feat(shared): job id generation and validation`

#### Task 1.4: Prompt builder

**Files:** `src/shared/prompt-builder.ts`, `tests/unit/prompt-builder.test.ts`, `tests/unit/__snapshots__/`.

**API:** `buildPrompt(state: BuilderState, refs: OrderedReference[]): { markdown: string; mapping: MappingRow[] }`, `sha256Hex(text)` (dùng Web Crypto để chạy được cả renderer và main).

**Test trước:**

- Bảy phần theo đúng thứ tự mục 4.3, kiểm bằng vị trí heading.
- Reference map ghi `Image A → style → master-style.png`. Nhãn được gán tuần tự cho các reference **đang có**, sau khi đã sắp theo thứ tự role (Q14). Nếu slot `style` trống thì `identity` là `Image A`. Có một test riêng cho trường hợp này.
- Conflict policy mặc định có mặt; negative constraints từ preset và người dùng gộp, bỏ trùng.
- Snapshot cho một state đầy đủ để phát hiện thay đổi vô ý.
- Cùng input cho cùng output và cùng sha256 (deterministic).

**Commit:** `feat(shared): pure prompt builder with reference mapping`

#### Task 1.5: Preset merge và anchor versioning

**Files:** `src/shared/preset-merge.ts`, `src/shared/anchor.ts`, `tests/unit/preset-merge.test.ts`, `tests/unit/anchor.test.ts`.

**API:** `previewPresetApply(draft, preset): FieldChange[]`, `applyPreset(draft, preset): Draft`, `newDraftFromAnchor(preset | null, anchor): Draft`, `nextAnchorVersion(existing: Anchor[]): number`, `anchorImmutableTraitsConflict(anchor, draft): string[]`.

**Test trước:**

- Preview liệt kê đúng field sẽ đổi và bỏ qua field trùng giá trị.
- Apply không đụng identity reference và output đã sinh (mục 4.4).
- `newDraftFromAnchor` cho anchor defaults thắng preset defaults.
- Anchor version tăng dần, không ghi đè; outfit, equipment, pose, expression vẫn để trống để người dùng nhập (mục 4.5, 14.5).

**Commit:** `feat(shared): preset apply preview/merge and anchor versioning`

#### Task 1.6: IPC contract và progress types

**Files:** `src/shared/ipc-contract.ts`, `src/shared/progress.ts`, `tests/unit/ipc-contract.test.ts`.

**Nội dung:** danh sách channel đúng mục 8 cộng Q7; với mỗi channel có zod schema cho request và response; `RunState` gồm bảy giá trị mục 12; `ProgressEvent` theo payload mục 5.5.

**Test trước:** mọi channel có schema; không channel nào nhận `string` tự do dùng làm path hoặc argv (kiểm bằng cách liệt kê tên field và từ chối `path`, `cwd`, `args`, `command` trừ những field được whitelist trong `Settings`).

**Commit:** `feat(shared): typed IPC contract and run state types`

### Giai đoạn 2: Main process, phần lưu trữ

#### Task 2.1: Workspace và safe path

**Files:** `src/main/workspace.ts`, `tests/unit/workspace.test.ts`.

**API:** `resolveWorkspaceRoot(app)`, `jobDir(jobId)`, `safeJoin(root, ...parts)` từ chối `..`, absolute và symlink (dùng `fs.realpath` rồi so `startsWith(root + sep)`), `ensureWorkspaceLayout()` tạo `drafts/ presets/ anchors/ jobs/`.

**Test trước:** `safeJoin` từ chối `../x`, `C:\x`, path chứa symlink trỏ ra ngoài (tạo symlink trong tmp; bỏ qua test nếu Windows không cho tạo symlink).

**Commit:** `feat(main): workspace layout and safe path resolution`

#### Task 2.2: Image inspect

**Files:** `src/main/image-inspect.ts`, `tests/fixtures/images/*`, `tests/unit/image-inspect.test.ts`.

**API:** `inspectImage(absPath, { maxBytes }): Promise<{ mimeType, width, height, sizeBytes, sha256 }>`; ném `ImageInspectError` với mã `UNSUPPORTED_FORMAT`, `TOO_LARGE`, `NOT_A_FILE`, `IS_SYMLINK`.

**Test trước:** png, jpg, webp hợp lệ trả đúng kích thước; file `.png` có nội dung text bị `UNSUPPORTED_FORMAT`; file vượt `maxBytes` bị `TOO_LARGE`; sha256 khớp giá trị tính bằng `openssl` hoặc Node crypto trong test.

**Commit:** `feat(main): image inspection by magic bytes with size and hash`

#### Task 2.3: Reference registry và dialog

**Files:** `src/main/reference-registry.ts`, `src/main/dialog.ts`, `tests/unit/reference-registry.test.ts`.

**API:** `register(absPath): referenceId` (uuid), `resolve(referenceId): absPath | undefined`, `forget(referenceId)`, `registerMany(paths)` cho `draft.load()`. `selectReference(role)` mở `dialog.showOpenDialog` với filter PNG, JPEG, WebP, gọi `inspectImage`, đăng ký, tạo thumbnail (dùng `nativeImage.createFromPath().resize({ width: 256 })`) và trả `ReferenceHandle`.

**Test trước:** `resolve` id lạ trả `undefined`; `registerMany` giữ nguyên id đã có cho cùng path; registry không bao giờ trả path sang renderer (kiểm kiểu của `ReferenceHandle` không có field `path`).

**Commit:** `feat(main): reference registry and file picker returning opaque handles`

#### Task 2.4: Draft, preset, anchor storage

**Files:** `src/main/library.ts`, `tests/integration/library.test.ts`.

**Hành vi:**

- `draft.save` ghi atomically (`.tmp` rồi rename) vào `workspace/drafts/current.json`; `draft.load` đọc, validate, đăng ký lại path, đánh dấu `missing: true` cho reference không còn tồn tại (mục 4.2).
- `library.savePreset` copy ảnh style vào `workspace/presets/<id>/`; `deletePreset` xóa thư mục.
- `library.saveAnchor` tạo `v<N>` mới, copy identity và approved output nếu có, không đụng version cũ.

**Test trước (tmp workspace):** round trip draft; preset save rồi list trả đúng metadata và ảnh đã copy có sha256 bằng ảnh nguồn; lưu anchor hai lần tạo `v1` và `v2`; xóa file nguồn rồi `draft.load` trả `missing: true`.

**Commit:** `feat(main): draft, preset and anchor storage with copied images`

#### Task 2.5: Job materializer

**Files:** `src/main/job-materializer.ts`, `tests/integration/job-materializer.test.ts`.

**Hành vi theo mục 5.2:** validate `BuilderState` bằng zod; sinh job ID không trùng; tạo thư mục; copy reference sang `inputs/<role>.<ext>` bằng `fs.copyFile` (không follow symlink làm input: kiểm `lstat` nguồn trước); inspect lại bản copy; ghi `job.json`, `prompt.md`, `run-instructions.md` (từ template, thay `{{jobId}}`); so `promptSha256` với sha do renderer gửi kèm, lệch thì `INVALID_JOB`.

**Test trước:** job dir có đủ file; `job.json` parse được bằng schema; sha256 trong `job.json` bằng sha của file trong `inputs/`; đổi tên file nguồn sau khi materialize không ảnh hưởng job; hai lần gọi trong cùng ngày cho `001` và `002`; builder thiếu subject name bị từ chối trước khi tạo thư mục.

**Commit:** `feat(main): immutable job materializer`

### Giai đoạn 3: Codex runner

#### Task 3.1: Codex resolver

**Files:** `src/main/codex-resolver.ts`, `src/main/settings.ts`, `tests/unit/codex-resolver.test.ts`.

**Hành vi theo mục 5.3:** thứ tự settings override, npm global package, PATH. Trên Windows từ chối `.cmd`, `.bat`, `.ps1`; chỉ nhận `.exe`. Tìm npm global bằng `npm prefix -g` (spawn với `shell: false`, trên Windows gọi `npm.cmd` qua `process.env.ComSpec` với `/d /s /c` và argv cố định, không có dữ liệu người dùng) hoặc đọc `process.env.APPDATA/npm`. Trả `{ command, prefixArgs: [], source: 'settings' | 'npm-global' | 'path' }`.

**Test trước:** với tmp dir giả lập layout `node_modules/@openai/codex/bin/codex-x86_64-pc-windows-msvc.exe` resolver tìm được; PATH chỉ có `codex.cmd` thì trả `CODEX_NOT_FOUND` chứ không trả shim; settings override trỏ file không tồn tại thì `CODEX_NOT_FOUND` kèm message nêu path.

**Commit:** `feat(main): resolve real Codex executable, reject npm shims`

#### Task 3.2: Preflight

**Files:** `src/main/codex-preflight.ts`, `src/shared/codex-version.ts`, `tests/integration/codex-preflight.test.ts`.

**Hành vi:** chạy `<command> --version` và `<command> login status` với timeout 10 giây; parse `codex-cli X.Y.Z`; so bằng `semver.gte`; kết quả `{ ok: true, version, executable } | { ok: false, code, message }`; cache theo phiên, `system.preflight({ force: true })` để chạy lại.

**Test trước (fake codex):** fake trả `codex-cli 0.27.0` thì `CODEX_VERSION_UNSUPPORTED`; trả `0.158.0` và login exit 1 thì `CODEX_NOT_AUTHENTICATED`; cả hai đạt thì `ok`; fake treo quá timeout thì `CODEX_NOT_FOUND` với message timeout.

**Commit:** `feat(main): Codex preflight for version and login status`

#### Task 3.3: Fake Codex cho test

**Files:** `tests/fake-codex/fake-codex.mjs`, `tests/fixtures/codex-jsonl/0.158.0/*.jsonl`, `tests/fake-codex/README.md`.

**Hành vi:** đọc `FAKE_CODEX_SCENARIO` từ env do test đặt: `success`, `capability-unavailable`, `invalid-result`, `nonzero-exit`, `hang`, `outputs-outside-job`. Với `--version` in `codex-cli 0.158.0`. Với `login status` exit theo `FAKE_CODEX_LOGIN`. Với `exec`: ghi argv vào `argv.json` trong cwd để test kiểm tra, phát JSONL từ fixture tương ứng ra stdout theo từng dòng có delay nhỏ, ghi `codex-result.json` và tạo ảnh trong `outputs/` (copy từ `tests/fixtures/images/`) theo kịch bản, exit code theo kịch bản. Kịch bản `hang` chờ SIGTERM hoặc bị kill.

**Fixture JSONL:** ban đầu viết tay theo schema `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, đánh dấu `synthetic: true` trong README. Task 6.3 thay bằng fixture thu từ Codex thật.

**Commit:** `test: add scriptable fake Codex executable and JSONL fixtures`

#### Task 3.4: JSONL normalizer

**Files:** `src/main/jsonl-normalizer.ts`, `tests/unit/jsonl-normalizer.test.ts`.

**Hành vi theo mục 5.5:** parse từng dòng; dòng lỗi thành `{ type: 'unparsed', raw }`; `item.started` với `command_execution` thành activity "Đang chạy lệnh"; item có tên tool chứa `image_gen` thành "Đang gọi image_gen"; `agent_message` thành activity rút gọn 120 ký tự; `error` giữ message đã sanitize (bỏ path tuyệt đối và token dạng `sk-`, `Bearer`). Không bao giờ đổi `RunState`; state là việc của runner.

**Test trước:** chạy qua fixture success, đếm activity; dòng rác không ném; event lạ được bỏ qua nhưng có trong output log; message lỗi có `Bearer abc` bị che.

**Commit:** `feat(main): normalize Codex JSONL into UI activity events`

#### Task 3.5: Runner: spawn, stream, cancel

**Files:** `src/main/codex-runner.ts`, `tests/integration/codex-runner.test.ts`.

**Hành vi theo mục 5.3:** build argv `[...prefixArgs, 'exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', jobDir, ...refs.flatMap(r => ['-i', abs(r.path)]), '--output-last-message', abs('last-message.txt'), instruction]`; `spawn(command, argv, { cwd: jobDir, shell: false, env: minimalEnv(), windowsHide: true, detached: process.platform !== 'win32' })`; ghi dòng meta rồi từng dòng stdout vào `events.jsonl`, stderr vào `stderr.log`; phát `ProgressEvent` với `seq` tăng dần; `cancel()` kill cây process theo Q12; trả `{ exitCode, signal, cancelled }`.

**Test trước (fake codex):** `argv.json` đúng thứ tự và không chứa subject text; `-i` theo đúng thứ tự role; env của child không có `OPENAI_API_KEY` dù test đặt nó trong `process.env`; `events.jsonl` dòng đầu là `studio.meta`; kịch bản `hang` bị cancel trong dưới 2 giây và trả `cancelled: true`; gọi `start` lần hai trên job đang chạy bị từ chối (mục 10).

**Commit:** `feat(main): Codex runner with JSONL streaming and process-tree cancel`

#### Task 3.6: Result verifier và result.json

**Files:** `src/main/result-verifier.ts`, `tests/integration/result-verifier.test.ts`.

**Hành vi theo mục 5.6 và 7.3:** đọc `codex-result.json`, validate; với mỗi output: `safeJoin(jobDir, path)` phải nằm trong `outputs/`, `lstat` không symlink, `inspectImage`; file thừa trong `outputs/` vào `warnings`; so aspect ratio và format với `job.json` để sinh warning; ghi `result.json` với `executor`, `outputs` đo thật, `warnings`, `error`; ghi atomically.

**Test trước:** kịch bản success cho `succeeded` và `width/height` bằng ảnh fixture chứ không bằng số Codex khai; `invalid-result` cho `INVALID_RESULT`; `outputs-outside-job` cho `INVALID_RESULT`; `nonzero-exit` không có `codex-result.json` cho `GENERATION_FAILED`; `capability-unavailable` cho `IMAGE_CAPABILITY_UNAVAILABLE` với message của Codex đã sanitize; exit 0 nhưng `outputs` rỗng cho `INVALID_RESULT`.

**Commit:** `feat(main): verify Codex output and write authoritative result.json`

#### Task 3.7: Job orchestrator và recovery

**Files:** `src/main/jobs.ts`, `src/main/recovery.ts`, `tests/integration/jobs.test.ts`.

**Hành vi:** `generate(builderState)` chạy tuần tự materialize → `queued` → `preflight` → `running` → `verifying` → kết thúc, phát `ProgressEvent` ở mỗi chuyển trạng thái; mọi nhánh lỗi đều ghi `result.json` (kể cả preflight fail, khi đó `executor.codexVersion` là `null`); `list()` đọc `job.json` + `result.json` của từng job; `get(jobId)` validate id trước khi đụng filesystem; `openFolder` dùng `shell.showItemInFolder`; `recoverInterruptedJobs()` chạy khi app ready.

**Test trước:** chuỗi state đúng thứ tự cho success; preflight fail vẫn có `result.json` với `CODEX_NOT_FOUND`; cancel cho `cancelled` và `CANCELLED`; tạo job dir không có `result.json` rồi gọi recovery cho `INTERRUPTED`; `get('../etc')` bị từ chối.

**Commit:** `feat(main): job orchestration state machine and interrupted-job recovery`

### Giai đoạn 4: IPC và preload

#### Task 4.1: Preload bridge với allowlist

**Files:** `src/preload/index.ts`, `tests/unit/preload-allowlist.test.ts`.

**Hành vi:** `contextBridge.exposeInMainWorld('studio', api)`; `api` chỉ có các hàm trong `ipc-contract.ts`; mỗi hàm validate request bằng zod trước `ipcRenderer.invoke`; `jobs.onProgress` validate payload trước khi gọi listener và trả hàm unsubscribe.

**Test trước:** tập key của `api` bằng đúng tập channel trong contract; không có hàm nào expose `ipcRenderer` thô.

**Commit:** `feat(preload): typed bridge exposing only allowlisted IPC commands`

#### Task 4.2: Main IPC handlers

**Files:** `src/main/ipc.ts`, `tests/integration/ipc.test.ts`.

**Hành vi:** `ipcMain.handle` cho từng channel; validate request lần nữa ở main (mục 8); lỗi trả về dạng `{ ok: false, code, message }` đã sanitize, không ném stack sang renderer; `jobs.generate` từ chối khi có job đang chạy cùng draft.

**Test trước (mock `ipcMain` bằng bảng handler):** request sai schema bị từ chối trước khi chạm handler; `jobs.get` với id sai trả `INVALID_JOB`; progress được forward tới `webContents.send` với payload hợp lệ.

**Commit:** `feat(main): register validated IPC handlers`

### Giai đoạn 5: Renderer

#### Task 5.1: Store, i18n và layout khung

**Files:** `src/renderer/store/builder.ts`, `src/renderer/store/jobs.ts`, `src/renderer/i18n/vi.ts`, `src/renderer/app.tsx`, `src/renderer/components/Layout.tsx`, `src/renderer/styles/*.css`, `tests/unit/renderer/builder-store.test.ts`.

**Hành vi:** builder store giữ `BuilderState`, `status: clean | dirty | saving | ready | invalid` tính từ zod `safeParse` và cờ dirty; autosave debounce 800 ms gọi `draft.save`; jobs store giữ danh sách và `progressByJobId`. Layout ba cột: Character direction, Reference slots, Prompt preview; thanh dưới: preset, anchor, recent jobs, Generate.

**Test trước (vitest + jsdom):** nhập subject name làm `dirty`; state hợp lệ cho `ready`; xóa name cho `invalid`; autosave gọi bridge đúng một lần sau debounce.

**Lưu ý:** `tsconfig.node.json` hiện chỉ include `tests/**/*.ts`. Task này phải thêm project hoặc include cho `tests/unit/renderer/*.test.tsx`, nếu không typecheck bỏ sót test của renderer.

**Commit:** `feat(renderer): builder and jobs stores with Vietnamese UI strings`

#### Task 5.2: Character direction form và prompt preview

**Files:** `src/renderer/components/CharacterForm.tsx`, `src/renderer/components/PromptPreview.tsx`, `src/renderer/components/ReferenceMapping.tsx`, `tests/unit/renderer/prompt-preview.test.tsx`.

**Hành vi:** đủ các trường mục 4.1 cộng `count`; preview gọi `buildPrompt` trực tiếp trong renderer, không IPC; hiển thị prompt và bảng mapping cạnh nhau; sha256 của prompt được giữ trong store để gửi kèm khi Generate.

**Test trước:** gõ pose thì preview đổi ngay; không có lời gọi bridge nào khi chỉ sửa form (mục 5.1).

**Commit:** `feat(renderer): character direction form with live prompt preview`

#### Task 5.3: Reference slots

**Files:** `src/renderer/components/ReferenceSlot.tsx`, `src/renderer/components/ReferenceSlots.tsx`, `tests/unit/renderer/reference-slots.test.tsx`.

**Hành vi theo mục 4.2:** năm slot độc lập; chọn, thumbnail, replace, remove, note riêng, tên file, đường dẫn nguồn hiển thị từ metadata handle (main trả `displayPath` đã rút gọn, không dùng để gửi ngược), cảnh báo `missing`.

**Test trước (mock bridge):** replace slot `outfit` không đổi bốn slot còn lại (mục 14.2); remove xóa note của slot đó; slot `missing` hiển thị cảnh báo và chặn Generate.

**Commit:** `feat(renderer): five independent reference slots`

#### Task 5.4: Preset và anchor panel

**Files:** `src/renderer/components/PresetPanel.tsx`, `src/renderer/components/AnchorPanel.tsx`, `src/renderer/components/ApplyPreviewDialog.tsx`, `tests/unit/renderer/preset-panel.test.tsx`.

**Hành vi:** list, save, delete preset; nút Apply mở dialog liệt kê field sẽ đổi từ `previewPresetApply`, xác nhận mới áp; save anchor từ draft hiện tại (chọn identity reference và optional approved output từ recent job); load anchor tạo draft mới theo `newDraftFromAnchor` và hỏi trước nếu draft đang dirty.

**Test trước:** dialog hiển thị đúng danh sách field; hủy không đổi draft; áp preset không đụng identity.

**Commit:** `feat(renderer): preset and anchor panels with apply preview`

#### Task 5.5: Generate, progress và recent jobs

**Files:** `src/renderer/components/GenerateBar.tsx`, `src/renderer/components/RunProgress.tsx`, `src/renderer/components/RecentJobs.tsx`, `src/renderer/components/PreflightBanner.tsx`, `tests/unit/renderer/run-progress.test.tsx`.

**Hành vi:** banner preflight khi app mở (phiên bản, đăng nhập, nút mở Settings để đặt `codexExecutable`); Generate chỉ bật khi `ready` và không có run đang chạy; progress hiển thị state và `activity`, nút Cancel; recent jobs hiển thị đủ cột mục 4.6, nút mở thư mục, nút duplicate (đọc `jobs.get` rồi dựng draft mới, reference lấy từ `inputs/` của job qua handle do main cấp); warnings của result hiển thị dưới thumbnail.

**Test trước:** dãy `ProgressEvent` làm UI đi qua đủ state; Generate bị khóa khi `running`; cancel gọi bridge với đúng jobId; job `INTERRUPTED` hiển thị là failed.

**Commit:** `feat(renderer): generate flow, live progress and recent jobs`

#### Task 5.6: Đóng cửa sổ khi còn process

**Files:** `src/main/index.ts`, `src/renderer/components/CloseGuard.tsx`.

**Hành vi theo mục 10:** `before-quit` hỏi qua `dialog.showMessageBox` nếu còn job `running`; chọn thoát thì cancel tất cả rồi ghi `result.json` với `CANCELLED`.

**Commit:** `feat: guard app close while a Codex run is active`

### Giai đoạn 6: End-to-end, fixture thật và bàn giao

#### Task 6.1: Playwright Electron harness

**Files:** `playwright.config.ts`, `e2e/fixtures.ts`, `e2e/helpers/workspace.ts`.

**Hành vi:** launch app đã build với env `STUDIO_WORKSPACE=<tmp>`, `STUDIO_CODEX_LAUNCHER=fake` để main dùng launcher Q8 (chỉ chấp nhận khi `NODE_ENV=test`), `FAKE_CODEX_SCENARIO` theo test.

**Commit:** `test(e2e): Playwright Electron harness with fake Codex`

#### Task 6.2: Kịch bản end-to-end theo mục 13

**Files:** `e2e/builder.spec.ts`, `e2e/library.spec.ts`, `e2e/generate.spec.ts`, `e2e/failures.spec.ts`.

**Kịch bản:** tạo draft, thêm năm role, replace một role và xác nhận bốn role không đổi; save/load preset; save/version anchor; Generate với `success` và quan sát đủ state; `CODEX_NOT_FOUND` khi launcher trỏ file không tồn tại; `capability-unavailable`; mở lại completed job từ Recent Jobs và duplicate thành draft.

**Commit:** `test(e2e): cover builder, library, generate and failure paths`

#### Task 6.3: Thu fixture JSONL từ Codex thật (thủ công, opt-in)

**Files:** `scripts/capture-codex-fixture.md` (hướng dẫn), `tests/fixtures/codex-jsonl/0.158.0/*.jsonl` (thay bản synthetic).

**Bước thủ công:** sau khi nâng cấp Codex, chạy trong một thư mục tạm có một ảnh nhỏ:

```bash
codex exec --json --sandbox workspace-write --skip-git-repo-check -i ref.png "Generate one 256x256 PNG of a red circle with image_gen, copy it to outputs/out.png, then print DONE" > success.jsonl
```

Sanitize (bỏ thread id, đường dẫn tuyệt đối, tên người dùng), lưu vào fixture, cập nhật README của fixture với phiên bản Codex và ngày. Chạy lại toàn bộ test. Nếu normalizer fail, sửa normalizer chứ không sửa fixture.

**Commit:** `test: replace synthetic Codex JSONL fixtures with captured 0.158.0 output`

#### Task 6.4: Smoke test thủ công với Codex thật và cập nhật spec

**Bước:**

1. Chạy `pnpm dev`, kiểm tra banner preflight báo đúng phiên bản và đăng nhập.
2. Tạo job với hai reference (style, identity), bấm Generate, theo dõi progress tới `succeeded`.
3. Mở thư mục job, kiểm tra đủ `job.json`, `prompt.md`, `run-instructions.md`, `inputs/`, `outputs/`, `events.jsonl`, `stderr.log`, `last-message.txt`, `codex-result.json`, `result.json` (mục 14.10).
4. Tắt mạng và bấm Generate lần nữa: kỳ vọng `failed` với mã rõ ràng, không có fallback (mục 14.11).
5. Ghi kết quả, phiên bản Codex và mọi khác biệt so với spec vào mục 17 của spec; back-port các quyết định Q1 đến Q13 vào spec.

**Commit:** `docs: record real Codex smoke test results and back-port plan decisions into spec`

#### Task 6.5: Đóng gói

**Files:** `electron-builder.yml`.

**Hành vi:** build Windows portable hoặc NSIS; `workspace/` nằm trong `app.getPath('userData')` khi chạy bản đóng gói, nằm trong repo khi `pnpm dev` (đọc từ `resolveWorkspaceRoot`).

**Commit:** `build: electron-builder config for Windows`

## 5. Thứ tự ưu tiên và mốc kiểm tra

| Mốc | Gồm | Bằng chứng hoàn thành |
|---|---|---|
| M1 Core thuần | Giai đoạn 0 và 1 | `pnpm test` xanh, `schemas/*.json` đã sinh, prompt snapshot đã duyệt |
| M2 Job pipeline không UI | Giai đoạn 2 và 3 | integration test với fake Codex đi hết `queued` tới `succeeded`, `failed`, `cancelled`, `INTERRUPTED` |
| M3 App dùng được | Giai đoạn 4 và 5 | chạy `pnpm dev`, tạo job với fake Codex qua UI |
| M4 Bàn giao | Giai đoạn 6 | e2e xanh, fixture thật, smoke test thủ công thành công, spec đã cập nhật |

Có thể bắt đầu M1 và M2 ngay với Codex 0.27.0 vì không task nào trước 6.3 cần Codex thật. Nâng cấp Codex phải xong trước Task 6.3.

## 6. Rủi ro và cách xử lý

| Rủi ro | Dấu hiệu | Xử lý |
|---|---|---|
| `image_gen` không xuất hiện trong `codex exec` dù đã nâng cấp | smoke test 6.4 cho `IMAGE_CAPABILITY_UNAVAILABLE` liên tục | kiểm `codex doctor`, thử `$imagegen` trong chế độ interactive để tách lỗi CLI với lỗi tài khoản; không thêm fallback API (mục 2) |
| Schema JSONL đổi ở bản Codex mới hơn | fixture cũ vẫn xanh nhưng UI không có activity | normalizer bỏ qua event lạ nên job vẫn kết thúc đúng; thu fixture mới, nâng `CODEX_MIN_VERSION` |
| Sandbox Windows chưa setup | run kết thúc sớm với thông báo sandbox trong stderr | map sang `CODEX_SANDBOX_UNAVAILABLE` trong verifier bằng pattern trên stderr; UI hướng dẫn setup |
| `image_gen` bỏ qua yêu cầu kích thước hoặc format | `warnings` xuất hiện trên mọi job | chấp nhận trong phiên bản đầu; ghi vào spec là hạn chế đã biết |
| npm layout của `@openai/codex` đổi | resolver không tìm được binary dù đã cài | settings override `codexExecutable` là đường thoát; resolver log mọi đường dẫn đã thử |
