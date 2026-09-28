/**
 * Turning `codex exec --json` output into something the UI can show
 * (plan Task 3.4, spec section 5.5).
 *
 * Each line of Codex's stdout is one JSON object, parsed on its own. A line
 * that does not parse becomes an `unparsed` record and never fails the job
 * (spec section 5.5); a line whose event this app does not know is ignored but
 * still written to `events.jsonl`, because spec section 5.5 says the stream's
 * schema is unstable between Codex versions and carries no version marker.
 *
 * Only the vocabulary of `CODEX_MIN_VERSION` and above is understood —
 * `thread.started`, `turn.started`, `item.started`, `item.completed`,
 * `turn.completed` and `error`. The `task_started` / `agent_message` /
 * `exec_command_begin` events that Codex 0.27 emits are unknown events here,
 * which is correct: that CLI has no `image_gen` and the preflight refuses it
 * before a run can start.
 *
 * **This module never decides a `RunState`.** States are set by the runner and
 * the orchestrator (plan Tasks 3.5 and 3.7), because Codex knows nothing about
 * the app's phases (spec section 5.5). What comes out of here is display text
 * and nothing more; spec section 12 forbids branching logic on it.
 *
 * **Everything that can reach the UI is sanitized.** {@link sanitizeMessage}
 * removes absolute paths and anything shaped like a credential from both the
 * activity strings and the message of an `error` event. The raw line is kept
 * separately for `events.jsonl`, which spec section 5.5 defines as the
 * diagnostic log and which the UI never displays.
 *
 * Pure string handling: no Node built-ins, no Electron, no filesystem.
 */

/** The `type` given to a line that could not be parsed (plan Task 3.4). */
export const UNPARSED_EVENT_TYPE = 'unparsed'

/** Spec section 5.5 wants a short activity line; an agent message is cut here. */
export const MAX_ACTIVITY_LENGTH = 120

/** How much of a sanitized message is kept before it is cut. */
export const MAX_SANITIZED_LENGTH = 400

/** A line longer than this is treated as junk rather than buffered forever. */
export const MAX_LINE_LENGTH = 1024 * 1024

/** What replaces something that looked like a credential. */
export const REDACTED_MARKER = '[redacted]'

/** What replaces an absolute path. */
export const PATH_MARKER = '[path]'

/**
 * The activity strings shown during `running` (spec section 5.5, plan decision
 * Q10: display text is Vietnamese).
 *
 * They are produced in the main process and travel as a plain string inside
 * `ProgressEvent.activity`, so they cannot live in `src/renderer/i18n/vi.ts`.
 * They are collected here for the same reason the file dialog's strings are
 * collected in `./dialog.ts`: one place per module, never scattered.
 */
export const ACTIVITY = {
  imageGen: 'Đang gọi image_gen',
  command: 'Đang chạy lệnh',
  reasoning: 'Đang suy luận',
  fileChange: 'Đang ghi file',
  webSearch: 'Đang tìm kiếm web',
  todoList: 'Đang cập nhật danh sách việc',
  tool: 'Đang gọi công cụ',
  working: 'Đang xử lý'
} as const

/** One parsed Codex event, as it came off the wire. */
export type CodexEvent = Readonly<Record<string, unknown>>

/** An event that produced display text for the UI. */
export interface ActivityEvent {
  readonly kind: 'activity'
  readonly type: string
  /** Short, sanitized, Vietnamese. Display only (spec section 12). */
  readonly activity: string
  readonly event: CodexEvent
  readonly raw: string
}

/** Codex reported a failure. The message is sanitized. */
export interface CodexErrorEvent {
  readonly kind: 'error'
  readonly type: 'error'
  readonly message: string
  readonly event: CodexEvent
  readonly raw: string
}

/** A known-but-silent event, or one this version does not understand. */
export interface IgnoredEvent {
  readonly kind: 'ignored'
  readonly type: string
  /** True when the event name is not in the vocabulary of spec section 5.5. */
  readonly unknown: boolean
  readonly event: CodexEvent
  readonly raw: string
}

/** A line that is not JSON. It is logged and never fails the job. */
export interface UnparsedEvent {
  readonly kind: 'unparsed'
  readonly type: typeof UNPARSED_EVENT_TYPE
  readonly raw: string
}

export type NormalizedEvent = ActivityEvent | CodexErrorEvent | IgnoredEvent | UnparsedEvent

/** The event names spec section 5.5 fixes for supported Codex versions. */
export const KNOWN_EVENT_TYPES = [
  'thread.started',
  'turn.started',
  'turn.failed',
  'turn.completed',
  'item.started',
  'item.updated',
  'item.completed',
  'error'
] as const

/**
 * Normalizes one line of Codex stdout. `null` for a blank line.
 *
 * Never throws: a runner that dies on a malformed line would turn a cosmetic
 * problem into a failed job.
 */
export function normalizeCodexLine(line: string): NormalizedEvent | null {
  const raw = line.replace(/\r$/, '')

  if (raw.trim() === '') {
    return null
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'unparsed', type: UNPARSED_EVENT_TYPE, raw }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unparsed', type: UNPARSED_EVENT_TYPE, raw }
  }

  return normalizeCodexEvent(parsed as CodexEvent, raw)
}

/** Normalizes a whole stream. Used by the tests and by the fixture replay. */
export function normalizeCodexJsonl(text: string): NormalizedEvent[] {
  const events: NormalizedEvent[] = []

  for (const line of text.split('\n')) {
    const event = normalizeCodexLine(line)

    if (event !== null) {
      events.push(event)
    }
  }

  return events
}

/** Normalizes an already-parsed event. `raw` is what goes into the log. */
export function normalizeCodexEvent(event: CodexEvent, raw: string): NormalizedEvent {
  const type = typeof event['type'] === 'string' ? event['type'] : ''

  if (type === '') {
    return { kind: 'ignored', type: 'unknown', unknown: true, event, raw }
  }

  if (type === 'error') {
    return {
      kind: 'error',
      type: 'error',
      message: sanitizeMessage(readString(event, 'message') ?? 'Codex reported an error.'),
      event,
      raw
    }
  }

  if (type === 'item.started' || type === 'item.completed') {
    const activity = activityForItem(type, event['item'])

    if (activity !== null) {
      return { kind: 'activity', type, activity, event, raw }
    }

    return { kind: 'ignored', type, unknown: false, event, raw }
  }

  const known = (KNOWN_EVENT_TYPES as readonly string[]).includes(type)

  return { kind: 'ignored', type, unknown: !known, event, raw }
}

/**
 * The line to append to `events.jsonl`.
 *
 * A parsed event is written back exactly as Codex sent it, because spec section
 * 5.5 calls that file the raw stream. An unparsed line is wrapped in
 * `{"type":"unparsed","raw":…}` so the file stays valid JSONL; writing the junk
 * through untouched would corrupt it for every later reader.
 */
export function eventLogLine(event: NormalizedEvent): string {
  return event.kind === 'unparsed'
    ? JSON.stringify({ type: UNPARSED_EVENT_TYPE, raw: event.raw })
    : event.raw
}

/**
 * Splits a byte stream into lines without losing a line that straddles two
 * chunks.
 *
 * A line longer than `maxLineLength` is cut and the rest of it discarded: a
 * Codex that never emits a newline must not be able to grow the main process
 * until it dies. What is emitted will not parse, so it lands in the log as
 * `unparsed`, which is the honest outcome.
 */
export function createLineSplitter(options: { readonly maxLineLength?: number } = {}): {
  push(chunk: string): string[]
  flush(): string[]
} {
  const maxLineLength = options.maxLineLength ?? MAX_LINE_LENGTH
  let buffer = ''
  let discarding = false

  const take = (chunk: string): string[] => {
    buffer += chunk

    const lines: string[] = []

    for (;;) {
      const index = buffer.indexOf('\n')

      if (index === -1) {
        break
      }

      const line = buffer.slice(0, index)

      buffer = buffer.slice(index + 1)

      if (discarding) {
        discarding = false
      } else {
        lines.push(line)
      }
    }

    if (buffer.length > maxLineLength) {
      if (!discarding) {
        lines.push(buffer.slice(0, maxLineLength))
      }

      buffer = ''
      discarding = true
    }

    return lines
  }

  return {
    push: take,
    flush(): string[] {
      const rest = discarding ? '' : buffer

      buffer = ''
      discarding = false

      return rest.trim() === '' ? [] : [rest]
    }
  }
}

/**
 * Removes from `text` everything that must not reach the renderer
 * (spec section 11).
 *
 * In order: invisible characters, `Bearer …` tokens, `name = value` pairs whose
 * name says secret, OpenAI-style `sk-…` keys, then absolute paths — Windows
 * (`C:\…`, `\\server\share\…`) and POSIX (`/usr/local/…`). Relative paths
 * survive, so "copy generated_images/gen-001.png outputs/001.png" stays
 * readable while `C:\Users\someone\…` does not.
 *
 * Secrets are removed before paths so a token that contains a slash is caught
 * as a token rather than half-eaten as a path.
 */
export function sanitizeMessage(
  text: string,
  options: { readonly maxLength?: number } = {}
): string {
  const maxLength = options.maxLength ?? MAX_SANITIZED_LENGTH

  let result = text.replace(INVISIBLE_CHARACTERS, ' ')

  result = result.replace(BEARER_TOKEN, `Bearer ${REDACTED_MARKER}`)
  result = result.replace(NAMED_SECRET, (_match, name: string) => `${name}=${REDACTED_MARKER}`)
  result = result.replace(OPENAI_STYLE_KEY, REDACTED_MARKER)
  result = result.replace(WINDOWS_PATH, PATH_MARKER)
  result = result.replace(POSIX_PATH, PATH_MARKER)
  result = result.replace(/\s+/g, ' ').trim()

  return truncate(result, maxLength)
}

/** Cuts `text` at `maxLength`, marking that something was removed. */
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every Unicode "other" character: controls, but also the invisible formatting
 * characters — zero-width spaces and the bidirectional overrides — that can
 * make a string render as something other than what it says. None of them
 * belongs in a one-line activity label.
 */
const INVISIBLE_CHARACTERS = /\p{C}/gu

const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

/**
 * `api_key: …`, `password=…` and friends. `authorization` is deliberately not
 * in this list: {@link BEARER_TOKEN} already redacts the value after it, and
 * matching the name as well would mangle the readable part of the sentence.
 */
const NAMED_SECRET =
  /\b(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|token)\b\s*[:=]\s*"?[^\s"',;]+"?/gi

const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{4,}/g

/** `C:\…`, `C:/…` and UNC `\\server\share\…`. */
const WINDOWS_PATH = /(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>|]*/g

/**
 * An absolute POSIX path of at least two segments. The lookbehind stops it
 * matching the `/` inside `application/json`, `and/or` or a relative path such
 * as `outputs/001.png`, none of which is a path that has to be hidden.
 */
const POSIX_PATH = /(?<![\w.~+-])\/(?:[\w.~+-]+\/)+[\w.~+-]*/g

/** A program name short and plain enough to show, such as `copy` or `python`. */
const SAFE_COMMAND_TOKEN = /^[A-Za-z0-9._-]{1,24}$/

/**
 * The activity for one item event, or `null` when the item is not worth a line.
 *
 * Only `item.started` produces an activity, apart from `agent_message`, which
 * carries its text on `item.completed`. Reporting both ends of every item would
 * show the user each step twice.
 */
function activityForItem(eventType: string, item: unknown): string | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return null
  }

  const record = item as Readonly<Record<string, unknown>>
  // Spec section 5.5 names this `item.type`; a captured stream may spell it
  // `item_type`. Both are read, because the schema is known to move between
  // Codex versions and a missing activity must never break a run.
  const itemType = readString(record, 'type') ?? readString(record, 'item_type') ?? ''

  if (itemType === 'agent_message') {
    return eventType === 'item.completed' ? agentMessageActivity(record) : null
  }

  if (eventType !== 'item.started') {
    return null
  }

  if (isImageGenTool(record)) {
    return ACTIVITY.imageGen
  }

  switch (itemType) {
    case 'command_execution':
      return withDetail(ACTIVITY.command, commandProgram(record))
    case 'reasoning':
      return ACTIVITY.reasoning
    case 'file_change':
      return ACTIVITY.fileChange
    case 'web_search':
      return ACTIVITY.webSearch
    case 'todo_list':
      return ACTIVITY.todoList
    case 'mcp_tool_call':
    case 'tool_call':
    case 'custom_tool_call':
    case 'function_call':
      return withDetail(ACTIVITY.tool, safeToken(toolName(record)))
    default:
      // An item type this version has never seen still shows movement in the
      // UI; spec section 5.5 only requires unknown *events* to be silent.
      return ACTIVITY.working
  }
}

function agentMessageActivity(item: Readonly<Record<string, unknown>>): string | null {
  const text = readString(item, 'text') ?? readString(item, 'message') ?? ''
  const activity = sanitizeMessage(text, { maxLength: MAX_ACTIVITY_LENGTH })

  return activity === '' ? null : activity
}

/** Whether any name on this item says it is the built-in image generator. */
function isImageGenTool(item: Readonly<Record<string, unknown>>): boolean {
  for (const key of ['tool', 'tool_name', 'name', 'server']) {
    const value = readString(item, key)

    if (value !== undefined && value.includes('image_gen')) {
      return true
    }
  }

  return false
}

function toolName(item: Readonly<Record<string, unknown>>): string | undefined {
  return (
    readString(item, 'tool') ??
    readString(item, 'tool_name') ??
    readString(item, 'name') ??
    undefined
  )
}

/** The program a command runs, such as `copy` in `copy a.png outputs/b.png`. */
function commandProgram(item: Readonly<Record<string, unknown>>): string | undefined {
  const command = readString(item, 'command') ?? readString(item, 'cmd')

  if (command === undefined) {
    return undefined
  }

  const first = command.trim().split(/\s+/)[0]

  return safeToken(first?.split(/[\\/]/).pop())
}

/** Keeps a token only when it is short and plain enough to show as-is. */
function safeToken(value: string | undefined): string | undefined {
  return value !== undefined && SAFE_COMMAND_TOKEN.test(value) ? value : undefined
}

function withDetail(activity: string, detail: string | undefined): string {
  return detail === undefined ? activity : `${activity} ${detail}`
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key]

  return typeof value === 'string' ? value : undefined
}
