import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default defineConfig(
  { ignores: ['**/node_modules', '**/out', '**/dist', '**/coverage'] },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/main/**', 'src/preload/**', 'scripts/**', 'plugin/**', 'tests/**', '*.config.*'],
    languageOptions: { globals: globals.node },
  },
  { files: ['src/renderer/**'], languageOptions: { globals: globals.browser } },
  prettier,
);
