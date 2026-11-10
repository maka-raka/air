import noComplexCondition from "./tools/code/rules/no-complex-condition.mjs";
import noDeliveryMagicStrings from "./tools/code/rules/no-delivery-magic-strings.mjs";
import noStringLiteralTypeAliases from "./tools/code/rules/no-string-literal-type-aliases.mjs";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    files: ["src/**/*.ts", "tools/**/*.mjs"],
    plugins: {
      air: {
        rules: {
          "no-complex-condition": noComplexCondition,
          "no-delivery-magic-strings": noDeliveryMagicStrings,
          "no-string-literal-type-aliases": noStringLiteralTypeAliases,
        },
      },
    },
    rules: { "air/no-complex-condition": "error" },
  },
  {
    files: ["src/delivery/**/*.ts", "src/github/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "air/no-delivery-magic-strings": "error" },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      "air/no-string-literal-type-aliases": "error",
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
