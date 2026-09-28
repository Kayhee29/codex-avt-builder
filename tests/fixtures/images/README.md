# Image fixtures

Four tiny files used by `tests/unit/image-inspect.test.ts` (plan Task 2.2) and,
from plan Task 3.3 on, by the fake Codex executable when a scenario has to drop
a file into a job's `outputs/`.

They are synthetic and deliberately minimal: the app only ever reads an image
header (format by magic bytes, then width and height), so a fixture that carries
a correct header is enough and keeps the repository small.

| File                        | Bytes | What it is                                                                     |
| --------------------------- | ----- | ------------------------------------------------------------------------------ |
| `style-2x3.png`             | 75    | a complete PNG: IHDR, a deflated IDAT of 2×3 solid pixels, IEND                |
| `identity-4x2.jpg`          | 35    | JPEG SOI, a JFIF APP0 segment, an SOF0 declaring 4×2, EOI                      |
| `outfit-6x5.webp`           | 30    | a RIFF/WEBP container with one `VP8 ` chunk whose keyframe header declares 6×5 |
| `text-pretending-to-be.png` | 62    | plain text under a `.png` name, to prove the format check reads bytes          |

Each accepted fixture has a different width and height, so a test fails if the
two are ever swapped.

`style-2x3.png` is a real image an image viewer can open. `identity-4x2.jpg` and
`outfit-6x5.webp` carry a valid container and a valid frame header but no
entropy-coded image data, so they are readable as metadata and not decodable as
pictures. That is enough for `inspectImage`, for the result verifier of plan
Task 3.6 and for the schema-level checks; a test that needs a decodable picture
should use `style-2x3.png`.
