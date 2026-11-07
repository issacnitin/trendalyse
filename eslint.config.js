import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // This file is not part of the TS program, so type-aware rules cannot apply to it.
  { files: ['eslint.config.js'], ...tseslint.configs.disableTypeChecked },
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always'],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use src/llm/http.ts so timeouts and redaction are applied.' },
      ],
    },
  },
  {
    files: ['src/llm/http.ts', 'src/logger.ts', 'src/cli.ts'],
    rules: { 'no-restricted-globals': 'off', 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    rules: {
      'no-restricted-globals': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    files: ['src/web/public/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: { 'no-restricted-globals': 'off' },
  },
);
