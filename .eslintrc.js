const { typescript: { rules } } = require('@zero-plusplus/eslint-my-rules');

module.exports = {
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
    'class-methods-use-this': 'off',
    'arrow-body-style': 'off',
    'no-shadow': 'off',
    'no-plusplus': 'off',
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