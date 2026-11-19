import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DemoMode } from "./demo-mode.js";

const env = { AIR_REPOSITORY: "me/air-demo" };

describe("DemoMode.fromEnv", () => {
  it("is off without the marker", () => {
    assert.equal(DemoMode.fromEnv(env), null);
    assert.equal(DemoMode.fromEnv({ ...env, AIR_DEMO: " " }), null);
  });

  it("is on when the marker names the configured repository", () => {
    const demo = DemoMode.fromEnv({ ...env, AIR_DEMO: "Me/Air-Demo" });

    assert.equal(demo?.repository, "me/air-demo");
  });

  it("refuses a marker for another repository", () => {
    assert.throws(
      () =>
        DemoMode.fromEnv({
          AIR_REPOSITORY: "acme/prod",
          AIR_DEMO: "me/air-demo",
        }),
      /AIR_DEMO=me\/air-demo does not match AIR_REPOSITORY=acme\/prod/,
    );
  });

  it("refuses a marker without a repository", () => {
    assert.throws(
      () => DemoMode.fromEnv({ AIR_DEMO: "me/air-demo" }),
      /AIR_REPOSITORY/,
    );
  });
});

describe("DemoMode.banner", () => {
  it("names the repository and says it is not production-safe", () => {
    const demo = DemoMode.fromEnv({ ...env, AIR_DEMO: "me/air-demo" });

    const banner = demo?.banner() ?? "";

    assert.match(banner, /AIR DEMO MODE \(me\/air-demo\): NOT PRODUCTION-SAFE/);
    assert.match(banner, /air doctor` fails/);
  });
});
