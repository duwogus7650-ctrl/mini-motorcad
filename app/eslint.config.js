import js from "@eslint/js";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// React/훅 규칙 가드 — 과거 포커스풀림(중첩 컴포넌트)·훅 의존성 누락 버그 클래스 자동 차단.
export default [
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  {
    files: ["src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, "react-hooks": reactHooks },
    settings: { react: { version: "detect" } },
    rules: {
      "react/jsx-uses-vars": "error",               // JSX에서 쓰는 컴포넌트를 사용으로 인식(no-unused 오탐 방지)
      "react/jsx-uses-react": "error",
      "react-hooks/rules-of-hooks": "error",       // 훅 호출 규칙(조건부 호출 등) — 진짜 버그
      "react-hooks/exhaustive-deps": "warn",        // useEffect/useMemo 의존성 누락
      "react/no-unstable-nested-components": "warn", // 렌더 내 컴포넌트 정의(포커스풀림 클래스)
      "no-unused-vars": "warn",
      "no-undef": "error",
    },
  },
];
