import noComplexCondition from "./rules/no-complex-condition.mjs";
import noWebhookMagicStrings from "./rules/no-webhook-magic-strings.mjs";
import noDeliveryMagicStrings from "./rules/no-delivery-magic-strings.mjs";
import tsParser from "@typescript-eslint/parser";
import assert from "node:assert/strict";
import { describe, it, test } from "node:test";
import { ESLint, RuleTester } from "eslint";

const eslint = new ESLint();

async function violations(code) {
  const [result] = await eslint.lintText(code, {
    filePath: "src/policy-fixture.ts",
  });
  return result.messages.filter(({ severity }) => severity === 2);
}

test("rejects nested if blocks", async () => {
  const messages = await violations(
    "if (user) { if (user.active) { work(); } }",
  );
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects nested ternaries", async () => {
  const messages = await violations("const value = a ? b : c ? d : e;");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-nested-ternary"));
});

test("allows guard clauses", async () => {
  assert.deepEqual(
    await violations(
      "function run(user) { if (!user) return; if (!user.active) return; work(); }",
    ),
    [],
  );
});

test("allows else-if chains", async () => {
  assert.deepEqual(
    await violations("if (a) { work(); } else if (b) { other(); }"),
    [],
  );
});

test("allows simple ternaries", async () => {
  assert.deepEqual(
    await violations("const value = active ? enabled : disabled;"),
    [],
  );
});

test("rejects nested if inside else blocks", async () => {
  const messages = await violations(
    "if (a) { work(); } else { if (b) { other(); } }",
  );
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects nested if through an intermediate block", async () => {
  const messages = await violations(
    "if (a) { for (const item of items) { if (item) { work(); } } }",
  );
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects ternaries nested in the true branch", async () => {
  const messages = await violations("const value = a ? (b ? c : d) : e;");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-nested-ternary"));
});

test("rejects nested if statements without braces", async () => {
  const messages = await violations("if (a) if (b) work();");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("allows else-if chains without braces", async () => {
  assert.deepEqual(await violations("if (a) work(); else if (b) other();"), []);
});

RuleTester.describe = describe;
RuleTester.it = it;
const ruleTester = new RuleTester({ languageOptions: { parser: tsParser } });
ruleTester.run("air/no-complex-condition", noComplexCondition, {
  valid: [
    "if (ready) work();",
    "if (a || b) work();",
    "if (a && b) work();",
    "if (a) work(); else if (b || c) other();",
    "if (!(a || b)) work();",
    "if (isValid(value)) work();",
    "if (a ?? b) work();",
    "if ((a || b) as boolean) work();",
  ],
  invalid: [
    "if (a || b || c) work();",
    "if (a && (b || c)) work();",
    "if ((a && b) || c) work();",
    "if (!(a || b || c)) work();",
    "if (a) work(); else if (b || c || d) other();",
    "if ((a || b || c) as boolean) work();",
    "if ((a || b || c)!) work();",
    "if (<boolean>(a || b || c)) work();",
  ].map((code) => ({
    code,
    errors: [{ messageId: "tooComplex", data: { count: 3 } }],
    output: null,
  })),
});

test("enforces complex-condition rule for TypeScript and tools", async () => {
  for (const filePath of [
    "src/policy-fixture.ts",
    "tools/policy-fixture.mjs",
  ]) {
    const [result] = await eslint.lintText("if (a || b || c) work();", {
      filePath,
    });
    assert.ok(
      result.messages.some(
        ({ ruleId }) => ruleId === "air/no-complex-condition",
      ),
    );
  }
});

ruleTester.run("air/no-delivery-magic-strings", noDeliveryMagicStrings, {
  valid: [
    "if (status === DeliveryStatus.Ready) work();",
    'const value = "ready";',
    'if (status === "custom-status") work();',
  ],
  invalid: [
    'if (status === "ready") work();',
    'if ("review" !== phase) work();',
    'switch (action) { case "advance": break; }',
  ].map((code) => ({
    code,
    errors: [{ messageId: "magic" }],
  })),
});

test("enforces delivery magic-string rule only in production", async () => {
  const [production] = await eslint.lintText(
    'if (status === "ready") work();',
    {
      filePath: "src/delivery/example.ts",
    },
  );
  assert.ok(
    production.messages.some(
      ({ ruleId }) => ruleId === "air/no-delivery-magic-strings",
    ),
  );
  const [testFile] = await eslint.lintText('if (status === "ready") work();', {
    filePath: "src/delivery/example.test.ts",
  });
  assert.ok(
    !testFile.messages.some(
      ({ ruleId }) => ruleId === "air/no-delivery-magic-strings",
    ),
  );
});

ruleTester.run("air/no-webhook-magic-strings", noWebhookMagicStrings, {
  valid: [
    "if (envelope.event === GitHubWebhookEvent.Issues) work();",
    "if (envelope.action !== GitHubIssueAction.Labeled) work();",
    'const event = "issues";',
    'if (other.event === "issues") work();',
  ],
  invalid: [
    'if (envelope.event === "issues") work();',
    'if ("labeled" !== envelope.action) work();',
  ].map((code) => ({
    code,
    errors: [{ messageId: "magic" }],
  })),
});

test("enforces webhook magic-string rule in application production only", async () => {
  const code = 'if (envelope.event === "issues") work();';
  const [production] = await eslint.lintText(code, {
    filePath: "src/application/example.ts",
  });
  assert.ok(
    production.messages.some(
      ({ ruleId }) => ruleId === "air/no-webhook-magic-strings",
    ),
  );
  const [testFile] = await eslint.lintText(code, {
    filePath: "src/application/example.test.ts",
  });
  assert.ok(
    !testFile.messages.some(
      ({ ruleId }) => ruleId === "air/no-webhook-magic-strings",
    ),
  );
});
