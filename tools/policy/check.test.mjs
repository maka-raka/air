import { ScriptNameValidator } from "./check.mjs";
import assert from "node:assert/strict";

const validator = new ScriptNameValidator();
const valid = Object.freeze({
  "architecture:check": "x",
  "policy:check": "y",
  "format:write": "z",
  build: "x",
  test: "x",
  typecheck: "x",
});
assert.deepEqual(validator.validate(valid), []);
assert.deepEqual(validator.validate(valid), []);
assert.deepEqual(validator.validate({ "check:architecture": "x" }), [
  {
    ruleId: "scripts.naming",
    message: "Expected entity:action",
    script: "check:architecture",
  },
]);
for (const name of [
  "CheckArchitecture",
  "domain:unknown",
  "domain:test:unit",
  "domain:",
]) {
  assert.equal(validator.validate({ [name]: "x" }).length, 1, name);
}
assert.deepEqual(validator.validate({ "domain:test": "x" }), []);
console.log("Policy naming validator passed");
