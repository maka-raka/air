import noComplexCondition from "./tools/code/rules/no-complex-condition.mjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tools/**/*.mjs"],
    plugins: { air: { rules: { "no-complex-condition": noComplexCondition } } },
    rules: { "air/no-complex-condition": "error" },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "no-nested-ternary": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "IfStatement > BlockStatement IfStatement",
          message: "Avoid nested if statements; use guard clauses.",
        },
        {
          selector: "IfStatement > IfStatement.consequent",
          message:
            "Avoid nested if statements without braces; use guard clauses.",
        },
      ],
    },
  },
];
