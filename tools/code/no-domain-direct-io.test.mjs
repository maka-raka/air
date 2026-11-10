import noDomainDirectIo from "./rules/no-domain-direct-io.mjs";
import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "node:test";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parser: tsParser } });

tester.run("air/no-domain-direct-io", noDomainDirectIo, {
  valid: [
    "export class Policy { decide(value: number): number { return value + 1; } }",
    'import type { Request } from "../application/request.js";',
    "export class Policy { decide(input: readonly string[]) { return input.map(x => x); } }",
  ],
  invalid: [
    {
      code: 'import { readFileSync } from "node:fs";',
      errors: [{ messageId: "module" }],
    },
    {
      code: 'export { request } from "node:http";',
      errors: [{ messageId: "module" }],
    },
    {
      code: 'const io = import("node:child_process");',
      errors: [{ messageId: "module" }],
    },
    {
      code: 'fetch("https://example.org");',
      errors: [{ messageId: "global" }],
    },
    {
      code: 'console.log("test");',
      errors: [{ messageId: "global" }],
    },
    {
      code: "process.exit(1);",
      errors: [{ messageId: "global" }],
    },
    {
      code: "setTimeout(() => {}, 10);",
      errors: [{ messageId: "global" }],
    },
  ],
});
