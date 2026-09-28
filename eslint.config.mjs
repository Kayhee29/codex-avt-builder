import js from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      '.vite/**',
      'coverage/**',
      'workspace/**',
      'schemas/**'
    ]
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  // Main, preload, build tooling and tests run on Node.
  {
    files: [
      '**/*.{ts,mts,cts,js,mjs,cjs}',
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts'
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node }
    }
  },

  // The renderer runs in the browser sandbox and has no Node access
  // (spec section 3.2).
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },

  // Playwright decides what a fixture depends on by reading its destructuring
  // pattern, so a fixture that depends on nothing must still be written
  // `async ({}, use)`. That is the framework's contract, not a mistake.
  {
    files: ['e2e/**/*.ts'],
    rules: { 'no-empty-pattern': 'off' }
  },

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always']
    }
  },

  prettierConfig
)
