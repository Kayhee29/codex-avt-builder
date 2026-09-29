// Writes a 64x64 RGB PNG: a blue disc on white, used as the reference image
// attached with `-i` when capturing Codex JSONL fixtures (plan Task 6.3).
// Hand-rolled so the capture needs no dependency outside Node.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = 64
const table = Int32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c
})

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // colour type: truecolour
// 10..12 stay zero: deflate, adaptive filtering, no interlace

const raw = Buffer.alloc(SIZE * (1 + SIZE * 3))
const centre = (SIZE - 1) / 2
const radius = SIZE * 0.38

for (let y = 0; y < SIZE; y += 1) {
  const row = y * (1 + SIZE * 3)
  raw[row] = 0 // filter type: none

  for (let x = 0; x < SIZE; x += 1) {
    const inside = Math.hypot(x - centre, y - centre) <= radius
    const at = row + 1 + x * 3
    raw[at] = inside ? 0x25 : 0xff
    raw[at + 1] = inside ? 0x63 : 0xff
    raw[at + 2] = inside ? 0xeb : 0xff
  }
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const target = process.argv[2]
if (!target) throw new Error('usage: node make-ref-png.mjs <path>')
writeFileSync(target, png)
process.stdout.write(`wrote ${target} (${png.length} bytes, ${SIZE}x${SIZE} RGB PNG)\n`)
