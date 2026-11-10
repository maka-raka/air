import noStringLiteralTypeAliases from "./rules/no-string-literal-type-aliases.mjs";
import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "node:test";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tsParser } });
tester.run("air/no-string-literal-type-aliases", noStringLiteralTypeAliases, {
  valid: [
    'const Status = { Ready: "ready", Failed: "failed" } as const; type Status = (typeof Status)[keyof typeof Status];',
    "type Identifier = string;",
    "type Result = { ok: true } | { ok: false };",
    "type Flag = true | false;",
    'const message: "hello" = "hello";',
  ],
  invalid: [
    'type Status = "ready" | "failed";',
    'export type Failure = "invalid" | "unauthorized" | "timeout";',
    'type Mode = "auto";',
    'type Mixed = "ready" | undefined;',
  ].map((code) => ({ code, errors: [{ messageId: "constObject" }] })),
});
