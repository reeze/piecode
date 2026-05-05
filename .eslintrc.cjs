module.exports = {
  env: {
    node: true,
    es2022: true,
    jest: true,
  },
  extends: ['eslint:recommended', 'prettier'],
  plugins: ['prettier'],
  rules: {
    'prettier/prettier': 'off',
    'no-unused-vars': 'warn',
    'no-console': 'off',
    'no-extra-boolean-cast': 'off',
    'no-useless-escape': 'off',
    'no-control-regex': 'off',
    'no-constant-condition': 'off',
    'no-empty': 'off',
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  globals: {
    fetch: 'readonly',
    window: 'readonly',
    document: 'readonly',
    FileReader: 'readonly',
    EventSource: 'readonly',
  },
  overrides: [
    {
      files: ['src/web/public/**/*.js'],
      env: {
        browser: true,
        node: false,
      },
    },
  ],
};
