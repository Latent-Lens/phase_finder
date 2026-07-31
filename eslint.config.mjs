import globals from "globals";

const correctnessRules = {
  "constructor-super": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-class-assign": "error",
  "no-const-assign": "error",
  "no-constant-binary-expression": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-duplicate-imports": "error",
  "no-empty": "error",
  "no-func-assign": "error",
  "no-import-assign": "error",
  "no-new-native-nonconstructor": "error",
  "no-obj-calls": "error",
  "no-promise-executor-return": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-this-before-super": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unreachable-loop": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "require-yield": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
};

export default [
  {
    ignores: ["dist/**", "dist-base/**", "js/vendor/**", "tests/e2e/results/**"],
  },
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.worker,
        __PHASEFINDER_SOURCE_COMMIT__: "readonly",
        __PHASEFINDER_VERSION__: "readonly",
      },
    },
    rules: correctnessRules,
  },
  {
    files: ["js/analysis/cell_cycle/models/*.js"],
    rules: {
      "no-restricted-globals": ["error", "document", "window"],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.node,
    },
    rules: correctnessRules,
  },
  {
    files: ["scripts/**/*.cjs", "vite.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: correctnessRules,
  },
];
