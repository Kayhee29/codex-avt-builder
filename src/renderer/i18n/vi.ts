/**
 * Every string the user sees (plan decision Q10).
 *
 * Display text is Vietnamese and lives here; code, identifiers, comments, log
 * messages and error codes stay English (AGENTS.md). Components import from
 * this module and never spell a display string inline, so the whole vocabulary
 * of the app can be reviewed in one file.
 *
 * The error map is typed `Record<IpcErrorCode, string>`, so a code added to
 * `src/shared/ipc-contract.ts` without a Vietnamese sentence here fails
 * `pnpm typecheck` rather than reaching a user as raw English.
 */
import type { IpcErrorCode } from '@shared/ipc-contract'
import type { RunState } from '@shared/progress'
import type { ReferenceRole } from '@shared/reference-roles'
import type { ImageFormat } from '@shared/schemas'

import type { BuilderStatus } from '../store/builder.ts'

/** The five reference slots of spec section 4.2, with their responsibilities. */
export const REFERENCE_ROLE_TEXT: Record<ReferenceRole, { name: string; description: string }> = {
  style: {
    name: 'Phong cách',
    description: 'Tỉ lệ, linework, palette, texture và ngôn ngữ render.'
  },
  identity: {
    name: 'Nhận diện',
    description: 'Gương mặt, tóc, tuổi và các đặc điểm nhận diện.'
  },
  outfit: {
    name: 'Trang phục',
    description: 'Thiết kế trang phục, chất liệu, màu sắc và phù hiệu.'
  },
  equipment: {
    name: 'Trang bị',
    description: 'Vật thể, vũ khí, tỉ lệ, chi tiết và cách cầm.'
  },
  extra: {
    name: 'Bổ sung',
    description: 'Một visual cue bổ sung có mô tả rõ ràng.'
  }
}

/** The five builder statuses of spec section 12. */
export const BUILDER_STATUS_TEXT: Record<BuilderStatus, string> = {
  clean: 'Chưa có thay đổi',
  dirty: 'Có thay đổi chưa lưu',
  saving: 'Đang lưu nháp',
  ready: 'Sẵn sàng tạo ảnh',
  invalid: 'Thiếu hoặc sai dữ liệu'
}

/** The seven run states of spec sections 5.5 and 12. Main owns these values. */
export const RUN_STATE_TEXT: Record<RunState, string> = {
  queued: 'Đang xếp hàng',
  preflight: 'Đang kiểm tra Codex',
  running: 'Đang chạy',
  verifying: 'Đang kiểm tra kết quả',
  succeeded: 'Thành công',
  failed: 'Thất bại',
  cancelled: 'Đã hủy'
}

/** The three output formats of `ImageFormatSchema`. */
export const IMAGE_FORMAT_TEXT: Record<ImageFormat, string> = {
  png: 'PNG',
  jpg: 'JPEG',
  webp: 'WebP'
}

/**
 * One Vietnamese sentence per error code.
 *
 * The code is the stable vocabulary; the English `message` that comes with it
 * is sanitized detail and is only ever shown as a secondary line.
 */
export const IPC_ERROR_TEXT: Record<IpcErrorCode, string> = {
  CODEX_NOT_FOUND: 'Không tìm thấy Codex CLI trên máy này.',
  CODEX_VERSION_UNSUPPORTED: 'Phiên bản Codex CLI đang cài quá cũ.',
  CODEX_NOT_AUTHENTICATED: 'Codex CLI chưa đăng nhập.',
  CODEX_SANDBOX_UNAVAILABLE: 'Sandbox của Codex không dùng được trên máy này.',
  INVALID_JOB: 'Job không hợp lệ nên không thể chạy.',
  MISSING_REFERENCE: 'Một ảnh tham chiếu không còn tồn tại.',
  IMAGE_CAPABILITY_UNAVAILABLE: 'Codex trên máy này không có khả năng tạo ảnh.',
  GENERATION_FAILED: 'Codex đã chạy nhưng không tạo được ảnh.',
  INVALID_RESULT: 'Kết quả Codex trả về không hợp lệ.',
  CANCELLED: 'Đã hủy theo yêu cầu.',
  INTERRUPTED: 'Job bị gián đoạn trước khi kết thúc.',
  INVALID_REQUEST: 'Yêu cầu gửi xuống không hợp lệ.',
  NOT_FOUND: 'Không tìm thấy dữ liệu được yêu cầu.',
  ALREADY_RUNNING: 'Đang có một job chạy, hãy đợi job đó kết thúc.',
  IO_ERROR: 'Không đọc hoặc ghi được dữ liệu trên đĩa.'
}

/** Everything else, grouped by the part of the UI that shows it. */
export const vi = {
  app: {
    title: 'Reference Image Studio',
    subtitle: 'Dựng job ảnh theo reference rồi giao cho Codex CLI'
  },

  layout: {
    characterDirection: 'Chỉ đạo nhân vật',
    referenceSlots: 'Ảnh tham chiếu',
    promptPreview: 'Xem trước prompt',
    presets: 'Preset',
    anchors: 'Anchor',
    recentJobs: 'Job gần đây',
    generate: 'Tạo ảnh',
    reserved: 'Phần này được hoàn thiện ở bước sau.'
  },

  form: {
    legendSubject: 'Nhân vật',
    legendOutput: 'Kết quả mong muốn',
    name: 'Tên nhân vật',
    namePlaceholder: 'Ví dụ: Nguyễn Văn A',
    description: 'Mô tả nhân vật',
    descriptionPlaceholder: 'Đặc điểm ổn định của nhân vật',
    pose: 'Pose',
    expression: 'Biểu cảm',
    notes: 'Ghi chú bố cục',
    negativeConstraints: 'Ràng buộc loại trừ',
    negativeConstraintsHint: 'Mỗi dòng một ràng buộc.',
    aspectRatio: 'Tỉ lệ khung hình',
    background: 'Nền',
    format: 'Định dạng file',
    count: 'Số lượng ảnh'
  },

  reference: {
    empty: 'Chưa chọn ảnh.',
    choose: 'Chọn ảnh',
    replace: 'Thay ảnh',
    remove: 'Gỡ ảnh',
    note: 'Ghi chú cho vai trò này',
    notePlaceholder: 'Điều cần lấy từ ảnh này',
    fileName: 'Tên tệp',
    sourcePath: 'Đường dẫn nguồn',
    dimensions: 'Kích thước',
    noThumbnail: 'Không có ảnh thu nhỏ.',
    missing: 'Tệp gốc không còn tồn tại. Hãy chọn lại ảnh cho vai trò này.',
    missingBlocksGenerate: 'Còn ảnh tham chiếu không tồn tại nên chưa thể tạo ảnh.',
    pickFailed: 'Không mở được hộp thoại chọn ảnh.'
  },

  preview: {
    heading: 'Prompt',
    mapping: 'Bảng ánh xạ reference',
    mappingEmpty: 'Chưa có ảnh tham chiếu nào được đính kèm.',
    checksum: 'Checksum prompt',
    checksumPending: 'đang tính',
    columnLabel: 'Nhãn',
    columnRole: 'Vai trò',
    columnFile: 'Tệp',
    columnNote: 'Ghi chú',
    failed: 'Không dựng được prompt từ dữ liệu hiện tại.',
    noCodex: 'Xem trước prompt không chạy Codex và không tạo ảnh.'
  },

  draft: {
    loadFailed: 'Không đọc được bản nháp đã lưu.',
    saveFailed: 'Không lưu được bản nháp.',
    savedAt: 'Đã lưu lúc'
  },

  jobs: {
    listFailed: 'Không đọc được danh sách job.',
    empty: 'Chưa có job nào.'
  }
} as const

/** The Vietnamese name of a builder status (spec section 12). */
export function builderStatusText(status: BuilderStatus): string {
  return BUILDER_STATUS_TEXT[status]
}

/** The Vietnamese name of a reference role (spec section 4.2). */
export function referenceRoleName(role: ReferenceRole): string {
  return REFERENCE_ROLE_TEXT[role].name
}

/** The Vietnamese sentence for an error code (spec section 7.4). */
export function ipcErrorText(code: IpcErrorCode): string {
  return IPC_ERROR_TEXT[code]
}
