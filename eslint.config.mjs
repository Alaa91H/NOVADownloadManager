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
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'vite.config.ts', 'vitest.config.ts'],
    languageOptions: {
      globals: globals.node,
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
      'scripts/',
      'eslint.config.mjs',
    ],
  }
);
