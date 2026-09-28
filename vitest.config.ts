import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * Automated tests never invoke the real Codex CLI (spec section 13).
 * From Task 3.3 onwards the Codex runner is driven by `tests/fake-codex/`.
 *
 * Renderer tests live in `tests/unit/renderer/` and opt into jsdom with a
 * `// @vitest-environment jsdom` line of their own (plan Task 5.1); everything
 * else runs on Node, because nothing outside the renderer may touch a DOM.
 */
export default defineConfig({
  // The renderer is compiled with `"jsx": "react-jsx"` (tsconfig.web.json).
  // esbuild reads the nearest tsconfig.json, and the root one only holds
  // project references, so the automatic runtime is stated here instead.
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    reporters: ['default']
  }
})
