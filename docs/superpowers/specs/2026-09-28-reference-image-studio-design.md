# Reference Image Studio — Đặc tả UI Builder và Codex CLI

**Trạng thái:** Bản nháp để duyệt

**Ngày:** 2026-09-28

**Implementation plan:** [2026-09-28-reference-image-studio-implementation.md](../plans/2026-09-28-reference-image-studio-implementation.md)

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
          └─ ghi outputs/ + codex-result.json
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

#### Yêu cầu phiên bản và preflight

Luồng Generate phụ thuộc vào tool `image_gen` có sẵn trong Codex CLI. Tool này chỉ có ở các bản Codex CLI phát hành từ tháng 3/2026 (khoảng 0.117 trở lên); các bản cũ hơn chỉ có `apply_patch`, `local_shell`, `web_search` và `view_image`, không thể sinh ảnh. Phiên bản tối thiểu được chốt trong một hằng số duy nhất `CODEX_MIN_VERSION`, giá trị ban đầu là `0.158.0` (bản mới nhất tại thời điểm viết spec).

Trước mỗi run, main process chạy preflight theo thứ tự và dừng ngay ở bước lỗi đầu tiên:

| Bước | Lệnh | Điều kiện đạt | Mã lỗi nếu không đạt |
|---|---|---|---|
| Resolve executable | xem bên dưới | tìm được file thực thi thật | `CODEX_NOT_FOUND` |
| Phiên bản | `codex --version` | semver lớn hơn hoặc bằng `CODEX_MIN_VERSION` | `CODEX_VERSION_UNSUPPORTED` |
| Đăng nhập | `codex login status` | exit code 0 | `CODEX_NOT_AUTHENTICATED` |

Preflight không gọi `codex exec` và không tiêu tốn generation. Kết quả preflight được cache trong phiên app và hiển thị trên UI. `codex doctor` chỉ dùng thủ công khi cần chẩn đoán.

#### Resolve executable

Main process không spawn tên `codex` trần. Trên Windows, `codex` trong `PATH` là shim `codex.cmd` do npm tạo; shim này gọi `node` rồi mới tới binary thật `codex-x86_64-pc-windows-msvc.exe`. `child_process.spawn` với `shell: false` từ chối thẳng file `.cmd` và `.bat` kể từ Node 20.12 (bản vá BatBadBut), lỗi là `EINVAL` chứ không phải `ENOENT`. Đã kiểm chứng trên Node 25.2.1 ngày 2026-09-29. Thứ tự resolve:

1. đường dẫn do người dùng cấu hình trong app settings, nếu có;
2. binary thật trong package npm global `@openai/codex` (thư mục `bin/` hoặc package theo platform);
3. `codex` trong `PATH`, chỉ khi đó là file thực thi thật.

Trên Windows, file resolve được phải có đuôi `.exe`; `.cmd`, `.bat` và `.ps1` bị từ chối. Đường dẫn đã resolve được ghi vào `events.jsonl` để chẩn đoán. Không bao giờ bật `shell: true` để đi vòng.

#### Command contract

Main process dùng `child_process.spawn` với argument array, `shell: false` và `cwd` là job directory. Không nối chuỗi shell từ dữ liệu người dùng.

```text
<codex-executable> exec
  --json
  --sandbox workspace-write
  --skip-git-repo-check
  -C <đường dẫn tuyệt đối của workspace/jobs/<job-id>>
  -i <đường dẫn tuyệt đối của inputs/<role>.<ext>>   (lặp lại cho từng reference, theo thứ tự role)
  --output-last-message <đường dẫn tuyệt đối của last-message.txt trong job directory>
  <fixed orchestration instruction>
```

Quy tắc:

- **Working directory là job directory**, không phải thư mục project. Sandbox `workspace-write` chỉ cho phép ghi trong working directory, nên Codex không thể sửa `src/`, preset, anchor hay job khác. Codex vẫn đọc được `$CODEX_HOME/generated_images/`, nơi `image_gen` lưu ảnh mặc định, để copy về `outputs/`.
- **Reference được đính kèm bằng `-i`** theo đúng thứ tự `style`, `identity`, `outfit`, `equipment`, `extra`, trùng với nhãn Image A, Image B… trong `prompt.md`. Đường dẫn `-i` do main process sinh từ job packet, không lấy từ renderer. Skill `imagegen` của Codex chỉ dùng được ảnh đã có trong context, nên đây là cách chắc chắn để reference được nhìn thấy.
- **Không dùng `--full-auto`.** Tài liệu Codex hiện tại đánh dấu flag này là deprecated và khuyên dùng `--sandbox workspace-write` tường minh. Không bao giờ dùng `--dangerously-bypass-approvals-and-sandbox` hay `--sandbox danger-full-access`, kể cả khi sandbox lỗi.
- **Không bật network cho sandbox.** Main không truyền `-c sandbox_workspace_write.network_access=true`. `image_gen` là tool phía server của model nên không cần network từ sandbox; việc chặn network ngăn Codex tự viết script gọi API.
- **Môi trường child process tối thiểu**: chỉ `PATH`, thư mục home (`HOME` hoặc `USERPROFILE`), `CODEX_HOME` nếu người dùng cấu hình, và các biến hệ thống cần để chạy binary. `OPENAI_API_KEY` và các biến bí mật khác không được truyền vào; xác thực hoàn toàn do login của Codex quản lý.
- **Cancel** phải kết thúc cả cây process (trên Windows dùng `taskkill /T /F` với PID của child, trên macOS và Linux gửi tín hiệu tới process group), vì Codex có thể sinh process con cho sandbox và shell command.
- **Instruction** chỉ chứa nội dung cố định ở mục 5.4 và job ID đã validate theo regex ở mục 6.1. Nội dung subject, prompt hoặc note của người dùng không được chèn vào command line; Codex đọc chúng từ `prompt.md` và `job.json`.

#### Windows

Sandbox native của Codex trên Windows cần Windows 10 build 1809 trở lên và một lần setup elevated có quyền admin do Codex CLI tự thực hiện. App không tự chạy setup này. Nếu Codex báo sandbox không khả dụng, job thất bại với `CODEX_SANDBOX_UNAVAILABLE` và UI hướng dẫn người dùng chạy setup trong Codex CLI. Không được hạ xuống `danger-full-access` để đi vòng.

### 5.4 Fixed orchestration instruction

Instruction gửi cho `codex exec` có nội dung cố định theo ý nghĩa sau; phần duy nhất thay đổi là `<job-id>`:

```text
You are executing Reference Image Studio job <job-id>.
The current working directory is the job directory. Read run-instructions.md, job.json and prompt.md.
The images attached to this message are the references listed in job.json, in the same order.
Do not read files outside this directory except the Codex image-generation output folder.
Do not reinterpret or expand the user's creative intent.
Generate the images with the built-in image_gen tool using the attached references and prompt.md.
Copy every generated image into outputs/ and write codex-result.json matching the project schema.
Do not call external APIs, do not use API keys, and do not enable network access.
If image generation is unavailable, write a failed codex-result.json and stop.
```

Codex CLI là executor, không phải prompt builder. CLI có thể từ chối job không hợp lệ nhưng không được tự đổi role, thêm reference hoặc viết lại creative direction. `run-instructions.md` trong job directory là bản chi tiết của instruction này (schema của `codex-result.json`, quy tắc đặt tên file trong `outputs/`, cách copy từ thư mục output mặc định của `image_gen`), được sinh từ template `instructions/run-job.md`.

### 5.5 Progress channel

Main process đọc stdout của Codex theo từng dòng JSONL, parse từng dòng độc lập và chuyển các event đã normalize sang renderer qua IPC. Dòng không parse được vẫn được ghi vào `events.jsonl` với cờ `unparsed`, không làm job thất bại.

#### Schema event phụ thuộc phiên bản

Schema của `codex exec --json` không ổn định giữa các phiên bản và không có version marker trong stream:

- các bản cũ (ví dụ 0.27) phát `task_started`, `agent_message`, `exec_command_begin`, `exec_command_end`, `task_complete`, `error`;
- các bản hiện tại phát `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `error`, với `item.type` gồm `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list` và các tool call khác;
- bản 0.144 đổi cấu trúc item mà không đổi tên event.

Vì vậy:

- normalizer chỉ hỗ trợ schema `thread.*` / `turn.*` / `item.*` của các bản từ `CODEX_MIN_VERSION` trở lên; event lạ được bỏ qua nhưng vẫn ghi log;
- dòng đầu tiên của `events.jsonl` do main tự ghi, dạng `{"type":"studio.meta","codexVersion":"...","executable":"...","args":[...]}`, để fixture và người đọc log biết stream thuộc phiên bản nào;
- mỗi phiên bản Codex được hỗ trợ có fixture JSONL riêng trong test; nâng `CODEX_MIN_VERSION` phải kèm fixture mới.

#### Trạng thái run và activity

Codex không biết các phase của app, nên **trạng thái run do main process quyết định**, không suy ra từ tên event của Codex:

```text
queued → preflight → running → verifying → succeeded
  │          │          │          │
  │          └──────────┴──────────┴──────→ failed
  └──────────┴──────────┴─────────────────→ cancelled
```

Cancel được phép ở `queued`, `preflight` và `running`, đúng theo mục 10. Preflight có thể mất tới 20 giây vì hai lệnh đều có timeout 10 giây, nên khóa nút Cancel cho tới khi `running` là không chấp nhận được. Cancel trong `verifying` bị bỏ qua vì run đã kết thúc.

| Trạng thái | Ai đặt | Khi nào |
|---|---|---|
| `queued` | main | job directory đã materialize xong (mục 5.2) |
| `preflight` | main | đang resolve executable, kiểm tra phiên bản và đăng nhập (mục 5.3) |
| `running` | main | từ lúc spawn thành công đến khi process kết thúc |
| `verifying` | main | process đã thoát, main đang kiểm tra `codex-result.json` và `outputs/` (mục 5.6 và 7.3) |
| `succeeded`, `failed`, `cancelled` | main | trạng thái kết thúc, được ghi vào `result.json` |

Trong `running`, các item event của Codex được chuyển thành chuỗi `activity` ngắn dành cho UI (ví dụ "Đang gọi image_gen", "Đang chạy lệnh copy") kèm số thứ tự event. `activity` là thông tin hiển thị, không phải trạng thái, và không ảnh hưởng tới quyết định thành công hay thất bại.

Payload IPC của `jobs.onProgress`:

```json
{ "jobId": "2026-09-28-richard-nixon-001", "state": "running", "activity": "Đang gọi image_gen", "seq": 42, "at": "2026-09-28T10:00:40Z" }
```

Raw JSONL được lưu tại `events.jsonl` để chẩn đoán. Stderr được lưu riêng tại `stderr.log`; final message của Codex được CLI ghi vào `last-message.txt`. UI chỉ hiển thị thông báo đã sanitize.

### 5.6 Completion rule

Exit code `0` chưa đủ để đánh dấu thành công. Job chỉ `succeeded` khi:

- `codex-result.json` hợp lệ theo schema executor (mục 7.1);
- có ít nhất một output image;
- mọi output path nằm trong thư mục job;
- output file đọc được và có định dạng được hỗ trợ.

Nếu thiếu bất kỳ điều kiện nào, main process đặt trạng thái `failed` và giữ lại log.

## 6. Job packet

`job.json` là hợp đồng bất biến giữa UI Builder và Codex CLI. File này được ghi một lần khi materialize và không bao giờ được sửa, vì vậy nó **không chứa trạng thái run**. Trạng thái run nằm trong bộ nhớ của main process khi đang chạy và trong `result.json` khi kết thúc (mục 7).

### 6.1 Job ID

Job ID được main process sinh và validate theo một regex duy nhất, dùng chung cho tên thư mục, instruction ở mục 5.4 và IPC:

```text
^\d{4}-\d{2}-\d{2}-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?-\d{3}$
```

- phần ngày là ngày tạo theo giờ máy;
- phần slug lấy từ subject name: bỏ dấu tiếng Việt, chuyển ASCII thường, ký tự không phải chữ hoặc số thay bằng `-`, gộp `-` liên tiếp, bỏ `-` ở hai đầu, cắt tối đa 24 ký tự; slug rỗng thay bằng `job`;
- phần số là số thứ tự ba chữ số, tăng dần trong ngày, kiểm tra không trùng thư mục đang tồn tại.

Slug được phép chứa `-` ở giữa nhưng không ở hai đầu, nên regex có ba phần thay vì một lớp ký tự đơn giản. Đây là lý do `2026-09-28-richard-nixon-001` hợp lệ.

Job ID không khớp regex thì không được tạo thư mục và không được đưa vào command line.

### 6.2 Cấu trúc

Giá trị trong ngoặc nhọn ở ví dụ dưới là chỗ giữ chỗ cho người đọc, không phải giá trị hợp lệ. `sha256` thật là 64 ký tự hex thường.

```json
{
  "schemaVersion": 1,
  "jobId": "2026-09-28-richard-nixon-001",
  "createdAt": "2026-09-28T10:00:00Z",
  "executor": {
    "kind": "codex-cli",
    "minimumVersion": "0.158.0",
    "imageTool": "image_gen"
  },
  "subject": {
    "name": "Richard Nixon",
    "description": "Chibi historical character portrait",
    "pose": "Full body, standing upright",
    "expression": "Serious, no smile",
    "notes": "Clear silhouette"
  },
  "references": [
    {
      "label": "Image A",
      "role": "style",
      "path": "inputs/style.png",
      "originalName": "master-style.png",
      "mimeType": "image/png",
      "sizeBytes": 1834022,
      "sha256": "<64 lowercase hex characters>",
      "note": "Rough black outline, muted color and warm paper texture"
    },
    {
      "label": "Image B",
      "role": "identity",
      "path": "inputs/identity.jpg",
      "originalName": "nixon-front.jpg",
      "mimeType": "image/jpeg",
      "sizeBytes": 412880,
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
  "negativeConstraints": ["no text", "no watermark"],
  "source": {
    "preset": "chibi-master-v1",
    "anchor": "nixon-v1"
  },
  "promptPath": "prompt.md",
  "promptSha256": "<64 lowercase hex characters>"
}
```

Quy tắc:

- Các path trong packet luôn là relative path nằm trong job directory. Codex CLI không cần đọc file gốc bên ngoài job.
- `references` được sắp theo thứ tự role cố định; `label` trùng với nhãn trong `prompt.md` và với thứ tự `-i` ở mục 5.3.
- `mimeType` được xác định bằng magic bytes của file, không phải bằng đuôi file.
- `output` là **yêu cầu**, không phải đảm bảo: `image_gen` nhận kích thước, format và số lượng qua ngôn ngữ tự nhiên trong prompt. Giá trị thực tế do main đo và ghi vào `result.json`.
- `negativeConstraints` là danh sách đã gộp từ preset và người dùng, sau khi khử trùng lặp. Packet phải lưu nó thành field riêng chứ không chỉ để nó nằm trong văn bản `prompt.md`, nếu không thao tác duplicate ở mục 4.6 sẽ mất dữ liệu này.
- `promptSha256` là checksum của `prompt.md`, để main đối chiếu với prompt đã preview trên UI (mục 10).
- `executor` ghi lại điều kiện chạy, để log và recent jobs vẫn diễn giải được khi `CODEX_MIN_VERSION` thay đổi sau này.

## 7. Result contract

Có hai file kết quả với chủ sở hữu khác nhau:

| File | Ai ghi | Vai trò |
|---|---|---|
| `codex-result.json` | Codex CLI | báo cáo của executor: những ảnh đã tạo, hoặc lý do dừng |
| `result.json` | Electron main process | kết quả cuối cùng đã được kiểm chứng; là nguồn duy nhất mà UI và recent jobs đọc |

Main process **luôn** ghi `result.json`, kể cả khi Codex chưa hề chạy (lỗi preflight), bị cancel, hoặc `codex-result.json` thiếu hay sai. Codex không bao giờ ghi `result.json`. UI không đọc `codex-result.json`.

### 7.1 codex-result.json

```json
{
  "schemaVersion": 1,
  "jobId": "2026-09-28-richard-nixon-001",
  "status": "succeeded",
  "outputs": [
    { "path": "outputs/001.png" }
  ],
  "error": null
}
```

Khi thất bại, `status` là `failed`, `outputs` là mảng rỗng và `error` gồm `code` và `message`. Codex chỉ được dùng các mã `INVALID_JOB`, `MISSING_REFERENCE`, `IMAGE_CAPABILITY_UNAVAILABLE` và `GENERATION_FAILED`; mã khác bị main coi là `INVALID_RESULT`.

### 7.2 result.json

```json
{
  "schemaVersion": 1,
  "jobId": "2026-09-28-richard-nixon-001",
  "status": "succeeded",
  "startedAt": "2026-09-28T10:00:02Z",
  "completedAt": "2026-09-28T10:01:12Z",
  "executor": {
    "codexVersion": "0.158.0",
    "executable": "C:\\Users\\<user>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex-x86_64-pc-windows-msvc.exe",
    "exitCode": 0,
    "signal": null
  },
  "outputs": [
    {
      "path": "outputs/001.png",
      "mimeType": "image/png",
      "width": 1024,
      "height": 1365,
      "sizeBytes": 1522311,
      "sha256": "<64 lowercase hex characters>"
    }
  ],
  "warnings": [],
  "promptPath": "prompt.md",
  "error": null
}
```

Mọi giá trị trong `outputs` do main đo trực tiếp từ file: `mimeType` từ magic bytes, `width` và `height` từ header ảnh, `sha256` và `sizeBytes` từ nội dung. Giá trị Codex khai trong `codex-result.json` không được copy sang.

### 7.3 Quy tắc verify

Bổ sung cho mục 5.6, áp dụng trong trạng thái `verifying`:

- `codex-result.json` phải hợp lệ theo schema; thiếu hoặc sai thì `INVALID_RESULT`.
- Mỗi output path sau khi normalize phải nằm trong `outputs/` của job, là file thường, không phải symlink, đọc được và đúng magic bytes PNG, JPEG hoặc WebP; vi phạm thì `INVALID_RESULT`.
- `status` là `succeeded` trong `codex-result.json` nhưng `outputs` rỗng thì `INVALID_RESULT`.
- File có trong `outputs/` nhưng không được khai trong `codex-result.json` bị bỏ qua và được ghi vào `warnings`.
- Kích thước, tỉ lệ hoặc format thực tế khác với `output` yêu cầu trong `job.json` không làm job thất bại; sai lệch được ghi vào `warnings` và UI hiển thị.
- Exit code khác 0 mà không có `codex-result.json` thì `GENERATION_FAILED`. Exit code 0 vẫn phải qua đủ các bước trên.
- Exit code 0 mà không có `codex-result.json` thì `INVALID_RESULT`, không phải `GENERATION_FAILED`: process kết thúc sạch nhưng không để lại báo cáo nào để tin.
- `status` là `succeeded` nhưng `error` khác `null`, hoặc `status` là `failed` nhưng `error` là `null`, đều là `INVALID_RESULT`. Schema cho phép cả hai nhưng chúng tự mâu thuẫn.
- `count` thực tế khác `output.count` yêu cầu cũng chỉ là `warnings`, cùng lý do với kích thước và format.

### 7.4 Mã lỗi

| Mã | Ai đặt | Ý nghĩa |
|---|---|---|
| `CODEX_NOT_FOUND` | main | không resolve được executable thật (mục 5.3) |
| `CODEX_VERSION_UNSUPPORTED` | main | phiên bản thấp hơn `CODEX_MIN_VERSION` |
| `CODEX_NOT_AUTHENTICATED` | main | `codex login status` trả exit code khác 0 |
| `CODEX_SANDBOX_UNAVAILABLE` | main | Codex báo không thể dựng sandbox trên máy này |
| `INVALID_JOB` | Codex hoặc main | job packet không hợp lệ |
| `MISSING_REFERENCE` | Codex hoặc main | reference khai trong `job.json` không tồn tại hoặc không đọc được |
| `IMAGE_CAPABILITY_UNAVAILABLE` | Codex | tool `image_gen` không có hoặc bị từ chối trong phiên |
| `GENERATION_FAILED` | Codex hoặc main | sinh ảnh thất bại, hoặc process thoát lỗi mà không có báo cáo |
| `INVALID_RESULT` | main | `codex-result.json` hoặc output không qua được verify |
| `CANCELLED` | main | người dùng bấm Cancel |
| `INTERRUPTED` | main | app khởi động lại và thấy job chưa có `result.json` |

`error.message` là thông báo ngắn dành cho người dùng, đã sanitize; log kỹ thuật nằm trong `events.jsonl`, `stderr.log` và `last-message.txt`. `status` trong `result.json` là một trong `succeeded`, `failed`, `cancelled`.

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
│        ├─ last-message.txt
│        ├─ codex-result.json
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

Run dùng đúng một bộ trạng thái, định nghĩa ở mục 5.5 và do main process đặt:

- `queued`;
- `preflight`;
- `running`;
- `verifying`;
- `succeeded`;
- `failed`;
- `cancelled`.

`succeeded`, `failed` và `cancelled` là trạng thái kết thúc; giá trị trong `result.json` và trong IPC progress phải trùng nhau. Chuỗi `activity` hiển thị trong `running` không phải trạng thái và không được dùng để rẽ nhánh logic.

Recent jobs hiển thị trạng thái đọc từ `result.json`. Job không có `result.json` và không nằm trong danh sách đang chạy của main được hiển thị là `failed` với mã `INTERRUPTED`.

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

Nguồn chính thức của OpenAI:

- [Developer commands — Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli): các flag của `codex exec` (`--json`, `--sandbox`, `-C`, `-i`, `--output-last-message`, `--skip-git-repo-check`), ghi chú `--full-auto` là deprecated, và các lệnh `codex login status`, `codex doctor`.
- [Windows sandbox — Codex](https://learn.chatgpt.com/docs/windows/windows-sandbox): yêu cầu Windows 10 build 1809 trở lên, setup elevated cần quyền admin, network phụ thuộc permissions mode.
- [Building a safe, effective sandbox to enable Codex on Windows — OpenAI](https://openai.com/index/building-codex-windows-sandbox/): kiến trúc sandbox native trên Windows.
- [imagegen SKILL.md — openai/codex](https://github.com/openai/codex/blob/main/codex-rs/skills/src/assets/samples/imagegen/SKILL.md): tool `image_gen` không cần `OPENAI_API_KEY`, ảnh lưu mặc định dưới `$CODEX_HOME`, edit mode chỉ dùng ảnh đã có trong context, output phải được copy vào workspace.
- [Issue #41216 — openai/codex](https://github.com/openai/codex/issues/41216): schema `codex exec --json` đổi ở bản 0.144 mà không có version marker.
- [@openai/codex trên npm](https://www.npmjs.com/package/@openai/codex): tra phiên bản mới nhất khi cập nhật `CODEX_MIN_VERSION`.
- [Testing Agent Skills Systematically with Evals — OpenAI Developers](https://developers.openai.com/blog/eval-skills): `codex exec` cho automation và JSONL với `--json`. Bài này không nói gì về sinh ảnh và dùng `--full-auto` theo cách đã cũ.

Tham khảo không chính thức, cần đối chiếu với nguồn chính thức trước khi dựa vào:

- [Image generation in Codex CLI: gpt-image-2 và skill $imagegen](https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/): mốc thời gian tool `image_gen` xuất hiện (khoảng 0.115 đến 0.117, tháng 3/2026) và gpt-image-2 là mặc định từ 21/4/2026.
- [Codex exec --json event cheatsheet](https://takopi.dev/reference/runners/codex/exec-json-cheatsheet/): danh sách event và item type của schema hiện tại.

Môi trường đã kiểm chứng ngày 2026-09-28 trên máy phát triển Windows 10 build 19045: Codex CLI cài qua npm là 0.27.0 và không có `image_gen`; bản mới nhất trên npm là 0.158.0; `codex` trong `PATH` là shim `codex.cmd`.