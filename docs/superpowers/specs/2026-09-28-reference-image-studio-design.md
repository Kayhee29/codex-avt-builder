# Reference Image Studio — Đặc tả UI Builder và Codex CLI

**Trạng thái:** Bản nháp để duyệt

**Ngày:** 2026-09-28

**Implementation plan:** Chưa viết

## 1. Mục tiêu

Reference Image Studio là ứng dụng desktop local dành cho một người dùng, hỗ trợ tạo job sinh ảnh theo quy trình reference-first.

Ứng dụng gồm hai lớp tách biệt:

1. **UI Builder** thu thập và tổ chức toàn bộ ý định của người dùng: subject, pose, expression, output settings, preset, anchor và các ảnh reference theo role.
2. **Codex CLI** chỉ xuất hiện ở bước cuối. Khi người dùng bấm **Generate**, ứng dụng đóng gói job rồi gọi `codex exec` cục bộ để Codex đọc job, dùng các reference đã chọn và tạo ảnh.

Ứng dụng không gọi OpenAI API hoặc image API trực tiếp. Không có API key trong project, không có HTTP backend, không có Next.js API route và không có model SDK.

## 2. Diễn giải chính xác yêu cầu “không dùng API”

- Renderer và main process giao tiếp bằng Electron IPC nội bộ, không dùng HTTP.
- Main process khởi chạy binary `codex` đã được cài và đăng nhập trên máy người dùng.
- Project không tự gửi request đến endpoint của OpenAI hoặc bên thứ ba.
- Việc xác thực, chọn model và kết nối dịch vụ do Codex CLI quản lý bên ngoài project.
- Nếu Codex CLI hoặc capability sinh ảnh không khả dụng, job phải dừng với lỗi rõ ràng. Không được tự chuyển sang gọi API.

## 3. Kiến trúc được chọn

### 3.1 Desktop shell

Sử dụng **Electron + React + TypeScript + Vite**.

Electron phù hợp hơn Next.js cho thiết kế này vì ứng dụng cần:

- chọn và đọc file local;
- lưu preset, anchor và job xuống filesystem;
- khởi chạy `codex exec` bằng child process;
- nhận stdout, stderr và exit code theo thời gian thực;
- thực hiện tất cả các việc trên mà không dựng HTTP server hoặc API route.

Vite chỉ build renderer tĩnh. Không có SSR, server action hoặc network route nội bộ.

### 3.2 Process boundary

```text
React renderer
  │
  │ typed IPC commands
  ▼
Electron preload bridge
  │
  ▼
Electron main process
  ├─ filesystem workspace
  ├─ preset / anchor storage
  ├─ immutable job materializer
  └─ child_process.spawn("codex", ["exec", ...])
          │
          ▼
       Codex CLI
          ├─ đọc job.json + prompt.md + inputs/
          ├─ dùng capability sinh ảnh của Codex
          └─ ghi output + result.json
```

Renderer không được truy cập trực tiếp Node.js, filesystem hoặc child process. `contextIsolation` phải bật; `nodeIntegration` phải tắt. Preload chỉ expose các IPC command nằm trong allowlist.

## 4. Phạm vi chức năng của UI Builder

### 4.1 Character direction

UI có các trường:

- tên nhân vật;
- mô tả nhân vật;
- pose;
- expression;
- composition note;
- negative constraints do người dùng nhập;
- aspect ratio;
- background;
- output format.

Prompt preview cập nhật ngay khi dữ liệu thay đổi. Preview không chạy Codex CLI và không tạo ảnh.

### 4.2 Reference slots

UI có đúng năm slot độc lập:

| Role | Trách nhiệm |
|---|---|
| `style` | Tỉ lệ, linework, palette, texture và ngôn ngữ render |
| `identity` | Gương mặt, tóc, tuổi, đặc điểm nhận diện |
| `outfit` | Thiết kế trang phục, chất liệu, màu sắc, phù hiệu |
| `equipment` | Vật thể, vũ khí, tỉ lệ, chi tiết và cách cầm |
| `extra` | Một visual cue bổ sung có mô tả rõ ràng |

Mỗi slot hỗ trợ:

- chọn file;
- xem thumbnail;
- replace;
- remove;
- ghi note riêng cho role;
- hiển thị tên file và đường dẫn nguồn;
- cảnh báo nếu file không còn tồn tại.

Mỗi role chỉ có tối đa một reference đang hoạt động. Replace một slot không được thay đổi bất kỳ slot nào khác.

Định dạng ảnh chấp nhận ở phiên bản đầu: PNG, JPEG và WebP. Giới hạn dung lượng được cấu hình tập trung và mặc định là 20 MB mỗi file.

### 4.3 Prompt preview

UI Builder là nguồn chuẩn cho prompt. Prompt builder là module TypeScript thuần, dùng chung giữa renderer preview và bước materialize job.

Prompt có thứ tự cố định:

1. mục tiêu hình ảnh;
2. reference map;
3. subject;
4. pose, expression và composition;
5. output constraints;
6. conflict policy;
7. negative constraints do người dùng hoặc preset cung cấp.

Reference được sắp theo thứ tự `style`, `identity`, `outfit`, `equipment`, `extra`, rồi gán nhãn Image A, Image B…

Conflict policy mặc định:

- identity quyết định đặc điểm khuôn mặt;
- style quyết định cách render;
- outfit quyết định trang phục;
- equipment quyết định vật thể;
- chỉ dẫn mới nhất và rõ ràng của người dùng có ưu tiên cao nhất.

UI hiển thị đồng thời prompt hoàn chỉnh và mapping:

```text
Image A → style     → master-style.png
Image B → identity  → nixon-front.jpg
Image C → outfit    → dark-suit.png
```

### 4.4 Preset

Preset lưu các thiết lập có thể dùng cho nhiều nhân vật:

- style reference mặc định;
- role notes mặc định;
- prompt conventions;
- aspect ratio, background và output format;
- composition defaults.

Preset không lưu identity reference hoặc generated output.

Thứ tự merge:

```text
preset defaults
  < anchor defaults
  < current builder values
  < latest explicit user edits
```

UI phải hiển thị những trường sẽ thay đổi trước khi áp preset lên một draft đang có dữ liệu.

### 4.5 Anchor

Anchor lưu continuity của một nhân vật:

- tên anchor và version;
- identity reference;
- optional approved output image;
- mô tả identity ổn định;
- immutable traits;
- mutable traits;
- source job.

Outfit, equipment, pose và expression mặc định vẫn là mutable. Update anchor tạo version mới, không ghi đè version cũ.

### 4.6 Draft và recent jobs

UI tự lưu draft local khi người dùng chỉnh sửa. Danh sách recent jobs hiển thị:

- thumbnail output nếu có;
- job ID;
- subject name;
- trạng thái;
- thời gian;
- preset và anchor đã dùng;
- nút mở thư mục job;
- nút duplicate thành draft mới.

Job đã chạy là immutable. Mọi thay đổi sau đó phải tạo job hoặc revision mới.

## 5. Handoff từ UI sang Codex CLI

### 5.1 Trigger

Codex CLI chỉ được gọi khi người dùng bấm **Generate**. Save draft, preview prompt, upload reference, save preset và save anchor không được chạy Codex.

### 5.2 Materialize job

Trước khi gọi CLI, Electron main process:

1. validate builder state;
2. tạo job ID không trùng;
3. tạo thư mục `workspace/jobs/<job-id>/`;
4. copy từng active reference vào `inputs/` theo role;
5. tính SHA-256 cho mỗi input;
6. ghi `job.json`;
7. ghi prompt đã preview vào `prompt.md`;
8. ghi `run-instructions.md` cố định cho Codex;
9. chuyển trạng thái job thành `queued`.

Việc copy reference vào job giúp một run luôn reproducible dù file gốc bị đổi tên, chỉnh sửa hoặc xóa sau đó.

### 5.3 Khởi chạy Codex

Main process sử dụng `child_process.spawn` với argument array và `shell: false`. Không nối chuỗi shell từ dữ liệu người dùng.

Command contract:

```text
codex exec --json --full-auto <fixed orchestration instruction>
```

Working directory là thư mục project, còn orchestration instruction chỉ tham chiếu tới job ID đã được main process kiểm tra. Nội dung subject hoặc prompt của người dùng không được chèn vào shell command.

`--json` được dùng để nhận stream JSONL có cấu trúc. `--full-auto` chỉ được bật sau hành động Generate rõ ràng của người dùng vì run cần ghi output và result metadata. Tài liệu OpenAI mô tả `codex exec` là chế độ phù hợp cho automation, `--json` xuất event JSONL và `--full-auto` cho phép agent thực hiện thay đổi file trong sandbox đã cấu hình.

### 5.4 Fixed orchestration instruction

Instruction gửi cho `codex exec` có nội dung cố định theo ý nghĩa sau:

```text
Process the local Reference Image Studio job at workspace/jobs/<job-id>.
Read and validate job.json, prompt.md, and every file under inputs/.
Do not reinterpret or expand the user's creative intent.
Use the available Codex image-generation capability with the supplied references.
Write generated images under outputs/ and write result.json matching the project schema.
Do not call external APIs directly. If image generation is unavailable, write a failed result and stop.
```

Codex CLI là executor, không phải prompt builder. CLI có thể từ chối job không hợp lệ nhưng không được tự đổi role, thêm reference hoặc viết lại creative direction.

### 5.5 Progress channel

Main process đọc JSONL từ stdout và chuyển các event đã normalize sang renderer qua IPC:

```text
queued → validating → preparing → generating → saving → succeeded
                                           └───────→ failed
```

Raw JSONL được lưu tại `events.jsonl` để chẩn đoán. Stderr được lưu riêng tại `stderr.log`; UI chỉ hiển thị thông báo đã sanitize.

### 5.6 Completion rule

Exit code `0` chưa đủ để đánh dấu thành công. Job chỉ `succeeded` khi:

- `result.json` hợp lệ theo schema;
- có ít nhất một output image;
- mọi output path nằm trong thư mục job;
- output file đọc được và có định dạng được hỗ trợ.

Nếu thiếu bất kỳ điều kiện nào, main process đặt trạng thái `failed` và giữ lại log.

## 6. Job packet

`job.json` là hợp đồng bất biến giữa UI Builder và Codex CLI.

```json
{
  "schemaVersion": 1,
  "jobId": "2026-09-28-nixon-001",
  "createdAt": "2026-09-28T10:00:00Z",
  "subject": {
    "name": "Richard Nixon",
    "description": "Chibi historical character portrait",
    "pose": "Full body, standing upright",
    "expression": "Serious, no smile",
    "notes": "Clear silhouette"
  },
  "references": [
    {
      "role": "style",
      "path": "inputs/style.png",
      "originalName": "master-style.png",
      "mimeType": "image/png",
      "sha256": "<64 lowercase hex characters>",
      "note": "Rough black outline, muted color and warm paper texture"
    },
    {
      "role": "identity",
      "path": "inputs/identity.jpg",
      "originalName": "nixon-front.jpg",
      "mimeType": "image/jpeg",
      "sha256": "<64 lowercase hex characters>",
      "note": "Preserve facial structure, hairline and age cues"
    }
  ],
  "output": {
    "aspectRatio": "3:4",
    "background": "pale warm paper",
    "format": "png",
    "count": 1
  },
  "source": {
    "preset": "chibi-master-v1",
    "anchor": "nixon-v1"
  },
  "promptPath": "prompt.md",
  "status": "queued"
}
```

Các path trong packet luôn là relative path nằm trong job directory. Codex CLI không cần đọc file gốc bên ngoài job.

## 7. Result contract

Codex ghi `result.json`; Electron main process kiểm tra lại trước khi gửi kết quả cho UI.

```json
{
  "schemaVersion": 1,
  "jobId": "2026-09-28-nixon-001",
  "status": "succeeded",
  "startedAt": "2026-09-28T10:00:02Z",
  "completedAt": "2026-09-28T10:01:12Z",
  "outputs": [
    {
      "path": "outputs/001.png",
      "mimeType": "image/png",
      "width": 1024,
      "height": 1365
    }
  ],
  "promptPath": "prompt.md",
  "error": null
}
```

Khi thất bại:

- `status` là `failed`;
- `outputs` là mảng rỗng;
- `error.code` là mã ổn định;
- `error.message` là thông báo ngắn dành cho người dùng;
- log kỹ thuật nằm trong `events.jsonl` và `stderr.log`.

Mã lỗi tối thiểu:

- `CODEX_NOT_FOUND`;
- `CODEX_NOT_AUTHENTICATED`;
- `INVALID_JOB`;
- `MISSING_REFERENCE`;
- `IMAGE_CAPABILITY_UNAVAILABLE`;
- `GENERATION_FAILED`;
- `INVALID_RESULT`;
- `CANCELLED`.

## 8. IPC contract

Preload bridge chỉ expose các command sau:

```text
dialog.selectReference(role)
draft.load()
draft.save(draft)
library.listPresets()
library.savePreset(preset)
library.listAnchors()
library.saveAnchor(anchor)
jobs.list()
jobs.get(jobId)
jobs.generate(builderState)
jobs.cancel(jobId)
jobs.openFolder(jobId)
jobs.onProgress(listener)
```

Mọi payload IPC được validate bằng schema ở cả hai phía. Renderer không được gửi raw command, executable path, shell argument hoặc working directory.

## 9. Filesystem layout

```text
reference-image-studio/
├─ AGENTS.md
├─ README.md
├─ package.json
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ ipc.ts
│  │  ├─ workspace.ts
│  │  ├─ job-materializer.ts
│  │  └─ codex-runner.ts
│  ├─ preload/
│  │  └─ index.ts
│  ├─ renderer/
│  │  ├─ app.tsx
│  │  ├─ components/
│  │  └─ styles/
│  └─ shared/
│     ├─ schemas.ts
│     ├─ prompt-builder.ts
│     ├─ reference-roles.ts
│     └─ ipc-contract.ts
├─ schemas/
│  ├─ job.schema.json
│  ├─ result.schema.json
│  ├─ preset.schema.json
│  └─ anchor.schema.json
├─ instructions/
│  └─ run-job.md
├─ workspace/
│  ├─ drafts/
│  ├─ presets/
│  ├─ anchors/
│  └─ jobs/
│     └─ <job-id>/
│        ├─ job.json
│        ├─ prompt.md
│        ├─ run-instructions.md
│        ├─ inputs/
│        ├─ outputs/
│        ├─ events.jsonl
│        ├─ stderr.log
│        └─ result.json
└─ docs/
   └─ superpowers/specs/
```

`workspace/` là dữ liệu runtime local. Preset và anchor metadata có thể được track tùy người dùng; draft, logs và generated images mặc định nằm trong `.gitignore`.

## 10. Error handling và recovery

### Trước khi chạy

- Kiểm tra binary `codex` có trong PATH.
- Chạy preflight nhẹ để phát hiện trạng thái đăng nhập không hợp lệ.
- Kiểm tra reference tồn tại, đọc được, đúng MIME và không vượt giới hạn.
- Kiểm tra đủ subject name và description.
- Kiểm tra prompt preview khớp checksum với prompt được materialize.

### Trong khi chạy

- Stream progress nhưng không hiển thị raw stderr mặc định.
- Cho phép Cancel; main process gửi tín hiệu kết thúc tới đúng child process.
- Chặn Generate lần hai trên cùng một job đang chạy.
- Việc đóng cửa sổ không được âm thầm tạo run mới; ứng dụng phải thông báo nếu còn process hoạt động.

### Sau khi lỗi

- Không xóa job directory hoặc log.
- UI cho phép mở thư mục job và duplicate thành draft mới.
- Retry luôn tạo run mới hoặc revision mới; không ghi đè output cũ.
- Không bao giờ báo thành công chỉ dựa trên exit code.

## 11. Security boundaries

- Dùng `spawn` với argument array, `shell: false`.
- Không đưa text người dùng vào command line.
- Chỉ truyền job ID đã validate trong fixed orchestration instruction.
- Chuẩn hóa path và từ chối path traversal.
- Symlink trong job inputs không được phép.
- External source image chỉ được đọc khi người dùng chọn; job dùng bản copy local.
- Renderer không nhận access token, credential hoặc environment secret.
- Không ghi credential của Codex vào workspace, logs hoặc result.
- External navigation, remote content và arbitrary IPC channel bị tắt.

## 12. Trạng thái UI

Builder có các trạng thái độc lập:

- `clean`: chưa có thay đổi;
- `dirty`: có thay đổi chưa lưu;
- `saving`: đang lưu draft/preset/anchor;
- `ready`: hợp lệ để generate;
- `invalid`: thiếu hoặc sai dữ liệu.

Run có các trạng thái:

- `queued`;
- `validating`;
- `running`;
- `succeeded`;
- `failed`;
- `cancelled`.

Không dùng một boolean `loading` chung cho toàn ứng dụng.

## 13. Testing strategy

### Unit tests

- schema validation;
- role uniqueness và role ordering;
- prompt builder output;
- preset merge precedence;
- anchor versioning;
- safe path resolution;
- job ID generation;
- result validation;
- JSONL event normalization.

### Integration tests

- renderer → preload → main IPC với test double;
- file picker và replace từng role;
- materialize job tạo đúng inputs, checksums, packet và prompt;
- Codex runner dùng fake executable để kiểm tra args, stdout, stderr, cancellation và exit code;
- success chỉ xảy ra khi result và output đều hợp lệ.

### End-to-end tests

- tạo draft, thêm năm role, replace một role và xác nhận bốn role còn lại không đổi;
- save/load preset;
- save/version anchor;
- bấm Generate và quan sát progress;
- xử lý trường hợp thiếu Codex CLI;
- xử lý capability sinh ảnh không khả dụng;
- mở lại completed job từ Recent Jobs.

Test tự động không được gọi Codex thật hoặc tiêu tốn generation. Smoke test với Codex thật là bước thủ công, opt-in.

## 14. Acceptance criteria

Phiên bản đầu được xem là hoàn thành khi:

1. Người dùng có UI desktop riêng để nhập creative direction.
2. Mỗi role reference có thể upload, preview, replace và remove độc lập.
3. Prompt preview cập nhật trước khi chạy CLI.
4. Preset có thể save, list, load và merge đúng thứ tự.
5. Anchor có thể save, version và reuse mà không khóa outfit, equipment, pose hoặc expression.
6. Các thao tác builder không khởi chạy Codex CLI.
7. Bấm Generate tạo một job directory bất biến và copy toàn bộ active references vào `inputs/`.
8. Main process gọi `codex exec` bằng child process, không gọi API trực tiếp.
9. UI nhận và hiển thị progress từ JSONL stream qua IPC.
10. Job thành công có `job.json`, `prompt.md`, `inputs/`, ít nhất một output image, `events.jsonl` và `result.json` hợp lệ.
11. Thiếu Codex CLI, thiếu đăng nhập hoặc thiếu image capability tạo trạng thái failed rõ ràng, không có fallback API.
12. App hoạt động mà không yêu cầu người dùng nhập API key.

## 15. Ngoài phạm vi phiên bản đầu

- HTTP backend hoặc API route;
- gọi OpenAI API hay image API trực tiếp;
- Codex SDK hoặc app-server;
- web deployment;
- database, queue và multi-user collaboration;
- cloud asset library;
- tự động publish output;
- chỉnh ảnh theo layer hoặc mask;
- implementation plan, source code, GitHub remote và push trong giai đoạn spec này.

## 16. Quyết định đã chốt

- Có UI riêng: **Electron + React + TypeScript**.
- UI Builder là nơi tạo và preview prompt.
- Main process lưu job và gọi Codex CLI qua child process + IPC.
- Codex CLI chỉ chạy sau khi bấm Generate.
- Codex CLI là executor cuối, không phải UI và không phải prompt builder.
- Không có direct API integration hoặc fallback API.

## 17. Tài liệu tham chiếu

- [Testing Agent Skills Systematically with Evals — OpenAI Developers](https://developers.openai.com/blog/eval-skills): mô tả `codex exec` cho automation, JSONL với `--json`, và quyền ghi file với `--full-auto`.
