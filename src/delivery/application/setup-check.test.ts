import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CheckSetup } from "./setup-check.js";
import type { SetupFacts } from "./setup-check.js";
import { AccountRole, AuditStatus } from "./repository-audit.js";
import type { Known } from "./repository-audit.js";
import type { DeliveryPolicy } from "./code-change-check.js";
import { LensRules } from "../domain/lens-rules.js";
import { ProtectedPaths } from "../domain/protected-paths.js";

const policy: DeliveryPolicy = {
  protectedPaths: new ProtectedPaths([]),
  lenses: new LensRules(
    ["code", "tests"],
    [],
    new Map([["high", ["security"]]]),
  ),
  reviewRounds: 2,
};

type Fakes = Readonly<{
  owners?: Readonly<Record<string, Known<string>>>;
  match?: Known<boolean>;
  loaded?: DeliveryPolicy | null;
  installed?: Known<readonly string[]>;
}>;

function check(facts: SetupFacts, fakes: Fakes = {}) {
  return new CheckSetup(
    {
      owner: async (token) =>
        fakes.owners?.[token] ?? { known: true, value: "air-operator" },
    },
    { matches: () => fakes.match ?? { known: true, value: true } },
    { load: async () => (fakes.loaded === undefined ? policy : fakes.loaded) },
    {
      installed: async () =>
        fakes.installed ?? {
          known: true,
          value: ["code", "security", "tests", "ux"],
        },
    },
  ).run(facts);
}

const operator = {
  role: AccountRole.Operator,
  login: "air-operator",
  tokenName: "AIR_OPERATOR_TOKEN",
};
const nothing: SetupFacts = { credentials: [], launchPhases: [] };
const byId = async (facts: SetupFacts, fakes?: Fakes) =>
  Object.fromEntries(
    (await check(facts, fakes)).map((f) => [f.id, [f.status, f.message]]),
  );

describe("CheckSetup", () => {
  it("passes a token of the configured account, ignoring case", async () => {
    const findings = await byId(
      { ...nothing, credentials: [{ ...operator, token: "t1" }] },
      { owners: { t1: { known: true, value: "AIR-Operator" } } },
    );

    assert.deepEqual(findings["setup.token.operator"], [
      AuditStatus.Pass,
      "AIR_OPERATOR_TOKEN belongs to operator air-operator",
    ]);
  });

  it("fails a token that belongs to another account", async () => {
    const findings = await byId(
      { ...nothing, credentials: [{ ...operator, token: "t1" }] },
      { owners: { t1: { known: true, value: "alice" } } },
    );

    assert.deepEqual(findings["setup.token.operator"], [
      AuditStatus.Fail,
      "AIR_OPERATOR_TOKEN belongs to alice, not to operator air-operator",
    ]);
  });

  it("reports a token it can't check as unknown, and skips absent ones", async () => {
    const findings = await byId(
      {
        ...nothing,
        credentials: [
          { ...operator, token: "t1" },
          { ...operator, role: AccountRole.Agent },
        ],
      },
      { owners: { t1: { known: false, reason: "Token owner unknown" } } },
    );

    assert.equal(findings["setup.token.operator"]?.[0], AuditStatus.Unknown);
    assert.equal(findings["setup.token.agent"], undefined);
  });

  it("fails a signing key that doesn't match its public key", async () => {
    const keyed = { ...operator, signingKey: "s", publicKey: "p" };

    assert.equal(
      (
        await byId(
          { ...nothing, credentials: [keyed] },
          { match: { known: true, value: false } },
        )
      )["setup.key.operator"]?.[0],
      AuditStatus.Fail,
    );
    assert.equal(
      (await byId({ ...nothing, credentials: [keyed] }))[
        "setup.key.operator"
      ]?.[0],
      AuditStatus.Pass,
    );
    assert.equal(
      (
        await byId({
          ...nothing,
          credentials: [{ ...operator, signingKey: "s" }],
        })
      )["setup.key.operator"],
      undefined,
    );
  });

  it("fails an invalid policy", async () => {
    assert.equal(
      (await byId(nothing, { loaded: null }))["setup.policy"]?.[0],
      AuditStatus.Fail,
    );
  });

  it("names the required lenses that aren't installed", async () => {
    const findings = await byId(nothing, {
      installed: { known: true, value: ["code"] },
    });

    assert.deepEqual(findings["setup.lenses"], [
      AuditStatus.Fail,
      "The policy requires lenses that are not installed: security, tests; reviews needing them can't pass",
    ]);
  });

  it("warns when launched runs aren't headless", async () => {
    const launched = { ...nothing, launchPhases: ["build"] };

    assert.equal(
      (await byId(launched))["setup.agent-mode"]?.[0],
      AuditStatus.Warn,
    );
    assert.equal(
      (await byId({ ...launched, agentMode: "headless" }))["setup.agent-mode"],
      undefined,
    );
    assert.equal(
      (await byId({ ...nothing, agentMode: "unattended" }))[
        "setup.agent-mode"
      ]?.[0],
      AuditStatus.Fail,
    );
  });
});
