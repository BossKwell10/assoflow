import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'docs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['**/*.mjs', 'apps/api/**'], languageOptions: { globals: globals.node } },
  { files: ['apps/console/**'], languageOptions: { globals: globals.browser } },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Montants en entiers FCFA (D-007) : pas de calcul flottant
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Montants en entiers : utiliser parseMontant().' },
      ],
    },
  },
);
