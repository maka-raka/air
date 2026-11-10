import noComplexCondition from "./tools/code/rules/no-complex-condition.mjs";
import noDeliveryMagicStrings from "./tools/code/rules/no-delivery-magic-strings.mjs";
import noStringLiteralTypeAliases from "./tools/code/rules/no-string-literal-type-aliases.mjs";
import noWebhookMagicStrings from "./tools/code/rules/no-webhook-magic-strings.mjs";
import noMagicStringComparisons from "./tools/code/rules/no-magic-string-comparisons.mjs";
import noDomainDirectIo from "./tools/code/rules/no-domain-direct-io.mjs";
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
          "no-domain-direct-io": noDomainDirectIo,
          "no-webhook-magic-strings": noWebhookMagicStrings,
          "no-magic-string-comparisons": noMagicStringComparisons,
        },
      },
    },
    rules: { "air/no-complex-condition": "error" },
  },
  {
    files: ["src/delivery/domain/**/*.ts", "src/delivery/adapters/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "air/no-delivery-magic-strings": "error" },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "air/no-magic-string-comparisons": "error" },
  },
  {
    files: ["src/delivery/application/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "air/no-webhook-magic-strings": "error" },
  },
  {
    files: ["src/delivery/adapters/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/domain/state-machine.js"],
              importNames: ["DeliveryStateMachine", "DeliveryTransitionPolicy"],
              message:
                "Adapters persist state; transition decisions belong to application use cases.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/delivery/domain/**/*.ts", "src/policy/domain/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "air/no-domain-direct-io": "error" },
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
