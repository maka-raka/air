import noComplexCondition from "./tools/code/rules/no-complex-condition.mjs";
import noDeliveryMagicStrings from "./tools/code/rules/no-delivery-magic-strings.mjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tools/**/*.mjs"],
    plugins: { air: { rules: { "no-complex-condition": noComplexCondition } } },
    rules: { "air/no-complex-condition": "error" },
  },
  {
    files: ["src/delivery/**/*.ts", "src/github/**/*.ts"],
    ignores: ["**/*.test.ts"],
    plugins: { air: { rules: { "no-delivery-magic-strings": noDeliveryMagicStrings } } },
    rules: { "air/no-delivery-magic-strings": "error" },
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
