// functions/eslint.config.cjs
const tseslint = require('typescript-eslint');

module.exports = [
  // 전역 무시(빌드 산출물/설정 파일)
  {
    ignores: ['lib/**', 'node_modules/**', 'eslint.config.cjs'],
  },

  // TS 권장 설정
  ...tseslint.configs.recommended,

  // TS 파일 대상 규칙/옵션
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'commonjs',
      },
    },
    rules: {
      // 필요시 완화(원치 않으면 제거 가능)
      '@typescript-eslint/no-explicit-any': 'off',
      // (보통 TS에서는 import 씁니다. 혹시 TS에서 require를 쓰면 여길 off)
      // '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
