// Correctness-only lint (decision D45): catches undefined names, unreachable
// code, duplicate keys and similar slips. It is deliberately not a style
// check; formatting is not enforced here. Unused variables are reported as
// warnings so the baseline can be cleaned up gradually, and `npm run lint`
// fails only on errors.
import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: [
      'node_modules/**',
      'lib/**', // built client bundles
      'client/**', // browser source, built into lib/ by build-client.mjs
      'vendor/**',
      'skills/**',
      'paper/**',
      'python-helpers/**',
      'docs/**',
      'reports/**',
      'assets/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2025 },
    },
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
      // Intentional patterns in this codebase: control characters in sanitisers,
      // empty catch blocks for best-effort cleanup, `while (true)` loops.
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-constant-condition': ['error', { checkLoops: false }],
      // Style-leaning rules that newer ESLint adds to "recommended". They flag
      // working code (hundreds of `throw new Error(...)` in catch blocks, regex
      // spacing in tests) and would bury the real findings, so they are off.
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
      'no-useless-escape': 'off',
      'no-regex-spaces': 'off',
    },
  },
]
