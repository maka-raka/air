import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConsolePage, escapeHtml, formatDuration } from "./console-page.js";
import {
  AttentionReason,
  CardTrust,
} from "../../application/delivery-overview.js";
import type {
  DeliveryCard,
  DeliveryOverview,
} from "../../application/delivery-overview.js";
import { AuditKind } from "../../application/audit.js";
import { PhaseStep } from "../../application/delivery-detail.js";
import type { DeliveryDetail } from "../../application/delivery-detail.js";
import { DeliveryRecordKind } from "../../application/delivery-record.js";
import {
  DeliveryAction,
  DeliveryPhase,
  DeliveryStatus,
} from "../../domain/state-machine.js";
import { DeliveryFlow, FlowOwner } from "../../domain/delivery-flow.js";

const HOUR = 60 * 60 * 1000;

const page = new ConsolePage({
  repository: "example/app",
  issueUrl: (issue) => `https://github.com/example/app/issues/${issue}`,
  pullRequestUrl: (pull) => `https://github.com/example/app/pull/${pull}`,
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
  flow: {
    measuredAt: READ_AT.toISOString(),
    phases: [
      {
        phase: DeliveryPhase.Requirements,
        total: { count: 3, p50: 5 * HOUR, p90: 26 * HOUR },
        p50ByOwner: {
          [FlowOwner.Human]: 3 * HOUR,
          [FlowOwner.Agent]: HOUR,
          [FlowOwner.Queue]: HOUR,
        },
      },
    ],
    leadTime: { count: 2, p50: 50 * HOUR, p90: 80 * HOUR },
    totals: {
      [FlowOwner.Human]: 6 * HOUR,
      [FlowOwner.Agent]: 3 * HOUR,
      [FlowOwner.Queue]: HOUR,
      total: 10 * HOUR,
    },
    humanQueue: [
      {
        issue: 77,
        title: "<b>slow</b> approval",
        position: {
          phase: DeliveryPhase.Build,
          status: DeliveryStatus.Waiting,
        },
        reason: AttentionReason.GatePassed,
        since: "2026-11-18T09:30:00.000Z",
        waitedMs: 26 * HOUR,
      },
    ],
    throughput: {
      available: true,
      problem: null,
      closedLast7Days: 4,
      closedLast28Days: 11,
    },
    sample: { open: 3, closed: 2 },
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
    assert.match(html, /href="\/issues\/41">Details/);
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

  it("links board cards to the console issue page", () => {
    assert.match(html, /<a class="card" href="\/issues\/49">/);
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

const detail: DeliveryDetail = {
  card: waiting,
  progress: [
    { phase: DeliveryPhase.Requirements, step: PhaseStep.Done },
    { phase: DeliveryPhase.Design, step: PhaseStep.Skipped },
    { phase: DeliveryPhase.Build, step: PhaseStep.Current },
    { phase: DeliveryPhase.Review, step: PhaseStep.Next },
    { phase: DeliveryPhase.Accept, step: PhaseStep.Next },
    { phase: DeliveryPhase.Observe, step: PhaseStep.Next },
  ],
  history: [
    {
      position: { phase: DeliveryPhase.Review, status: DeliveryStatus.Ready },
      at: "2026-11-19T11:00:00Z",
      by: "<mallory>",
      counts: false,
    },
    {
      position: { phase: DeliveryPhase.Build, status: DeliveryStatus.Waiting },
      at: "2026-11-19T10:58:00Z",
      by: "air-agent",
      counts: true,
    },
  ],
  records: [
    {
      kind: DeliveryRecordKind.Report,
      phase: DeliveryPhase.Build,
      at: "2026-11-19T10:57:00Z",
      facts: { pullRequest: 88, artifact: "<dist>" },
    },
  ],
  ignoredRecords: 1,
  reports: [
    {
      kind: DeliveryRecordKind.Report,
      phase: DeliveryPhase.Build,
      at: "2026-11-19T10:57:00Z",
      facts: { pullRequest: 88, artifact: "<dist>" },
    },
  ],
  runs: [
    {
      name: "air-agent-41-build-x",
      issue: 41,
      phase: DeliveryPhase.Build,
      running: true,
      status: "Up 3 minutes",
    },
  ],
  flow: DeliveryFlow.of(
    [
      {
        position: {
          phase: DeliveryPhase.Requirements,
          status: DeliveryStatus.Working,
        },
        at: Date.parse("2026-11-19T07:30:00Z"),
      },
      {
        position: {
          phase: DeliveryPhase.Build,
          status: DeliveryStatus.Waiting,
        },
        at: Date.parse("2026-11-19T09:30:00Z"),
      },
    ],
    READ_AT.getTime(),
  ),
};

describe("ConsolePage.issue", () => {
  const html = page.issue(detail, overview(), READ_AT);

  it("shows the state, trust and phase progress", () => {
    assert.match(html, /Rate limit for public API/);
    assert.match(html, /build:waiting/);
    assert.match(html, /State written and signed by AIR/);
    assert.match(html, /<li class="skipped"><b>Design<\/b>Skipped<\/li>/);
    assert.match(html, /<li class="current"><b>Build<\/b>Current<\/li>/);
  });

  it("shows the next commands and links to GitHub to post them", () => {
    assert.match(html, /Your next step/);
    assert.match(html, /value="\/air advance review"/);
    assert.match(html, /Post in GitHub as you/);
  });

  it("shows reports with a pull request link, escaped", () => {
    assert.match(html, /href="https:\/\/github.com\/example\/app\/pull\/88"/);
    assert.match(html, /&lt;dist&gt;/);
  });

  it("marks history that does not count and escapes the author", () => {
    assert.match(
      html,
      /&lt;mallory&gt;<\/b> set <code>review:ready<\/code> <span class="chip untrusted">does not count/,
    );
    assert.match(html, /agent<\/b> recorded a report for build/);
  });

  it("warns about ignored records and lists this issue's runs", () => {
    assert.match(html, /1 record on this issue do not count/);
    assert.match(
      html,
      /docker exec -it air-agent-41-build-x tmux attach -t agent/,
    );
  });

  it("shows an untrusted state's reason", () => {
    const untrusted = page.issue(
      { ...detail, card: hostile },
      overview(),
      READ_AT,
    );
    assert.match(
      untrusted,
      /class="warn">The current state was set by &lt;img src=x&gt;/,
    );
    assert.doesNotMatch(untrusted, /id="cmd-58-/);
  });

  it("says when an issue is not in delivery", () => {
    assert.match(
      page.notFound("<7>", overview(), READ_AT),
      /Issue &lt;7&gt; is not open/,
    );
  });
});

describe("ConsolePage intake and review facts", () => {
  it("shows recommendation, risk, lenses and the reject advice", () => {
    const report = {
      kind: DeliveryRecordKind.Report,
      phase: DeliveryPhase.Requirements,
      at: "2026-11-19T09:29:00Z",
      facts: {
        recommendation: "reject",
        risk: "high",
        lenses: ["code", "security"],
      },
    } as const;
    const html = page.issue(
      {
        ...detail,
        card: card({
          position: {
            phase: DeliveryPhase.Requirements,
            status: DeliveryStatus.Waiting,
          },
          attention: {
            reason: AttentionReason.RejectRecommended,
            commands: [
              { action: DeliveryAction.Close },
              { action: DeliveryAction.Rework },
            ],
          },
        }),
        reports: [report],
      },
      overview(),
      READ_AT,
    );
    assert.match(html, /<dt>Recommendation<\/dt><dd>reject<\/dd>/);
    assert.match(html, /<dt>Risk<\/dt><dd>high<\/dd>/);
    assert.match(html, /<dt>Review lenses<\/dt><dd>code, security<\/dd>/);
    assert.match(html, /advises not to build this/);
    assert.match(html, /value="\/air close"/);
    assert.doesNotMatch(html, /value="\/air advance/);
  });
});

describe("formatDuration", () => {
  it("uses the two largest units", () => {
    assert.equal(formatDuration(45 * 60 * 1000), "45m");
    assert.equal(formatDuration(3 * HOUR + 20 * 60 * 1000), "3h 20m");
    assert.equal(formatDuration(52 * HOUR), "2d 4h");
    assert.equal(formatDuration(-5), "0m");
  });
});

describe("ConsolePage flow metrics", () => {
  it("shows where time goes on the board", () => {
    const html = page.board(overview(), READ_AT);

    assert.match(html, /Where the time goes/);
    assert.match(html, /Time waiting on people<\/span><b>60%<\/b>/);
    assert.match(html, /Closed, last 7 days<\/span><b>4<\/b>/);
    assert.match(html, /11 in the last 28 days/);
    assert.match(html, /Lead time, median<\/span><b>2d 2h<\/b>/);
    assert.match(
      html,
      /<td>Requirements<\/td>\n<td>5h 0m <span class="note">p90 1d 2h · n=3/,
    );
  });

  it("lists the human-wait queue, escaped, with what it needs", () => {
    const html = page.board(overview(), READ_AT);

    assert.match(html, /Human-wait queue/);
    assert.match(
      html,
      /href="\/issues\/77">#77<\/a> &lt;b&gt;slow&lt;\/b&gt; approval/,
    );
    assert.match(html, /Approve or send back/);
    assert.match(html, /<b>1d 2h<\/b>/);
    assert.doesNotMatch(html, /<b>slow<\/b>/);
  });

  it("says why closed issues are not counted", () => {
    const base = overview();
    const html = page.board(
      overview({
        flow: {
          ...base.flow,
          humanQueue: [],
          leadTime: null,
          throughput: {
            available: false,
            problem:
              "The audit chain is broken; closed issues are not counted.",
            closedLast7Days: 0,
            closedLast28Days: 0,
          },
        },
      }),
      READ_AT,
    );

    assert.match(html, /The audit chain is broken/);
    assert.match(html, /No trusted issue waits on a person/);
    assert.match(html, /no closed issue in the window/);
  });

  it("shows where the issue's time went on its page", () => {
    const html = page.issue(detail, overview(), READ_AT);

    assert.match(html, /Where the time went/);
    assert.match(
      html,
      /In <code>build:waiting<\/code> for <b>2h 0m<\/b> · waiting on people/,
    );
    assert.match(
      html,
      /<td>Requirements<\/td><td><b>2h 0m<\/b><\/td><td>0m<\/td><td>2h 0m<\/td>/,
    );
    assert.match(html, /Build <span class="note">\(now\)<\/span>/);
    assert.match(html, /2h 0m so far/);
  });

  it("says when an issue has no timed history", () => {
    const html = page.issue(
      { ...detail, flow: DeliveryFlow.of([], READ_AT.getTime()) },
      overview(),
      READ_AT,
    );

    assert.match(html, /No counted, timed state anchor yet/);
  });
});
