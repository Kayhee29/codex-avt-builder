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
import type {
  AspectRatioOptionId,
  BackgroundOptionId,
  ExpressionOptionId,
  PoseOptionId
} from '@shared/direction-options'
import type { IpcErrorCode } from '@shared/ipc-contract'
import type { PresetField } from '@shared/preset-merge'
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

/**
 * One Vietnamese label per field a preset may change (spec section 4.4).
 *
 * Typed `Record<PresetField, string>`, so a field added to `PRESET_FIELDS` in
 * `src/shared/preset-merge.ts` fails `pnpm typecheck` instead of appearing in
 * the apply dialog as a raw identifier.
 */
export const PRESET_FIELD_TEXT: Record<PresetField, string> = {
  'output.aspectRatio': 'Tỉ lệ khung hình',
  'output.background': 'Nền',
  'output.format': 'Định dạng file',
  'subject.pose': 'Pose',
  'subject.expression': 'Biểu cảm',
  'subject.notes': 'Ghi chú bố cục',
  negativeConstraints: 'Ràng buộc loại trừ',
  'references.style': 'Ảnh phong cách',
  'references.style.note': 'Ghi chú ảnh phong cách',
  'references.outfit.note': 'Ghi chú ảnh trang phục',
  'references.equipment.note': 'Ghi chú ảnh trang bị',
  'references.extra.note': 'Ghi chú ảnh bổ sung',
  'source.preset': 'Preset đang dùng'
}

/**
 * One Vietnamese label per predefined choice in `src/shared/direction-options.ts`.
 *
 * Each is typed `Record<…OptionId, string>`, so an option added there without a
 * label here fails `pnpm typecheck` instead of showing its id in a dropdown.
 * The English the option carries is what reaches `prompt.md`; this is only what
 * the user reads.
 */
export const POSE_OPTION_TEXT: Record<PoseOptionId, string> = {
  'standing-relaxed': 'Đứng thả lỏng',
  'standing-front': 'Đứng thẳng, nhìn thẳng',
  heroic: 'Dáng anh hùng',
  'arms-crossed': 'Khoanh tay',
  'hands-on-hips': 'Chống nạnh',
  'hands-in-pockets': 'Tay đút túi',
  walking: 'Đang bước tới',
  running: 'Chạy',
  jumping: 'Nhảy lên',
  'sitting-chair': 'Ngồi ghế',
  'sitting-cross-legged': 'Ngồi xếp bằng',
  crouching: 'Ngồi xổm',
  kneeling: 'Quỳ một gối',
  leaning: 'Tựa tường',
  'lying-down': 'Nằm chống khuỷu tay',
  'looking-over-shoulder': 'Ngoái nhìn qua vai',
  'back-turned': 'Quay lưng',
  waving: 'Vẫy tay',
  pointing: 'Chỉ tay về phía trước',
  reaching: 'Vươn tay ra',
  'combat-stance': 'Thủ thế chiến đấu',
  meditating: 'Ngồi thiền',
  'portrait-bust': 'Chân dung bán thân',
  'three-quarter': 'Góc ba phần tư, nửa người',
  profile: 'Nhìn nghiêng'
}

export const EXPRESSION_OPTION_TEXT: Record<ExpressionOptionId, string> = {
  neutral: 'Bình thản',
  'slight-smile': 'Cười mỉm',
  'warm-smile': 'Cười ấm áp',
  grin: 'Cười toe',
  laughing: 'Cười lớn',
  serious: 'Nghiêm túc',
  stern: 'Nghiêm khắc',
  determined: 'Quyết tâm',
  confident: 'Tự tin',
  smug: 'Đắc ý',
  angry: 'Giận',
  furious: 'Giận dữ, quát',
  sad: 'Buồn',
  crying: 'Khóc',
  worried: 'Lo lắng',
  fearful: 'Sợ hãi',
  surprised: 'Ngạc nhiên',
  shocked: 'Sững sờ',
  curious: 'Tò mò',
  thoughtful: 'Trầm ngâm',
  bored: 'Chán',
  sleepy: 'Buồn ngủ',
  shy: 'Ngại ngùng',
  embarrassed: 'Xấu hổ',
  playful: 'Tinh nghịch',
  calm: 'Điềm tĩnh',
  proud: 'Kiêu hãnh',
  disgusted: 'Ghê tởm'
}

export const ASPECT_RATIO_OPTION_TEXT: Record<AspectRatioOptionId, string> = {
  square: 'Vuông 1:1',
  'portrait-4-5': 'Dọc 4:5',
  'portrait-3-4': 'Dọc 3:4',
  'portrait-2-3': 'Dọc 2:3',
  'portrait-9-16': 'Dọc 9:16',
  'landscape-4-3': 'Ngang 4:3',
  'landscape-3-2': 'Ngang 3:2',
  'landscape-16-9': 'Ngang 16:9'
}

export const BACKGROUND_OPTION_TEXT: Record<BackgroundOptionId, string> = {
  transparent: 'Trong suốt',
  white: 'Trắng',
  black: 'Đen',
  'flat-colour': 'Một màu phẳng',
  'soft-gradient': 'Gradient nhẹ',
  studio: 'Phông studio',
  'simple-environment': 'Bối cảnh đơn giản',
  blurred: 'Xoá phông',
  'match-style': 'Theo ảnh phong cách'
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
    codex: 'Trạng thái Codex CLI',
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
    count: 'Số lượng ảnh',
    unspecified: 'Không chỉ định',
    custom: 'Khác…',
    customPose: 'Pose tự nhập',
    customExpression: 'Biểu cảm tự nhập',
    required: 'bắt buộc',
    requiredHint: 'Cần điền để tạo được ảnh.'
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
    empty: 'Chưa có job nào.',
    columnThumbnail: 'Ảnh',
    columnJob: 'Job',
    columnSubject: 'Nhân vật',
    columnState: 'Trạng thái',
    columnTime: 'Thời gian',
    columnPreset: 'Preset',
    columnAnchor: 'Anchor',
    columnActions: 'Thao tác',
    openFolder: 'Mở thư mục',
    duplicate: 'Nhân bản',
    none: '—',
    noThumbnail: 'Chưa có ảnh.',
    warnings: 'Cảnh báo',
    actionFailed: 'Không thực hiện được thao tác này.',
    duplicated: 'Đã dựng nháp mới từ job này.'
  },

  generate: {
    button: 'Tạo ảnh',
    starting: 'Đang gửi job…',
    blockedInvalid: 'Còn thiếu dữ liệu bắt buộc nên chưa tạo ảnh được.',
    blockedMissing: 'Chưa tạo ảnh được, còn thiếu:',
    blockedRunning: 'Đang có một job chạy.',
    failed: 'Không bắt đầu được job.',
    checksumFailed: 'Chưa tính được checksum của prompt nên chưa gửi job.',
    idle: 'Phiên này chưa chạy job nào.',
    jobLabel: 'Job',
    activity: 'Hoạt động',
    cancel: 'Hủy job',
    cancelFailed: 'Không hủy được job.'
  },

  preflight: {
    checking: 'Đang kiểm tra Codex CLI…',
    ok: 'Codex CLI sẵn sàng và đã đăng nhập.',
    version: 'Phiên bản',
    executable: 'Đường dẫn',
    recheck: 'Kiểm tra lại',
    executableLabel: 'Đường dẫn Codex CLI',
    executableHint: 'Chỉ nhận file thực thi thật; trên Windows phải là đuôi .exe.',
    save: 'Lưu đường dẫn',
    saveFailed: 'Không lưu được cài đặt.',
    failed: 'Không kiểm tra được Codex CLI.'
  },

  closeGuard: {
    running: 'Đang có job chạy. Đóng cửa sổ bây giờ sẽ hủy job đó.'
  },

  common: {
    cancel: 'Hủy',
    emptyValue: '(trống)'
  },

  library: {
    listFailed: 'Không đọc được preset và anchor đã lưu.',
    saveFailed: 'Không lưu được.',
    deleteFailed: 'Không xóa được.',

    presetsEmpty: 'Chưa có preset nào.',
    presetName: 'Tên preset',
    presetNamePlaceholder: 'Ví dụ: Chibi master',
    savePreset: 'Lưu preset từ draft',
    applyPreset: 'Áp dụng',
    deletePreset: 'Xóa',

    applyTitle: 'Áp preset lên draft hiện tại',
    applyMessage:
      'Những trường sau sẽ thay đổi. Ảnh nhận diện và ghi chú của nó không bị đụng tới.',
    applyEmpty: 'Preset này không làm thay đổi trường nào.',
    applyConfirm: 'Áp preset',
    applyColumnField: 'Trường',
    applyColumnFrom: 'Hiện tại',
    applyColumnTo: 'Sau khi áp',

    deleteTitle: 'Xóa preset',
    deleteMessage: 'Preset và ảnh phong cách đã lưu kèm sẽ bị xóa khỏi workspace.',
    deleteConfirm: 'Xóa preset',

    anchorsEmpty: 'Chưa có anchor nào.',
    anchorNew: 'Anchor mới',
    anchorName: 'Tên anchor',
    anchorNamePlaceholder: 'Ví dụ: Nguyễn Văn A',
    saveAnchor: 'Lưu anchor từ draft',
    anchorTarget: 'Lưu vào',
    loadAnchor: 'Tạo draft mới',
    immutableTraits: 'Đặc điểm cố định',
    mutableTraits: 'Đặc điểm có thể đổi',
    traitsHint: 'Mỗi dòng một đặc điểm.',
    approvedOutput: 'Ảnh đã duyệt',
    approvedOutputNone: 'Không đính kèm',
    approvedOutputOption: 'ảnh',
    needIdentity: 'Cần có ảnh nhận diện trong draft trước khi lưu anchor.',
    mutableHint: 'Trang phục, trang bị, pose và biểu cảm luôn để trống cho draft mới.',

    loadAnchorTitle: 'Tạo draft mới từ anchor',
    loadAnchorMessage:
      'Draft hiện tại sẽ bị thay bằng một draft mới dựng từ anchor này. Nội dung đang nhập sẽ mất.',
    loadAnchorConfirm: 'Tạo draft mới'
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
