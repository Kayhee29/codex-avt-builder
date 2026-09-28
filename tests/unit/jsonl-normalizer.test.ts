import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  ACTIVITY,
  createLineSplitter,
  eventLogLine,
  MAX_ACTIVITY_LENGTH,
  normalizeCodexJsonl,
  normalizeCodexLine,
  PATH_MARKER,
  REDACTED_MARKER,
  sanitizeMessage,
  UNPARSED_EVENT_TYPE,
  type ActivityEvent,
  type NormalizedEvent
} from '../../src/main/jsonl-normalizer.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/codex-jsonl/0.158.0/', import.meta.url))

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURE_DIR, name), 'utf8')
}

function activities(events: readonly NormalizedEvent[]): string[] {
  return events
    .filter((event): event is ActivityEvent => event.kind === 'activity')
    .map((event) => event.activity)
}

/** One line of JSONL, so a test reads like the stream it describes. */
function line(value: unknown): string {
  return JSON.stringify(value)
}

describe('the success fixture', () => {
  it('produces one activity per item that starts, plus the final message', async () => {
    const events = normalizeCodexJsonl(await fixture('success.jsonl'))

    expect(activities(events)).toEqual([
      ACTIVITY.reasoning,
      `${ACTIVITY.command} ls`,
      ACTIVITY.imageGen,
      `${ACTIVITY.command} copy`,
      ACTIVITY.fileChange,
      'Đã sinh 1 ảnh bằng image_gen, copy vào outputs/001.png và ghi codex-result.json.'
    ])
  })

  it('never reports the same item twice', async () => {
    const events = normalizeCodexJsonl(await fixture('success.jsonl'))
    const started = events.filter((event) => event.type === 'item.started')
    const completedActivities = events.filter(
      (event) => event.type === 'item.completed' && event.kind === 'activity'
    )

    expect(started).toHaveLength(5)
    // Only the agent message speaks on completion.
    expect(completedActivities).toHaveLength(1)
  })

  it('ignores thread.started, turn.started and turn.completed without calling them unknown', async () => {
    const events = normalizeCodexJsonl(await fixture('success.jsonl'))

    for (const type of ['thread.started', 'turn.started', 'turn.completed']) {
      const event = events.find((candidate) => candidate.type === type)

      expect(event?.kind).toBe('ignored')
      expect(event?.kind === 'ignored' && event.unknown).toBe(false)
    }
  })

  it('ignores item.updated, which spec section 5.5 does not list', async () => {
    const events = normalizeCodexJsonl(await fixture('success.jsonl'))
    const updated = events.filter((event) => event.type === 'item.updated')

    expect(updated).toHaveLength(1)
    expect(updated[0]?.kind).toBe('ignored')
  })

  it('keeps every line for events.jsonl, activity or not', async () => {
    const raw = await fixture('success.jsonl')
    const events = normalizeCodexJsonl(raw)

    expect(events).toHaveLength(15)
    expect(events.map(eventLogLine).join('\n')).toBe(raw.trimEnd())
  })
})

describe('the capability-unavailable fixture', () => {
  it('still produces activity and ends with Codex explaining itself', async () => {
    const events = normalizeCodexJsonl(await fixture('capability-unavailable.jsonl'))

    expect(activities(events)).toEqual([
      ACTIVITY.reasoning,
      ACTIVITY.fileChange,
      expect.stringContaining('image_gen không khả dụng')
    ])
  })
})

describe('the error fixture', () => {
  it('keeps the error message and strips the token and the path out of it', async () => {
    const events = normalizeCodexJsonl(await fixture('error.jsonl'))
    const error = events.find((event) => event.kind === 'error')

    expect(error?.kind).toBe('error')

    const message = error?.kind === 'error' ? error.message : ''

    expect(message).toContain('Image generation failed')
    expect(message).not.toContain('sk-NOT-A-REAL-KEY-000000')
    expect(message).not.toContain('C:\\Users')
    expect(message).toContain(REDACTED_MARKER)
    expect(message).toContain(PATH_MARKER)
  })

  it('does not turn an error event into a run state', async () => {
    const events = normalizeCodexJsonl(await fixture('error.jsonl'))

    for (const event of events) {
      expect(Object.keys(event)).not.toContain('state')
    }
  })
})

describe('unparseable and malformed lines', () => {
  it('turns junk into an unparsed record instead of throwing', () => {
    const event = normalizeCodexLine('this is not json at all {')

    expect(event).toEqual({
      kind: 'unparsed',
      type: UNPARSED_EVENT_TYPE,
      raw: 'this is not json at all {'
    })
  })

  it('wraps an unparsed line so events.jsonl stays valid JSONL', () => {
    const event = normalizeCodexLine('not json')

    expect(event).not.toBeNull()
    expect(JSON.parse(eventLogLine(event as NormalizedEvent))).toEqual({
      type: 'unparsed',
      raw: 'not json'
    })
  })

  it('treats valid JSON that is not an object as unparsed', () => {
    expect(normalizeCodexLine('[1,2,3]')?.kind).toBe('unparsed')
    expect(normalizeCodexLine('"a string"')?.kind).toBe('unparsed')
    expect(normalizeCodexLine('null')?.kind).toBe('unparsed')
  })

  it('skips blank lines entirely', () => {
    expect(normalizeCodexLine('')).toBeNull()
    expect(normalizeCodexLine('   ')).toBeNull()
    expect(normalizeCodexLine('\r')).toBeNull()
  })

  it('ignores an object with no type', () => {
    const event = normalizeCodexLine(line({ item: { type: 'reasoning' } }))

    expect(event?.kind).toBe('ignored')
    expect(event?.kind === 'ignored' && event.unknown).toBe(true)
  })

  it('does not fall over on an item that is not an object', () => {
    expect(normalizeCodexLine(line({ type: 'item.started', item: 'nonsense' }))?.kind).toBe(
      'ignored'
    )
    expect(normalizeCodexLine(line({ type: 'item.started' }))?.kind).toBe('ignored')
  })

  it('keeps a junk line from failing the surrounding stream', async () => {
    const withJunk = `${(await fixture('success.jsonl')).trimEnd()}\n<<< not json >>>\n`
    const events = normalizeCodexJsonl(withJunk)

    expect(events.at(-1)?.kind).toBe('unparsed')
    expect(activities(events)).toHaveLength(6)
  })
})

describe('unknown events', () => {
  it('ignores the 0.27 vocabulary but still logs it', () => {
    for (const type of ['task_started', 'agent_message', 'exec_command_begin', 'task_complete']) {
      const event = normalizeCodexLine(line({ type, payload: {} }))

      expect(event?.kind).toBe('ignored')
      expect(event?.kind === 'ignored' && event.unknown).toBe(true)
      expect(eventLogLine(event as NormalizedEvent)).toContain(type)
    }
  })

  it('shows generic movement for an item type it has never seen', () => {
    const event = normalizeCodexLine(
      line({ type: 'item.started', item: { id: 'x', type: 'something_new' } })
    )

    expect(event?.kind === 'activity' && event.activity).toBe(ACTIVITY.working)
  })
})

describe('image_gen detection', () => {
  it('recognises the tool whichever field carries its name', () => {
    const shapes = [
      { id: 'a', type: 'mcp_tool_call', server: 'codex', tool: 'image_gen' },
      { id: 'b', type: 'tool_call', name: 'image_gen' },
      { id: 'c', type: 'custom_tool_call', tool_name: 'image_gen' },
      { id: 'd', type: 'function_call', name: 'container.image_gen.create' }
    ]

    for (const item of shapes) {
      const event = normalizeCodexLine(line({ type: 'item.started', item }))

      expect(event?.kind === 'activity' && event.activity).toBe(ACTIVITY.imageGen)
    }
  })

  it('names another tool without pretending it is image_gen', () => {
    const event = normalizeCodexLine(
      line({ type: 'item.started', item: { id: 'x', type: 'mcp_tool_call', tool: 'web_fetch' } })
    )

    expect(event?.kind === 'activity' && event.activity).toBe(`${ACTIVITY.tool} web_fetch`)
  })

  it('drops a tool name that is not a plain short token', () => {
    const event = normalizeCodexLine(
      line({
        type: 'item.started',
        item: { id: 'x', type: 'tool_call', name: 'weird name with spaces and more' }
      })
    )

    expect(event?.kind === 'activity' && event.activity).toBe(ACTIVITY.tool)
  })
})

describe('command activity', () => {
  it('names the program, matching the "Đang chạy lệnh copy" of spec section 5.5', () => {
    const event = normalizeCodexLine(
      line({
        type: 'item.started',
        item: { id: 'x', type: 'command_execution', command: 'copy a.png outputs/b.png' }
      })
    )

    expect(event?.kind === 'activity' && event.activity).toBe(`${ACTIVITY.command} copy`)
  })

  it('never leaks the path a command was run from', () => {
    const event = normalizeCodexLine(
      line({
        type: 'item.started',
        item: {
          id: 'x',
          type: 'command_execution',
          command: 'C:\\Users\\someone\\secret-tool.exe --key sk-NOT-A-REAL-KEY-0000'
        }
      })
    )
    const activity = event?.kind === 'activity' ? event.activity : ''

    expect(activity).toBe(`${ACTIVITY.command} secret-tool.exe`)
    expect(activity).not.toContain('someone')
    expect(activity).not.toContain('sk-')
  })

  it('falls back to the bare label when the command is unusable', () => {
    for (const command of ['', '   ', 'a-very-long-program-name-that-goes-on-and-on']) {
      const event = normalizeCodexLine(
        line({ type: 'item.started', item: { id: 'x', type: 'command_execution', command } })
      )

      expect(event?.kind === 'activity' && event.activity).toBe(ACTIVITY.command)
    }
  })
})

describe('agent messages', () => {
  it('cuts a long message to the activity limit', () => {
    const event = normalizeCodexLine(
      line({
        type: 'item.completed',
        item: { id: 'x', type: 'agent_message', text: 'a'.repeat(400) }
      })
    )
    const activity = event?.kind === 'activity' ? event.activity : ''

    expect(activity).toHaveLength(MAX_ACTIVITY_LENGTH)
    expect(activity.endsWith('…')).toBe(true)
  })

  it('sanitizes the message before it becomes an activity', () => {
    const event = normalizeCodexLine(
      line({
        type: 'item.completed',
        item: {
          id: 'x',
          type: 'agent_message',
          text: 'Wrote C:\\Users\\someone\\out.png using Bearer sk-NOT-A-REAL-KEY-0000'
        }
      })
    )
    const activity = event?.kind === 'activity' ? event.activity : ''

    expect(activity).toBe(`Wrote ${PATH_MARKER} using Bearer ${REDACTED_MARKER}`)
  })

  it('stays silent on an empty message', () => {
    const event = normalizeCodexLine(
      line({ type: 'item.completed', item: { id: 'x', type: 'agent_message', text: '   ' } })
    )

    expect(event?.kind).toBe('ignored')
  })

  it('reads item_type as well as type, since the schema moves between versions', () => {
    const event = normalizeCodexLine(
      line({ type: 'item.completed', item: { id: 'x', item_type: 'agent_message', text: 'Xong.' } })
    )

    expect(event?.kind === 'activity' && event.activity).toBe('Xong.')
  })
})

describe('sanitizeMessage', () => {
  it('redacts a bearer token', () => {
    expect(sanitizeMessage('failed with Bearer abc.def-123_XYZ')).toBe(
      `failed with Bearer ${REDACTED_MARKER}`
    )
  })

  it('redacts an sk- key wherever it appears', () => {
    expect(sanitizeMessage('key sk-proj-AAAABBBBCCCC rejected')).toBe(
      `key ${REDACTED_MARKER} rejected`
    )
  })

  it('redacts a named secret', () => {
    expect(sanitizeMessage('api_key: hunter2hunter2')).toBe(`api_key=${REDACTED_MARKER}`)
    expect(sanitizeMessage('password="hunter2"')).toBe(`password=${REDACTED_MARKER}`)
  })

  it('removes a Windows path, including a UNC one', () => {
    expect(sanitizeMessage('reading C:\\Users\\someone\\ref.png now')).toBe(
      `reading ${PATH_MARKER} now`
    )
    expect(sanitizeMessage('reading \\\\server\\share\\ref.png now')).toBe(
      `reading ${PATH_MARKER} now`
    )
  })

  it('removes an absolute POSIX path', () => {
    expect(sanitizeMessage('reading /home/someone/.codex/auth.json now')).toBe(
      `reading ${PATH_MARKER} now`
    )
  })

  it('leaves a path relative to the job directory alone, because it is meaningful', () => {
    expect(sanitizeMessage('copy generated_images/gen-001.png outputs/001.png')).toBe(
      'copy generated_images/gen-001.png outputs/001.png'
    )
  })

  it('does not mistake ordinary text for a path', () => {
    expect(sanitizeMessage('content-type application/json and/or text')).toBe(
      'content-type application/json and/or text'
    )
  })

  it('collapses newlines and control characters', () => {
    expect(sanitizeMessage('two\nlines\twith\u0000control')).toBe('two lines with control')
  })

  it('removes the invisible characters a label could be spoofed with', () => {
    expect(sanitizeMessage('safe​‮txt.exe')).toBe('safe txt.exe')
  })

  it('cuts a very long message', () => {
    const result = sanitizeMessage('x'.repeat(1000))

    expect(result).toHaveLength(400)
    expect(result.endsWith('…')).toBe(true)
  })

  it('is idempotent, so sanitizing twice changes nothing', () => {
    const once = sanitizeMessage('C:\\Users\\a\\b.png with Bearer sk-NOT-A-REAL-KEY-0000')

    expect(sanitizeMessage(once)).toBe(once)
  })
})

describe('createLineSplitter', () => {
  it('joins a line that straddles two chunks', () => {
    const splitter = createLineSplitter()

    expect(splitter.push('{"type":"turn')).toEqual([])
    expect(splitter.push('.started"}\n{"type":"error"}\n')).toEqual([
      '{"type":"turn.started"}',
      '{"type":"error"}'
    ])
    expect(splitter.flush()).toEqual([])
  })

  it('handles CRLF, which is what a Windows pipe delivers', () => {
    const splitter = createLineSplitter()
    const lines = splitter.push('{"type":"turn.started"}\r\n')

    expect(normalizeCodexLine(lines[0] ?? '')?.type).toBe('turn.started')
  })

  it('returns a trailing line with no newline on flush', () => {
    const splitter = createLineSplitter()

    splitter.push('{"type":"turn.started"}')

    expect(splitter.flush()).toEqual(['{"type":"turn.started"}'])
  })

  it('cuts a line that never ends instead of buffering forever', () => {
    const splitter = createLineSplitter({ maxLineLength: 16 })
    const emitted = splitter.push('x'.repeat(40))

    expect(emitted).toEqual(['x'.repeat(16)])
    // The rest of that runaway line is discarded, and the next real line is
    // read normally.
    expect(splitter.push('more\n{"type":"turn.started"}\n')).toEqual(['{"type":"turn.started"}'])
  })
})
