import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'cache/'] },
  js.configs.recommended,
  {
    files: ['server.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: globals.node },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: globals.browser },
  },
];
