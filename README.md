# Reference Image Studio

Ứng dụng desktop local, một người dùng, để dựng job sinh ảnh theo quy trình
reference-first rồi giao cho **Codex CLI** thực thi.

Ứng dụng gồm hai lớp tách biệt:

1. **UI Builder** thu thập toàn bộ ý định của người dùng: subject, pose,
   expression, output settings, preset, anchor và năm ảnh reference theo role
   (`style`, `identity`, `outfit`, `equipment`, `extra`).
2. **Codex CLI** chỉ xuất hiện ở bước cuối. Khi bấm **Generate**, main process
   đóng gói job thành một thư mục bất biến rồi chạy `codex exec` cục bộ; Codex
   dùng tool `image_gen` có sẵn để sinh ảnh.

Project **không** gọi OpenAI API hay image API. Không có API key, không có HTTP
backend, không có API route và không có model SDK trong repo. Nếu Codex CLI hoặc
capability sinh ảnh không khả dụng, job dừng với mã lỗi rõ ràng, không có
fallback.

Tài liệu gốc:

- Spec: [`docs/superpowers/specs/2026-09-28-reference-image-studio-design.md`](docs/superpowers/specs/2026-09-28-reference-image-studio-design.md)
- Plan: [`docs/superpowers/plans/2026-09-28-reference-image-studio-implementation.md`](docs/superpowers/plans/2026-09-28-reference-image-studio-implementation.md)
- Quy ước cho agent làm việc trong repo: [`AGENTS.md`](AGENTS.md)

## Điều kiện tiên quyết

| Hạng mục        | Yêu cầu                                                  | Trạng thái máy phát triển ngày 2026-09-28 |
| --------------- | -------------------------------------------------------- | ----------------------------------------- |
| Node.js         | 22 trở lên                                               | 25.2.1                                    |
| pnpm            | 9 trở lên                                                | 11.2.2                                    |
| Codex CLI       | lớn hơn hoặc bằng `CODEX_MIN_VERSION` = **0.158.0**      | **0.27.0, phải nâng cấp**                 |
| Đăng nhập Codex | `codex login status` trả exit code 0                     | đã đăng nhập bằng ChatGPT                 |
| Windows         | Windows 10 build 1809 trở lên, sandbox elevated đã setup | build 19045, sandbox chưa kiểm tra        |

Tool `image_gen` chỉ có trên các bản Codex CLI từ khoảng 0.117 (tháng 3/2026)
trở lên. Bản 0.27.0 đang cài trên máy **không sinh được ảnh**. Nâng cấp thủ công
trước khi chạy smoke test:

```bash
npm install -g @openai/codex@latest
codex --version
codex login status
codex doctor
```

Toàn bộ giai đoạn phát triển từ Phase 0 đến Phase 5 của plan chạy được với Codex
0.27.0, vì test tự động dùng fake Codex và không bao giờ gọi CLI thật.

## Cách chạy

```bash
pnpm install     # cài dependency
pnpm dev         # chạy app (electron-vite dev)
```

Các lệnh khác:

| Lệnh                  | Tác dụng                                                    |
| --------------------- | ----------------------------------------------------------- |
| `pnpm build`          | build main, preload và renderer vào `out/`                  |
| `pnpm typecheck`      | `tsc --noEmit` cho project node và project web              |
| `pnpm lint`           | eslint                                                      |
| `pnpm format`         | prettier                                                    |
| `pnpm test`           | vitest (unit và integration)                                |
| `pnpm test:e2e`       | Playwright end-to-end (placeholder tới Task 6.1)            |
| `pnpm export-schemas` | sinh lại `schemas/*.json` từ zod (placeholder tới Task 1.2) |

Trước mỗi commit: `pnpm typecheck`, `pnpm lint` và `pnpm test` phải xanh.

Dữ liệu runtime nằm trong `workspace/`: `drafts/`, `presets/`, `anchors/`,
`jobs/`. Draft, job và ảnh sinh ra nằm trong `.gitignore`; metadata JSON của
preset và anchor vẫn track được.

## Smoke test thủ công với Codex thật

Đây là bước **thủ công, opt-in** (plan Task 6.4). Test tự động không bao giờ gọi
Codex thật và không tiêu tốn generation. Chỉ chạy sau khi đã nâng Codex CLI lên
`0.158.0` trở lên.

1. Chạy `pnpm dev`. Kiểm tra banner preflight báo đúng phiên bản Codex và trạng
   thái đăng nhập.
2. Tạo job với hai reference (`style` và `identity`), điền subject name và
   description, bấm **Generate**, theo dõi progress đi qua `queued` →
   `preflight` → `running` → `verifying` → `succeeded`.
3. Mở thư mục job và kiểm tra có đủ:

   ```text
   workspace/jobs/<job-id>/
     job.json
     prompt.md
     run-instructions.md
     inputs/
     outputs/            ít nhất một ảnh
     events.jsonl
     stderr.log
     last-message.txt
     codex-result.json
     result.json
   ```

4. Tắt mạng rồi bấm **Generate** lần nữa. Kỳ vọng job kết thúc `failed` với mã
   lỗi rõ ràng, không có fallback sang API.
5. Ghi kết quả, phiên bản Codex và mọi khác biệt so với spec vào mục 17 của
   spec.

Nếu bước 2 liên tục trả `IMAGE_CAPABILITY_UNAVAILABLE`: chạy `codex doctor` và
thử `$imagegen` trong chế độ interactive để tách lỗi CLI với lỗi tài khoản.
Không thêm fallback gọi API.

## Trạng thái

Phase 0 của plan đã xong: khung electron-vite, `AGENTS.md`, `README.md` và
template `instructions/run-job.md`. Luồng Generate, preset, anchor và recent jobs
được hiện thực ở các phase sau, nên các bước 1–4 của smoke test ở trên chỉ chạy
được khi Phase 5 hoàn tất.
