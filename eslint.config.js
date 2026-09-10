// ESLint flat config — minimal by design (P5).
//
// The project typechecks with the native TypeScript 7 compiler
// (`@typescript/native` alias), which ships no importable compiler API.
// Tooling that needs the classic API (typescript-eslint) consumes the
// official compatibility alias `typescript: npm:@typescript/typescript6` —
// see the TypeScript 7.0 announcement, "Running Side-by-Side with
// TypeScript 6.0".
//
// Deliberately NOT enabled: formatting/stylistic rules (no project-wide
// reformat churn), type-aware rules (a second compiler pass per lint run).
import js from '@eslint/js';
import pluginVue from 'eslint-plugin-vue';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Extension entrypoints run in extension pages (browser globals).
  {
    files: ['entrypoints/**/*.ts', 'entrypoints/**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  // Code paths that touch chrome.* APIs: SW router, infrastructure,
  // adapters, utils, and their tests.
  {
    files: [
      'entrypoints/background.ts',
      'src/infrastructure/**/*.ts',
      'src/adapters/**/*.ts',
      'src/utils/**/*.ts',
      'tests/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.browser, chrome: 'readonly' },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      // Discarded destructured fields (common when stripping keys) are
      // prefixed with _; everything else must be genuinely used.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // Entry App.vue files are the framework's own entrypoint idiom;
      // every other component is multi-word by convention (FeedView, ...).
      'vue/multi-word-component-names': ['error', { ignores: ['App'] }],
      // P5 scope is bug-catching, not reformatting: template layout rules
      // (indent, attribute order, line breaks) would rewrite every SFC for
      // zero behavioral gain. Revisit only with a deliberate format pass.
      'vue/html-indent': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/attributes-order': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/first-attribute-linebreak': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-quotes': 'off',
    },
  },
  {
    ignores: ['.output/**', '.wxt/**', 'node_modules/**', 'dist/**', 'e2e/**'],
  },
);
