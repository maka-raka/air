import assert from "node:assert/strict";
import { ArchitectureValidator } from "./check.mjs";
const validator = new ArchitectureValidator();
const model = {
  components: [
    { id: "domain", paths: ["src/domain/**"], dependencies: [] },
    {
      id: "application",
      paths: ["src/application/**"],
      dependencies: ["domain"],
    },
    {
      id: "adapter",
      paths: ["src/adapters/**"],
      dependencies: ["application"],
    },
  ],
};
assert.equal(validator.owner("src/domain/entity.ts", model).id, "domain");
assert.throws(
  () => validator.owner("src/unmapped/rogue.ts", model),
  /exactly one/,
);
assert.throws(
  () =>
    validator.verifyDependency(
      "src/domain/entity.ts",
      "src/adapters/db.ts",
      model,
    ),
  /Forbidden/,
);
assert.doesNotThrow(() =>
  validator.verifyDependency(
    "src/application/use-case.ts",
    "src/domain/entity.ts",
    model,
  ),
);
assert.throws(
  () =>
    validator.owner("src/domain/entity.ts", {
      components: [
        ...model.components,
        { id: "duplicate", paths: ["src/domain/**"], dependencies: [] },
      ],
    }),
  /exactly one/,
);
console.log("Architecture conformance negative fixtures passed");

const productionModel = {
  components: [
    { id: "delivery-domain", paths: ["src/delivery/**"], dependencies: [] },
    {
      id: "delivery-application",
      paths: ["src/application/**"],
      dependencies: ["delivery-domain"],
    },
    {
      id: "github-infrastructure",
      paths: ["src/github/**"],
      dependencies: ["delivery-domain"],
    },
    {
      id: "policy-domain",
      paths: ["src/policy/domain/**"],
      dependencies: [],
    },
    {
      id: "policy-application",
      paths: ["src/policy/application/**"],
      dependencies: ["policy-domain"],
    },
    {
      id: "policy-adapters",
      paths: ["src/policy/adapters/**"],
      dependencies: ["policy-domain", "policy-application"],
    },
    {
      id: "policy-composition",
      paths: ["src/policy/composition/**"],
      dependencies: ["policy-domain", "policy-application", "policy-adapters"],
    },
  ],
};

const allowedDependencies = [
  ["src/application/command.ts", "src/delivery/state-machine.ts"],
  ["src/github/store.ts", "src/delivery/state-machine.ts"],
  ["src/policy/application/use-case.ts", "src/policy/domain/policy.ts"],
  ["src/policy/adapters/repository.ts", "src/policy/application/port.ts"],
  ["src/policy/composition/root.ts", "src/policy/adapters/repository.ts"],
];
for (const [source, target] of allowedDependencies) {
  assert.doesNotThrow(() =>
    validator.verifyDependency(source, target, productionModel),
  );
}

const forbiddenDependencies = [
  ["src/delivery/state-machine.ts", "src/application/command.ts"],
  ["src/delivery/state-machine.ts", "src/github/store.ts"],
  ["src/application/command.ts", "src/github/store.ts"],
  ["src/policy/domain/policy.ts", "src/policy/adapters/repository.ts"],
  ["src/policy/application/use-case.ts", "src/policy/adapters/repository.ts"],
  ["src/policy/adapters/repository.ts", "src/policy/composition/root.ts"],
];
for (const [source, target] of forbiddenDependencies) {
  assert.throws(
    () => validator.verifyDependency(source, target, productionModel),
    /Forbidden dependency/,
  );
}
console.log("Architecture layer-boundary regression fixtures passed");
