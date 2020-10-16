const { typescript: { rules } } = require('@zero-plusplus/eslint-my-rules');

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: "module",
    tsconfigRootDir: './',
    project: [ './tsconfig.json' ],
  },
  env: {
      node: true,
      es6: true,
      mocha: true,
  },
  plugins: [ "@typescript-eslint" ],
  rules: {
    ...rules,
    'no-undef': 'off', // Wait for improve: NodeJS, BufferEncoding, etc. are not supported.
    'arrow-body-style': 'off',
    'class-methods-use-this': 'off',
    'lines-between-class-members': 'off',
    'newline-per-chained-call': ["error", { "ignoreChainWithDepth": 5 }],
    'no-plusplus': 'off',
    'no-shadow': 'off',
    'prefer-named-capture-group': 'off',
    "prefer-destructuring": 'off',
    '@typescript-eslint/no-use-before-define': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-extra-parens': [ 'error', 'all', { 'enforceForArrowConditionals': false }],
    '@typescript-eslint/no-type-alias': [ 'error', {
      allowAliases: 'always',
      allowCallbacks: 'always',
    } ],
  }
}