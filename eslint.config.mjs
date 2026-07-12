import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
  },
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'react-hooks/exhaustive-deps': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['src/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Build/CLI scripts communicate through stdout/stderr by design.
      'no-console': 'off',
    },
  },
  prettier,
  {
    ignores: [
      'dist/',
      'node_modules/',
      'browser-extension/',
      'src-tauri/target/',
      'src-tauri/gen/',
      'src-tauri/resources/',
      'src/lib/i18n/',
      'coverage/',
      'bin/',
      '.cache/',
      'eslint.config.mjs',
    ],
  }
);
