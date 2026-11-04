import assert from "node:assert/strict";
import { test } from "node:test";
import { ESLint } from "eslint";

const eslint = new ESLint();

async function violations(code) {
  const [result] = await eslint.lintText(code, { filePath: "src/policy-fixture.ts" });
  return result.messages.filter(({ severity }) => severity === 2);
}

test("rejects nested if blocks", async () => {
  const messages = await violations("if (user) { if (user.active) { work(); } }");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects nested ternaries", async () => {
  const messages = await violations("const value = a ? b : c ? d : e;");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-nested-ternary"));
});

test("allows guard clauses", async () => {
  assert.deepEqual(await violations("function run(user) { if (!user) return; if (!user.active) return; work(); }"), []);
});

test("allows else-if chains", async () => {
  assert.deepEqual(await violations("if (a) { work(); } else if (b) { other(); }"), []);
});

test("allows simple ternaries", async () => {
  assert.deepEqual(await violations("const value = active ? enabled : disabled;"), []);
});

test("rejects nested if inside else blocks", async () => {
  const messages = await violations("if (a) { work(); } else { if (b) { other(); } }");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects nested if through an intermediate block", async () => {
  const messages = await violations("if (a) { for (const item of items) { if (item) { work(); } } }");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-restricted-syntax"));
});

test("rejects ternaries nested in the true branch", async () => {
  const messages = await violations("const value = a ? (b ? c : d) : e;");
  assert.ok(messages.some(({ ruleId }) => ruleId === "no-nested-ternary"));
});
