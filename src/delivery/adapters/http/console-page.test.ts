import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConsolePage, escapeHtml } from "./console-page.js";
import {
  AttentionReason,
  CardTrust,
} from "../../application/delivery-overview.js";
import type {
  DeliveryCard,
  DeliveryOverview,
} from "../../application/delivery-overview.js";
import { AuditKind } from "../../application/audit.js";
import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryStatus,
} from "../../domain/state-machine.js";

const page = new ConsolePage({
  repository: "example/app",
  issueUrl: (issue) => `https://github.com/example/app/issues/${issue}`,
  refreshSeconds: 30,
});

const READ_AT = new Date("2026-11-19T11:30:05Z");

const card = (overrides: Partial<DeliveryCard>): DeliveryCard => ({
  issue: 41,
  title: "Rate limit for public API",
  position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Waiting },
  trust: CardTrust.Trusted,
  trustDetail: null,
  attention: null,
  agentRunning: false,
  launchQueued: false,
  ...overrides,
});

const waiting = card({
  attention: {
    reason: AttentionReason.GatePassed,
    commands: [
      { action: DeliveryAction.Advance, target: DeliveryPhase.Review },
      { action: DeliveryAction.Rework },
    ],
  },
});

const hostile = card({
  issue: 58,
  title: '<script>alert(1)</script> "x" & y',
  position: { phase: DeliveryPhase.Requirements, status: DeliveryStatus.Ready },
  trust: CardTrust.Untrusted,
  trustDetail: "The current state was set by <img src=x>, not by AIR.",
  attention: { reason: AttentionReason.RepairState, commands: [] },
});

const overview = (
  overrides: Partial<DeliveryOverview> = {},
): DeliveryOverview => ({
  cards: [waiting, hostile, card({ issue: 49, agentRunning: true })],
  needsYou: [hostile, waiting],
  runs: {
    at: "2026-11-19T11:30:00.000Z",
    runs: [
      {
        name: "air-agent-49-build-x",
        issue: 49,
        phase: DeliveryPhase.Build,
        running: true,
        status: "Up 6 minutes",
      },
    ],
  },
  queued: [],
  failed: [
    {
      id: "33-review.json.failed",
      issue: 33,
      phase: DeliveryPhase.Review,
      error: "no such service: <agent>",
    },
  ],
  audit: {
    available: true,
    verified: true,
    problem: null,
    total: 2,
    recent: [
      {
        at: "2026-11-19T11:24:00.000Z",
        event: {
          kind: AuditKind.Command,
          issue: 41,
          allowed: false,
          reason: "not-authorized",
        },
      },
    ],
  },
  ...overrides,
});

describe("escapeHtml", () => {
  it("escapes markup and quotes", () => {
    assert.equal(
      escapeHtml(`<a href="x">'&'</a>`),
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("ConsolePage.board", () => {
  const html = page.board(overview(), READ_AT);

  it("lists what needs a person, with commands the parser accepts", () => {
    assert.match(html, /Needs you/);
    assert.match(html, /value="\/air advance review"/);
    assert.match(html, /value="\/air rework"/);
    assert.match(html, /href="https:\/\/github.com\/example\/app\/issues\/41"/);
  });

  it("shows untrusted states and never offers a command for them", () => {
    assert.match(html, /chip untrusted/);
    assert.match(html, /An administrator has to repair it/);
    assert.doesNotMatch(html, /id="cmd-58-/);
  });

  it("escapes every value from the platform", () => {
    assert.doesNotMatch(html, /<script>/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("has no scripts or forms and refreshes itself", () => {
    assert.doesNotMatch(html, /<script|<form|onclick=/i);
    assert.match(html, /http-equiv="refresh" content="30"/);
  });

  it("puts cards in their phase column and marks running agents", () => {
    assert.match(html, /<h3>Build<\/h3><span class="note">2<\/span>/);
    assert.match(html, /Agent running/);
  });

  it("says when nothing waits", () => {
    assert.match(
      page.board(overview({ needsYou: [] }), READ_AT),
      /Nothing waits for an approver/,
    );
  });
});

describe("ConsolePage.agents", () => {
  const html = page.agents(overview(), READ_AT);

  it("shows runs with the attach command", () => {
    assert.match(
      html,
      /docker exec -it air-agent-49-build-x tmux attach -t agent/,
    );
  });

  it("shows failed launches escaped", () => {
    assert.match(html, /33-review.json.failed/);
    assert.match(html, /no such service: &lt;agent&gt;/);
  });

  it("shows the audit chain and denials", () => {
    assert.match(html, /Chain verified · 2 events/);
    assert.match(html, /not-authorized/);
  });

  it("reports a broken chain and a missing log", () => {
    const broken = page.agents(
      overview({
        audit: {
          available: true,
          verified: false,
          problem: "line 3: previous hash does not match",
          total: 3,
          recent: [],
        },
      }),
      READ_AT,
    );
    assert.match(broken, /Chain broken: line 3/);
    assert.match(broken, /Audit chain broken/);
    const missing = page.agents(
      overview({
        audit: {
          available: false,
          verified: null,
          problem: null,
          total: 0,
          recent: [],
        },
      }),
      READ_AT,
    );
    assert.match(missing, /No audit log mounted/);
  });
});

describe("ConsolePage.failure", () => {
  it("shows the error escaped", () => {
    const html = page.failure("GitHub said <no>");
    assert.match(html, /role="alert"/);
    assert.match(html, /GitHub said &lt;no&gt;/);
  });
});
