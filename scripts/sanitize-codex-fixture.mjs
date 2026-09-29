// Sanitizes a recorded Codex JSONL stream so it can be committed as a fixture
// (plan Task 6.3, step 5).
//
// usage: node scripts/sanitize-codex-fixture.mjs <in.jsonl> <out.jsonl>
//
// What it changes, and nothing else:
//
//   - the account's Windows user name, wherever it appears, including inside
//     command strings;
//   - the thread id and every other UUID, each mapped to a stable placeholder
//     so repeated references stay linked;
//   - `aggregated_output` longer than AGGREGATED_OUTPUT_LIMIT, replaced by a
//     marker. Codex echoes whole files it reads into that field — on the
//     capture this was written for, one line carried 26 KB of a third party's
//     SKILL.md. The normalizer reads `command`, `exit_code` and `status` from
//     these items and never the output, so the structure the fixture exists to
//     pin down is unaffected. The marker keeps the edit visible rather than
//     silently shortening a recording.
//
// Event order, event names, item ids, item types and usage counts are left
// exactly as recorded. If a fixture disagrees with the normalizer, the
// normalizer is what changes (plan Task 6.3).
import { readFileSync, writeFileSync } from 'node:fs'

const AGGREGATED_OUTPUT_LIMIT = 400
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const [, , source, target] = process.argv

if (source === undefined || target === undefined) {
  throw new Error('usage: node scripts/sanitize-codex-fixture.mjs <in.jsonl> <out.jsonl>')
}

const userName = process.env.USERNAME ?? process.env.USER ?? ''
const uuids = new Map()

function placeholderFor(uuid) {
  const existing = uuids.get(uuid.toLowerCase())

  if (existing !== undefined) {
    return existing
  }

  // Hex only, so the placeholder still has the shape of a UUID, and all
  // zeroes, so nobody mistakes it for a recorded one. The first UUID in a
  // stream is the thread id, which is why it gets index 0.
  const name = `00000000-0000-0000-0000-${String(uuids.size).padStart(12, '0')}`

  uuids.set(uuid.toLowerCase(), name)

  return name
}

function scrub(text) {
  let out = text.replace(UUID, (match) => placeholderFor(match))

  if (userName !== '') {
    out = out.split(userName).join('example')
  }

  return out
}

function walk(value) {
  if (typeof value === 'string') {
    return scrub(value)
  }

  if (Array.isArray(value)) {
    return value.map(walk)
  }

  if (value !== null && typeof value === 'object') {
    const result = {}

    for (const [key, inner] of Object.entries(value)) {
      if (key === 'aggregated_output' && typeof inner === 'string') {
        result[key] =
          inner.length > AGGREGATED_OUTPUT_LIMIT
            ? `${scrub(inner.slice(0, AGGREGATED_OUTPUT_LIMIT))}\n[${String(inner.length)} bytes of command output removed when this fixture was sanitized]\n`
            : scrub(inner)
        continue
      }

      result[key] = walk(inner)
    }

    return result
  }

  return value
}

const lines = readFileSync(source, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')

const sanitized = lines.map((line) => JSON.stringify(walk(JSON.parse(line))))

writeFileSync(target, `${sanitized.join('\n')}\n`)

const remaining = userName === '' ? 0 : sanitized.join('\n').split(userName).length - 1

process.stdout.write(
  `${String(lines.length)} lines -> ${target}\n` +
    `  uuids replaced: ${String(uuids.size)}\n` +
    `  user name left behind: ${String(remaining)}\n`
)
