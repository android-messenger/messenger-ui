import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-app', 'dist-wolpt', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Spec 001, FR-050: keys and sessions of secret chats are reached only through the E2EE feature's
    // public files (index.ts, wire.ts). Tests may open the internals they test.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/e2ee/**', '**/__tests__/**', '**/__test__/**', '**/__audit__/**', '**/__path__/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/features/e2ee/lib/**', '**/features/e2ee/recovery/**', '**/features/e2ee/crypto', '**/features/e2ee/crypto.ts'],
          message: 'Import from "@/features/e2ee" or "@/features/e2ee/wire.ts" (spec 001, FR-050).',
        }],
      }],
    },
  },
])
