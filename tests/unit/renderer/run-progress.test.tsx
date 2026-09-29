// @vitest-environment jsdom
/**
 * Generate, live progress and recent jobs (plan Task 5.5, spec sections 4.6,
 * 5.5, 10 and 12).
 *
 * The run states under test are the ones the main process sends; nothing here
 * derives a state from anything (spec section 5.5). The two decisions the task
 * turns on are checked directly: plan decision Q24, where Generate is enabled
 * by a valid state rather than by the autosave having landed, and plan decision
 * Q20, where Cancel works from `queued` and `preflight` — preflight alone can
 * take twenty seconds — and stops at `verifying`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import { BuilderStateInputSchema } from '@shared/ipc-contract'
import type { JobPacket } from '@shared/schemas'

import { GenerateBar } from '../../../src/renderer/components/GenerateBar.tsx'
import { PreflightBanner } from '../../../src/renderer/components/PreflightBanner.tsx'
import { RecentJobs } from '../../../src/renderer/components/RecentJobs.tsx'
import { RunProgress } from '../../../src/renderer/components/RunProgress.tsx'
import { selectBuilderStatus, useBuilderStore } from '../../../src/renderer/store/builder.ts'
import { useJobsStore } from '../../../src/renderer/store/jobs.ts'

import {
  installFakeBridge,
  makeJobSummary,
  makeProgress,
  makeReference,
  makeValidState,
  type FakeBridge
} from './harness.ts'

const JOB_ID = '2026-09-28-nguyen-van-a-001'

let fake: FakeBridge

function builder(): ReturnType<typeof useBuilderStore.getState> {
  return useBuilderStore.getState()
}

function jobs(): ReturnType<typeof useJobsStore.getState> {
  return useJobsStore.getState()
}

/** Pushes one progress event the way `jobs.onProgress` would. */
function progress(
  state: ReturnType<typeof makeProgress>['state'],
  seq: number,
  activity?: string
): void {
  act(() => {
    jobs().applyProgress(
      makeProgress({ jobId: JOB_ID, state, seq, ...(activity === undefined ? {} : { activity }) })
    )
  })
}

function cancelButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Hủy job' }) as HTMLButtonElement
}

function generateButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Tạo ảnh' }) as HTMLButtonElement
}

/** A valid draft whose prompt checksum has been computed. */
async function readyDraft(): Promise<void> {
  builder().adoptState(makeValidState())
  await waitFor(() => {
    expect(builder().promptSha256).not.toBeNull()
  })
}

beforeEach(() => {
  fake = installFakeBridge()
  builder().reset()
  jobs().reset()
})

afterEach(() => {
  cleanup()
  builder().reset()
  jobs().reset()
  vi.unstubAllGlobals()
})

describe('the Generate button (plan decision Q24)', () => {
  it('is on for a valid state that the autosave has not stored yet', async () => {
    await readyDraft()
    act(() => {
      builder().setSubjectField('pose', 'đứng thẳng')
    })
    render(<GenerateBar />)

    // Not `ready`: the 800 ms autosave window is still open. Q24 says that is
    // an artefact of the save and must not disable the button.
    expect(selectBuilderStatus(builder())).toBe('dirty')
    expect(generateButton().disabled).toBe(false)
  })

  it('is off while the state is invalid, and names the fields that are empty', () => {
    render(<GenerateBar />)

    // Since the output settings became dropdowns they cannot be invalid, so an
    // invalid draft is almost always one of these two fields. Saying which one
    // beats "something required is missing" when the form is this long.
    expect(generateButton().disabled).toBe(true)
    expect(
      screen.getByText('Chưa tạo ảnh được, còn thiếu: Tên nhân vật, Mô tả nhân vật.')
    ).toBeDefined()
  })

  it('falls back to the general reason when the gap is not a named field', () => {
    act(() => {
      builder().setSubjectField('name', 'Trần Văn B')
      builder().setSubjectField('description', 'Nam, tóc ngắn')
      // Not reachable through the dropdown any more, but the store API still
      // allows it, and the hint must not claim a field is empty when none is.
      builder().setOutput('count', 0)
    })
    render(<GenerateBar />)

    expect(generateButton().disabled).toBe(true)
    expect(screen.getByText('Còn thiếu dữ liệu bắt buộc nên chưa tạo ảnh được.')).toBeDefined()
  })

  it('is off while a reference file has gone missing', async () => {
    await readyDraft()
    act(() => {
      builder().putReference(makeReference('style', { missing: true }))
    })
    render(<GenerateBar />)

    expect(generateButton().disabled).toBe(true)
    expect(screen.getByText('Còn ảnh tham chiếu không tồn tại nên chưa thể tạo ảnh.')).toBeDefined()
  })

  it('flushes the draft, then sends the state and the prompt checksum', async () => {
    await readyDraft()
    fake.answer('jobs.generate', { ok: true, data: { jobId: JOB_ID } })
    render(<GenerateBar />)

    fireEvent.click(generateButton())

    await waitFor(() => {
      expect(fake.channels['jobs.generate']).toHaveBeenCalledTimes(1)
    })

    const request = fake.channels['jobs.generate'].mock.calls[0]?.[0] as {
      state: unknown
      promptSha256: string
    }

    expect(fake.channels['draft.save']).toHaveBeenCalled()
    expect(BuilderStateInputSchema.safeParse(request.state).success).toBe(true)
    expect(request.promptSha256).toBe(builder().promptSha256)
  })

  it('locks itself while a run is in flight (spec section 10)', async () => {
    await readyDraft()
    fake.answer('jobs.generate', { ok: true, data: { jobId: JOB_ID } })
    render(<GenerateBar />)

    fireEvent.click(generateButton())

    await waitFor(() => {
      expect(generateButton().disabled).toBe(true)
    })
    expect(screen.getByText('Đang có một job chạy.')).toBeDefined()

    progress('succeeded', 9)

    await waitFor(() => {
      expect(generateButton().disabled).toBe(false)
    })
  })

  it('reports a Generate the main process refused', async () => {
    await readyDraft()
    fake.answer('jobs.generate', {
      ok: false,
      code: 'ALREADY_RUNNING',
      message: 'a job is already running'
    })
    render(<GenerateBar />)

    fireEvent.click(generateButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Đang có một job chạy, hãy đợi job đó kết thúc.'
      )
    })
  })
})

describe('run progress (spec sections 5.5 and 12)', () => {
  it('shows every state the main process reports, in order', () => {
    render(<RunProgress />)

    expect(screen.getByText('Phiên này chưa chạy job nào.')).toBeDefined()

    for (const [index, expected] of [
      ['queued', 'Đang xếp hàng'],
      ['preflight', 'Đang kiểm tra Codex'],
      ['running', 'Đang chạy'],
      ['verifying', 'Đang kiểm tra kết quả'],
      ['succeeded', 'Thành công']
    ].entries()) {
      progress(expected[0] as 'queued', index + 1)

      expect(screen.getByText(expected[1] as string)).toBeDefined()
    }
  })

  it('shows the activity line that came with the event', () => {
    render(<RunProgress />)
    progress('running', 1, 'Đang gọi image_gen')

    expect(screen.getByText('Hoạt động: Đang gọi image_gen')).toBeDefined()
  })

  it('keeps the outcome on screen after the run ends', () => {
    render(<RunProgress />)
    progress('failed', 4)

    expect(jobs().activeJobId).toBeNull()
    expect(screen.getByText('Thất bại')).toBeDefined()
  })
})

describe('cancel (spec section 5.5, plan decision Q20)', () => {
  it('is available as soon as jobs.generate answers, before any event', async () => {
    await readyDraft()
    fake.answer('jobs.generate', { ok: true, data: { jobId: JOB_ID } })
    fake.answer('jobs.cancel', { ok: true, data: { cancelled: true } })
    render(
      <>
        <GenerateBar />
      </>
    )

    fireEvent.click(generateButton())

    await waitFor(() => {
      expect(jobs().activeJobId).toBe(JOB_ID)
    })
    expect(cancelButton().disabled).toBe(false)

    fireEvent.click(cancelButton())

    await waitFor(() => {
      expect(fake.channels['jobs.cancel']).toHaveBeenCalledWith({ jobId: JOB_ID })
    })
  })

  it('is on in queued, preflight and running, and off from verifying onwards', () => {
    render(<RunProgress />)

    progress('queued', 1)
    expect(cancelButton().disabled).toBe(false)

    progress('preflight', 2)
    expect(cancelButton().disabled).toBe(false)

    progress('running', 3)
    expect(cancelButton().disabled).toBe(false)

    // The run has already finished; spec section 5.5 ignores a cancel here.
    progress('verifying', 4)
    expect(cancelButton().disabled).toBe(true)

    progress('succeeded', 5)
    expect(cancelButton().disabled).toBe(true)
  })

  it('reports a cancel the main process refused', async () => {
    fake.answer('jobs.cancel', { ok: false, code: 'NOT_FOUND', message: 'no such run' })
    render(<RunProgress />)
    progress('running', 1)

    fireEvent.click(cancelButton())

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Không tìm thấy dữ liệu được yêu cầu.'
      )
    })
  })
})

describe('recent jobs (spec section 4.6)', () => {
  it('shows every column spec section 4.6 asks for', () => {
    act(() => {
      useJobsStore.setState({
        jobs: [
          makeJobSummary({
            preset: 'chibi-master-v1',
            anchor: 'nguyen-van-a',
            thumbnailDataUrl: 'data:image/png;base64,AAAA'
          })
        ]
      })
    })
    render(<RecentJobs />)

    expect(
      screen.getAllByRole('columnheader').map((cell: HTMLElement) => cell.textContent)
    ).toEqual(['Ảnh', 'Job', 'Nhân vật', 'Trạng thái', 'Thời gian', 'Preset', 'Anchor', 'Thao tác'])

    const row = within(screen.getAllByRole('row')[1] as HTMLElement)

    expect(row.getByRole('img', { name: JOB_ID })).toBeDefined()
    expect(row.getByText(JOB_ID)).toBeDefined()
    expect(row.getByText('Nguyễn Văn A')).toBeDefined()
    expect(row.getByText('Thành công')).toBeDefined()
    expect(row.getByText('chibi-master-v1')).toBeDefined()
    expect(row.getByText('nguyen-van-a')).toBeDefined()
  })

  // Spec section 12: a job with no result.json that main is not running.
  it('shows a job reported INTERRUPTED as failed', () => {
    act(() => {
      useJobsStore.setState({
        jobs: [makeJobSummary({ state: 'failed', errorCode: 'INTERRUPTED', outputCount: 0 })]
      })
    })
    render(<RecentJobs />)

    expect(screen.getByText('Thất bại')).toBeDefined()
    expect(screen.getByText('Job bị gián đoạn trước khi kết thúc.')).toBeDefined()
  })

  it('shows the result warnings under the thumbnail (spec section 7.3)', () => {
    act(() => {
      useJobsStore.setState({
        jobs: [makeJobSummary({ warnings: ['Ảnh 1 có tỉ lệ 1:1 thay vì 3:4'] })]
      })
    })
    render(<RecentJobs />)

    const warnings = screen.getByRole('list', { name: 'Cảnh báo' })

    expect(within(warnings).getByText('Ảnh 1 có tỉ lệ 1:1 thay vì 3:4')).toBeDefined()
  })

  it('opens the job folder by job id alone', async () => {
    act(() => {
      useJobsStore.setState({ jobs: [makeJobSummary()] })
    })
    fake.answer('jobs.openFolder', { ok: true, data: { opened: true } })
    render(<RecentJobs />)

    fireEvent.click(screen.getByRole('button', { name: 'Mở thư mục' }))

    await waitFor(() => {
      expect(fake.channels['jobs.openFolder']).toHaveBeenCalledWith({ jobId: JOB_ID })
    })
  })
})

describe('duplicating a job (spec section 10)', () => {
  const PACKET: JobPacket = {
    schemaVersion: 1,
    jobId: JOB_ID,
    createdAt: '2026-09-28T10:00:00.000Z',
    executor: { kind: 'codex-cli', minimumVersion: '0.158.0', imageTool: 'image_gen' },
    subject: { name: 'Nguyễn Văn A', description: 'Nam, ngoài 50 tuổi', pose: 'đứng thẳng' },
    references: [
      {
        label: 'Image A',
        role: 'style',
        path: 'inputs/style.png',
        originalName: 'master-style.png',
        mimeType: 'image/png',
        sizeBytes: 1024,
        sha256: 'a'.repeat(64),
        note: 'nét thô'
      }
    ],
    output: { aspectRatio: '3:4', background: 'giấy ấm', format: 'png', count: 2 },
    negativeConstraints: ['không chữ', 'không watermark'],
    source: { preset: 'chibi-master-v1', anchor: null },
    promptPath: 'prompt.md',
    promptSha256: 'b'.repeat(64)
  }

  beforeEach(() => {
    act(() => {
      useJobsStore.setState({ jobs: [makeJobSummary()] })
    })
    fake.answer('jobs.get', {
      ok: true,
      data: {
        job: PACKET,
        result: null,
        references: [makeReference('style', { originalName: 'master-style.png', note: 'nét thô' })]
      }
    })
  })

  it('rebuilds a draft from the packet and the handles main minted', async () => {
    render(<RecentJobs />)
    fireEvent.click(screen.getByRole('button', { name: 'Nhân bản' }))

    await waitFor(() => {
      expect(builder().state.subject.name).toBe('Nguyễn Văn A')
    })

    const state = builder().state

    expect(state.subject.pose).toBe('đứng thẳng')
    expect(state.output).toEqual(PACKET.output)
    expect(state.source).toEqual(PACKET.source)
    expect(state.references).toHaveLength(1)
    expect(state.references[0]?.referenceId).toBe(makeReference('style').referenceId)
    expect(state.references[0]?.note).toBe('nét thô')
  })

  it('takes the references as handles and never as a path', async () => {
    render(<RecentJobs />)
    fireEvent.click(screen.getByRole('button', { name: 'Nhân bản' }))

    await waitFor(() => {
      expect(builder().state.references).toHaveLength(1)
    })

    // `job.json` names its inputs by relative path; none of that reaches the
    // builder, which only ever holds the opaque handle (plan decision Q3).
    expect(JSON.stringify(builder().state)).not.toContain('inputs/')
  })

  it('saves the new draft and restores the negative constraints from the packet', async () => {
    render(<RecentJobs />)
    fireEvent.click(screen.getByRole('button', { name: 'Nhân bản' }))

    await waitFor(() => {
      expect(fake.channels['draft.save']).toHaveBeenCalledTimes(1)
    })

    // `job.json` stores them as their own field (spec section 6.2), so a
    // duplicate keeps every constraint the original job ran with.
    expect(builder().state.negativeConstraints).toEqual(['không chữ', 'không watermark'])
    expect(screen.getByText('Đã dựng nháp mới từ job này.')).toBeDefined()
  })

  it('reports a job the main process would not read back', async () => {
    fake.answer('jobs.get', { ok: false, code: 'NOT_FOUND', message: 'gone' })
    render(<RecentJobs />)

    fireEvent.click(screen.getByRole('button', { name: 'Nhân bản' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'Không tìm thấy dữ liệu được yêu cầu.'
      )
    })
    expect(builder().state.subject.name).toBe('')
  })
})

describe('the preflight banner (spec section 5.3)', () => {
  it('reports the version when the checks pass', async () => {
    fake.answer('system.preflight', {
      ok: true,
      data: { preflight: { ok: true, version: '0.158.0', executable: 'C:\\codex\\codex.exe' } }
    })
    render(<PreflightBanner />)

    await waitFor(() => {
      expect(screen.getByText(/Codex CLI sẵn sàng và đã đăng nhập\./)).toBeDefined()
    })
    expect(screen.getByText(/0\.158\.0/)).toBeDefined()
    expect(screen.getByText(/C:\\codex\\codex\.exe/)).toBeDefined()
  })

  it('names the failure and offers the executable override (plan decision Q7)', async () => {
    fake.answer('system.preflight', {
      ok: true,
      data: {
        preflight: {
          ok: false,
          code: 'CODEX_VERSION_UNSUPPORTED',
          message: 'codex-cli 0.27.0 is older than 0.158.0'
        }
      }
    })
    fake.answer('system.getSettings', {
      ok: true,
      data: { settings: { schemaVersion: 1, codexExecutable: null } }
    })
    fake.answer('system.setSettings', {
      ok: true,
      data: { settings: { schemaVersion: 1, codexExecutable: 'C:\\codex\\codex.exe' } }
    })
    render(<PreflightBanner />)

    await waitFor(() => {
      expect(screen.getByText(/Phiên bản Codex CLI đang cài quá cũ\./)).toBeDefined()
    })

    fireEvent.change(screen.getByLabelText('Đường dẫn Codex CLI'), {
      target: { value: 'C:\\codex\\codex.exe' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Lưu đường dẫn' }))

    await waitFor(() => {
      expect(fake.channels['system.setSettings']).toHaveBeenCalledWith({
        patch: { codexExecutable: 'C:\\codex\\codex.exe' }
      })
    })
    // The cached result was built from the old path, so it is asked again.
    expect(fake.channels['system.preflight']).toHaveBeenCalledWith({ force: true })
  })
})
