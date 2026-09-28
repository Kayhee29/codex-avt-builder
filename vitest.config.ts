import { resolve } from 'node:path'

import { defineConfig } from 'vitest/config'

/**
 * Automated tests never invoke the real Codex CLI (spec section 13).
 * From Task 3.3 onwards the Codex runner is driven by `tests/fake-codex/`.
 */
export default defineConfig({
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
