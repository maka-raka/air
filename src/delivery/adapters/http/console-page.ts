import { DeliveryPhase, DeliveryStatus } from "../../domain/state-machine.js";
import type { Phase, Status } from "../../domain/state-machine.js";
import { formatCommand } from "../../application/comment-command-parser.js";
import {
  AttentionReason,
  CardTrust,
} from "../../application/delivery-overview.js";
import type {
  DeliveryCard,
  DeliveryOverview,
  NextCommand,
} from "../../application/delivery-overview.js";
import { PhaseStep } from "../../application/delivery-detail.js";
import type {
  DeliveryDetail,
  HistoryItem,
} from "../../application/delivery-detail.js";
import { DeliveryRecordKind } from "../../application/delivery-record.js";
import type {
  DeliveryRecord,
  ReportRecord,
} from "../../application/delivery-record.js";
import type { AgentRun } from "../../application/agent-runs.js";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML content and quoted attributes. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

const PHASES: readonly Phase[] = Object.values(DeliveryPhase);

const PHASE_NAMES: Readonly<Record<Phase, string>> = {
  [DeliveryPhase.Requirements]: "Requirements",
  [DeliveryPhase.Design]: "Design",
  [DeliveryPhase.Build]: "Build",
  [DeliveryPhase.Review]: "Review",
  [DeliveryPhase.Accept]: "Accept",
  [DeliveryPhase.Observe]: "Observe",
};

const STATUS_CLASS: Readonly<Record<Status, string>> = {
  [DeliveryStatus.Ready]: "chip ready",
  [DeliveryStatus.Working]: "chip working",
  [DeliveryStatus.Blocked]: "chip blocked",
  [DeliveryStatus.Waiting]: "chip waiting",
};

const ATTENTION_TEXT: Readonly<Record<AttentionReason, string>> = {
  [AttentionReason.GatePassed]:
    "The gate passed. Read the report, then advance or send it back.",
  [AttentionReason.Blocked]:
    "The agent asked a question. Answer in the issue, then unblock.",
  [AttentionReason.MergeAndDeployStage]:
    "Merge the pull request; the stage deploy moves it to accept.",
  [AttentionReason.ReleaseToProd]:
    "Accepted on staging? Release to prod; the prod deploy moves it to observe.",
  [AttentionReason.ObserveAndClose]:
    "Close the issue when production looks healthy.",
  [AttentionReason.RepairState]:
    "AIR does not trust this state. An administrator has to repair it before anyone acts on it.",
};

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#F6F7F9;color:#14171C;font:15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:#2350C8}a:hover{color:#173A99}
code,.mono,input.cmd{font-family:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
header{background:#FFF;border-bottom:1px solid #E3E6EB}
.bar{max-width:1360px;margin:0 auto;padding:14px 32px;display:flex;flex-wrap:wrap;align-items:center;gap:20px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px}
.repo{font-size:13px;color:#5B6472;font-weight:400}
nav{display:flex;gap:4px;flex-wrap:wrap}
nav a{padding:8px 14px;border-radius:8px;color:#3B4350;font-weight:500;font-size:14px;text-decoration:none}
nav a[aria-current=page]{background:#EEF2FB;color:#1D3F9E;font-weight:600}
.status{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;font-size:13px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border:1px solid #E3E6EB;border-radius:999px;color:#3B4350;background:#FFF}
.pill.dark{background:#14171C;color:#FFF;border-color:#14171C}
.pill.bad{color:#A3261B;border-color:#F3C4BE;background:#FDECEA}
main{max-width:1360px;margin:0 auto;padding:28px 32px 48px;display:flex;flex-direction:column;gap:28px}
h1{margin:0;font-size:22px;letter-spacing:-.01em}h2{margin:0;font-size:18px}h3{margin:0;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#3B4350}
.muted{color:#5B6472;font-size:14px}
.head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.needs{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.card{background:#FFF;border:1px solid #E3E6EB;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.num{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;color:#5B6472}
.title{font-weight:600}
.chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#EEF0F3;color:#3B4350}
.ready{background:#E8EEFC;color:#1D3F9E}.working{background:#E6F4EC;color:#17603A}.blocked{background:#FDECEA;color:#A3261B}.waiting{background:#FFF3DF;color:#8A4B00}
.untrusted,.invalid{background:#FDECEA;color:#A3261B}
label{font-size:12px;font-weight:600;color:#3B4350}
input.cmd{width:100%;height:40px;padding:0 10px;border:1px solid #C9CED6;border-radius:8px;background:#F6F7F9;font-size:13px;color:#14171C}
.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 14px;border-radius:8px;background:#2350C8;color:#FFF;font-weight:600;font-size:14px;text-decoration:none}
.button:hover{background:#173A99;color:#FFF}
.scroll{overflow-x:auto;padding-bottom:8px}
.board{display:grid;grid-template-columns:repeat(6,minmax(200px,1fr));gap:12px;min-width:1240px}
.col{background:#EEF0F3;border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;min-height:240px}
.col .card{padding:12px;gap:6px;border-radius:10px;text-decoration:none;color:#14171C}
.note{font-size:12px;color:#5B6472}
.ok{color:#17603A}.warn{color:#A3261B;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.stat b{display:block;font-size:26px;letter-spacing:-.01em}
table{width:100%;min-width:760px;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#5B6472;padding:8px 10px;border-bottom:1px solid #E3E6EB}
td{padding:10px;border-bottom:1px solid #EEF0F3;vertical-align:top}
.empty{color:#5B6472;font-size:14px;padding:8px 0}
.error{background:#FDECEA;color:#A3261B;border:1px solid #F3C4BE;border-radius:12px;padding:16px}
.split{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}
.split>.wide{flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:20px}
.split>.side{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:20px}
.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
.steps li{display:flex;flex-direction:column;gap:2px;padding:10px;border-radius:8px;font-size:12px}
.steps b{font-size:12px;text-transform:uppercase;letter-spacing:.05em}
.done{background:#E6F4EC;color:#17603A}.skipped{background:#FFF;color:#5B6472;border:1px solid #E3E6EB}
.current{background:#FFF3DF;color:#8A4B00;border:2px solid #E0A23A}.next{background:#F6F7F9;color:#5B6472;border:1px dashed #C9CED6}
.next-step{border:2px solid #2350C8}
.facts{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;font-size:14px}
.facts dt{color:#5B6472}.facts dd{margin:0}
.timeline{list-style:none;margin:0;padding:0}
.timeline li{display:grid;grid-template-columns:150px 1fr;gap:10px;padding:9px 0;border-top:1px solid #EEF0F3;font-size:14px}
@media (max-width:640px){.steps{grid-template-columns:repeat(2,minmax(0,1fr))}.timeline li{grid-template-columns:1fr}}
`;

export type ConsolePageOptions = Readonly<{
  /** `owner/repo`, shown in the header. */
  repository: string;
  /** Where a person reads and comments on an issue. */
  issueUrl: (issue: number) => string;
  /** Where a person reviews a pull request. */
  pullRequestUrl: (pullRequest: number) => string;
  /** Seconds between automatic reloads. */
  refreshSeconds: number;
}>;

export const ConsoleView = { Board: "board", Agents: "agents" } as const;
export type ConsoleView = (typeof ConsoleView)[keyof typeof ConsoleView];

export const ConsolePath = {
  Board: "/",
  Agents: "/agents",
  IssuePrefix: "/issues/",
} as const;

/** The console page of one issue. */
export const issuePath = (issue: number) =>
  `${ConsolePath.IssuePrefix}${issue}`;

const STEP_TEXT: Readonly<Record<PhaseStep, string>> = {
  [PhaseStep.Done]: "Done",
  [PhaseStep.Skipped]: "Skipped",
  [PhaseStep.Current]: "Current",
  [PhaseStep.Next]: "Next",
};

const RECORD_TEXT: Readonly<Record<DeliveryRecord["kind"], string>> = {
  [DeliveryRecordKind.RunStart]: "started a run",
  [DeliveryRecordKind.RunEnd]: "ended a run",
  [DeliveryRecordKind.Report]: "recorded a report",
  [DeliveryRecordKind.Block]: "asked a question",
};

const time = (at: string | null) =>
  at ? escapeHtml(at.slice(0, 16).replace("T", " ")) : "—";

/**
 * Server-rendered pages of the read-only console (ADR-0012). No scripts and
 * no forms: every action is a link to the issue plus the command to post.
 * Every value from the platform is escaped.
 */
export class ConsolePage {
  constructor(private readonly options: ConsolePageOptions) {}

  board(overview: DeliveryOverview, readAt: Date): string {
    return this.layout(
      ConsoleView.Board,
      overview,
      readAt,
      this.needsYou(overview) + this.deliveryBoard(overview),
    );
  }

  agents(overview: DeliveryOverview, readAt: Date): string {
    return this.layout(
      ConsoleView.Agents,
      overview,
      readAt,
      this.agentStats(overview) +
        this.agentRuns(overview) +
        this.launches(overview) +
        this.auditLog(overview),
    );
  }

  issue(
    detail: DeliveryDetail,
    overview: DeliveryOverview,
    readAt: Date,
  ): string {
    const card = detail.card;
    const github = escapeHtml(this.options.issueUrl(card.issue));
    const detailLine = card.trustDetail
      ? `<p class="warn">${escapeHtml(card.trustDetail)}</p>`
      : '<p class="note ok">State written and signed by AIR.</p>';
    const head = `<section aria-labelledby="issue-title" class="head" style="flex-direction:column;align-items:flex-start;gap:8px">
<a href="${ConsolePath.Board}">← Board</a>
<div class="row"><span class="num">#${card.issue}</span><h1 id="issue-title">${escapeHtml(card.title)}</h1>${this.stateChip(card)}${this.trustChip(card)}</div>
${detailLine}
<a href="${github}" rel="noreferrer">Open in GitHub ↗</a></section>`;
    const steps = detail.progress
      .map(
        ({ phase, step }) =>
          `<li class="${step}"><b>${PHASE_NAMES[phase]}</b>${STEP_TEXT[step]}</li>`,
      )
      .join("");
    const progress = `<section aria-labelledby="phases" class="card"><h2 id="phases">Phases</h2><ol class="steps">${steps}</ol></section>`;
    const wide = `<div class="wide">${progress}${this.reports(detail.reports)}${this.timeline(detail.history, detail.records)}</div>`;
    const side = `<div class="side">${this.nextStep(card)}${this.issueRuns(detail.runs)}${this.ignored(detail.ignoredRecords)}</div>`;
    return this.layout(
      ConsoleView.Board,
      overview,
      readAt,
      `${head}<div class="split">${wide}${side}</div>`,
    );
  }

  /** An issue that is not open or carries no AIR state. */
  notFound(issue: string, overview: DeliveryOverview, readAt: Date): string {
    return this.layout(
      ConsoleView.Board,
      overview,
      readAt,
      `<section class="card"><h1>Not in delivery</h1><p class="muted">Issue ${escapeHtml(issue)} is not open or has no AIR state.</p><a href="${ConsolePath.Board}">← Board</a></section>`,
    );
  }

  private reports(reports: readonly ReportRecord[]): string {
    if (reports.length === 0)
      return '<section aria-labelledby="reports" class="card"><h2 id="reports">Phase reports</h2><p class="empty">No trusted report yet.</p></section>';
    const items = reports
      .map((report) => {
        const facts = report.facts;
        const rows = [
          facts.taskSize ? ["Task size", escapeHtml(facts.taskSize)] : null,
          facts.miniDesign === undefined
            ? null
            : ["Mini-design", facts.miniDesign ? "recorded" : "no"],
          facts.verdict ? ["Verdict", escapeHtml(facts.verdict)] : null,
          facts.pullRequest
            ? [
                "Pull request",
                `<a href="${escapeHtml(this.options.pullRequestUrl(facts.pullRequest))}" rel="noreferrer">#${escapeHtml(facts.pullRequest)}</a>`,
              ]
            : null,
          facts.artifact
            ? ["Artifact", `<code>${escapeHtml(facts.artifact)}</code>`]
            : null,
        ]
          .filter((row): row is string[] => row !== null)
          .map(([name, value]) => `<dt>${name}</dt><dd>${value}</dd>`)
          .join("");
        return `<div class="card"><div class="row"><h3>${PHASE_NAMES[report.phase]}</h3><span class="note">signed by the agent · ${time(report.at)} UTC</span></div>${rows ? `<dl class="facts">${rows}</dl>` : '<p class="empty">No facts recorded.</p>'}</div>`;
      })
      .join("");
    return `<section aria-labelledby="reports" style="display:flex;flex-direction:column;gap:12px"><h2 id="reports">Phase reports</h2>${items}<p class="note">The report text is in the issue on GitHub.</p></section>`;
  }

  private timeline(
    history: readonly HistoryItem[],
    records: readonly DeliveryRecord[],
  ): string {
    const states = history.map((item) => ({
      at: item.at,
      html: `<span><b>${escapeHtml(item.by)}</b> set <code>${escapeHtml(`${item.position.phase}:${item.position.status}`)}</code>${item.counts ? "" : ' <span class="chip untrusted">does not count</span>'}</span>`,
    }));
    const agent = records.map((record) => ({
      at: record.at,
      html: `<span><b>agent</b> ${RECORD_TEXT[record.kind]}${record.kind === DeliveryRecordKind.Report ? ` for ${escapeHtml(record.phase)}` : ""}</span>`,
    }));
    const items = [...states, ...agent]
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .map(
        (item) =>
          `<li><span class="mono note">${time(item.at)} UTC</span>${item.html}</li>`,
      )
      .join("");
    return `<section aria-labelledby="timeline" class="card"><h2 id="timeline">Timeline</h2>${items ? `<ol class="timeline">${items}</ol>` : '<p class="empty">No signed history.</p>'}</section>`;
  }

  private nextStep(card: DeliveryCard): string {
    const attention = card.attention;
    if (!attention)
      return `<section aria-labelledby="next" class="card"><h2 id="next">Next step</h2><p class="muted">${card.agentRunning ? "The agent is working." : "Nothing waits for an approver."}</p></section>`;
    const commands = attention.commands
      .map((command, index) => this.commandField(card.issue, command, index))
      .join("");
    return `<section aria-labelledby="next" class="card next-step"><h2 id="next">Your next step</h2>
<p class="muted">${escapeHtml(ATTENTION_TEXT[attention.reason])}</p>${commands}
<a class="button" href="${escapeHtml(this.options.issueUrl(card.issue))}" rel="noreferrer">Post in GitHub as you ↗</a>
<p class="note">The console never posts. Your own account does, so the approval counts.</p></section>`;
  }

  private issueRuns(runs: readonly AgentRun[]): string {
    const items = runs
      .map(
        (run) =>
          `<li><code>${escapeHtml(run.name)}</code> <span class="note">${escapeHtml(run.status)}</span>${run.running ? `<br><code>docker exec -it ${escapeHtml(run.name)} tmux attach -t agent</code>` : ""}</li>`,
      )
      .join("");
    return `<section aria-labelledby="issue-runs" class="card"><h2 id="issue-runs">Agent runs</h2>${items ? `<ul>${items}</ul>` : '<p class="empty">No agent containers for this issue.</p>'}<a href="${ConsolePath.Agents}">All runs →</a></section>`;
  }

  private ignored(count: number): string {
    if (count === 0) return "";
    return `<section class="card"><p class="warn">${count} record${count === 1 ? "" : "s"} on this issue do not count: not written by the agent, edited, or badly signed.</p></section>`;
  }

  /** Shown when the overview could not be read at all. */
  failure(message: string): string {
    return this.document(
      `<main><div class="error" role="alert"><h1>Could not read AIR state</h1><p>${escapeHtml(message)}</p><p>Retrying in ${this.options.refreshSeconds} s.</p></div></main>`,
    );
  }

  private layout(
    view: ConsoleView,
    overview: DeliveryOverview,
    readAt: Date,
    body: string,
  ): string {
    const current = (v: ConsoleView) =>
      v === view ? ' aria-current="page"' : "";
    const running = overview.runs.runs.filter((run) => run.running).length;
    return this.document(`
<header><div class="bar">
<div class="brand">AIR Console <span class="repo mono">${escapeHtml(this.options.repository)}</span></div>
<nav aria-label="Sections"><a href="${ConsolePath.Board}"${current(ConsoleView.Board)}>Board</a><a href="${ConsolePath.Agents}"${current(ConsoleView.Agents)}>Agents &amp; audit</a></nav>
<div class="status">
<span class="pill">Read ${escapeHtml(readAt.toISOString().slice(11, 19))} UTC</span>
<span class="pill">${running} agent${running === 1 ? "" : "s"} running</span>
${this.auditPill(overview)}
<span class="pill dark">Read-only</span>
</div></div></header>
<main>${body}</main>`);
  }

  private auditPill(overview: DeliveryOverview): string {
    const audit = overview.audit;
    if (!audit.available) return '<span class="pill">No audit log</span>';
    if (audit.verified)
      return '<span class="pill ok">Audit chain verified</span>';
    return '<span class="pill bad">Audit chain broken</span>';
  }

  private document(body: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${this.options.refreshSeconds}">
<title>AIR Console · ${escapeHtml(this.options.repository)}</title>
<style>${STYLE}</style></head>
<body>${body}</body></html>`;
  }

  private needsYou(overview: DeliveryOverview): string {
    const cards = overview.needsYou;
    const list =
      cards.length === 0
        ? '<p class="empty">Nothing waits for an approver.</p>'
        : `<div class="needs">${cards.map((card) => this.attentionCard(card)).join("")}</div>`;
    return `<section aria-labelledby="needs-you">
<div class="head"><h1 id="needs-you">Needs you</h1><span class="muted">${cards.length} issue${cards.length === 1 ? "" : "s"}. Post the command in the issue as yourself; the console never posts.</span></div>
${list}</section>`;
  }

  private attentionCard(card: DeliveryCard): string {
    const attention = card.attention;
    if (!attention) return "";
    const commands = attention.commands
      .map((command, index) => this.commandField(card.issue, command, index))
      .join("");
    return `<article class="card">
<div class="row"><span class="num">#${card.issue}</span>${this.stateChip(card)}${this.trustChip(card)}</div>
<div class="title">${escapeHtml(card.title)}</div>
<div class="muted">${escapeHtml(ATTENTION_TEXT[attention.reason])}</div>
${card.trustDetail ? `<div class="note">${escapeHtml(card.trustDetail)}</div>` : ""}
${commands}
<a class="button" href="${escapeHtml(this.options.issueUrl(card.issue))}" rel="noreferrer">Open issue #${card.issue} ↗</a>
<a href="${issuePath(card.issue)}">Details</a>
</article>`;
  }

  private commandField(
    issue: number,
    command: NextCommand,
    index: number,
  ): string {
    const line = formatCommand(command.action, command.target);
    if (!line) return "";
    const id = `cmd-${issue}-${index}`;
    return `<div><label for="${id}">Command</label><input class="cmd" id="${id}" readonly value="${escapeHtml(line)}"></div>`;
  }

  private deliveryBoard(overview: DeliveryOverview): string {
    const columns = PHASES.map((phase) => {
      const cards = overview.cards.filter(
        (card) => card.position?.phase === phase,
      );
      return `<div class="col"><div class="row"><h3>${PHASE_NAMES[phase]}</h3><span class="note">${cards.length}</span></div>${cards.map((card) => this.boardCard(card)).join("")}</div>`;
    }).join("");
    const invalid = overview.cards.filter((card) => !card.position);
    const broken =
      invalid.length === 0
        ? ""
        : `<p class="warn">Malformed state on ${invalid.map((card) => `#${card.issue}`).join(", ")}.</p>`;
    return `<section aria-labelledby="board">
<div class="head"><h2 id="board">Delivery board</h2><span class="muted">${overview.cards.length} open issue${overview.cards.length === 1 ? "" : "s"} with AIR state</span></div>
${broken}<div class="scroll"><div class="board">${columns}</div></div></section>`;
  }

  private boardCard(card: DeliveryCard): string {
    const extras = [
      card.agentRunning ? '<span class="note ok">Agent running</span>' : "",
      card.launchQueued ? '<span class="note">Agent launch queued</span>' : "",
    ].join("");
    return `<a class="card" href="${issuePath(card.issue)}">
<span class="row"><span class="num">#${card.issue}</span>${this.stateChip(card)}${this.trustChip(card)}</span>
<span class="title">${escapeHtml(card.title)}</span>${extras}</a>`;
  }

  private stateChip(card: DeliveryCard): string {
    const position = card.position;
    if (!position) return '<span class="chip invalid">malformed</span>';
    return `<span class="${STATUS_CLASS[position.status]}">${escapeHtml(`${position.phase}:${position.status}`)}</span>`;
  }

  private trustChip(card: DeliveryCard): string {
    if (card.trust !== CardTrust.Untrusted) return "";
    return '<span class="chip untrusted">untrusted</span>';
  }

  private agentStats(overview: DeliveryOverview): string {
    const running = overview.runs.runs.filter((run) => run.running).length;
    const denied = overview.audit.recent.filter(
      ({ event }) => !event.allowed,
    ).length;
    const stat = (label: string, value: number, note: string) =>
      `<div class="card stat"><span class="muted">${label}</span><b>${value}</b><span class="note">${note}</span></div>`;
    return `<section aria-label="Summary" class="stats">
${stat("Running agents", running, overview.runs.at ? `as of ${escapeHtml(overview.runs.at)}` : "launcher has not reported yet")}
${stat("Queued launches", overview.queued.length, "waiting for a free slot or for a run to end")}
${stat("Failed launches", overview.failed.length, "kept for inspection, never retried")}
${stat("Recent denials", denied, `in the last ${overview.audit.recent.length} audit events`)}
</section>`;
  }

  private agentRuns(overview: DeliveryOverview): string {
    const runs = overview.runs.runs;
    const rows = runs
      .map(
        (run) => `<tr>
<td><a href="${escapeHtml(this.options.issueUrl(run.issue))}" rel="noreferrer">#${run.issue}</a></td>
<td>${escapeHtml(run.phase ?? "—")}</td>
<td><span class="chip ${run.running ? "working" : ""}">${escapeHtml(run.status || (run.running ? "running" : "stopped"))}</span></td>
<td><code>docker exec -it ${escapeHtml(run.name)} tmux attach -t agent</code></td>
</tr>`,
      )
      .join("");
    const table =
      runs.length === 0
        ? '<p class="empty">No agent containers.</p>'
        : `<div class="scroll"><table><thead><tr><th scope="col">Issue</th><th scope="col">Phase</th><th scope="col">Status</th><th scope="col">Attach</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return `<section aria-labelledby="runs" class="card"><h2 id="runs">Agent runs</h2>${table}</section>`;
  }

  private launches(overview: DeliveryOverview): string {
    const queued = overview.queued
      .map(
        ({ id, launch }) =>
          `<li><code>${escapeHtml(id)}</code> <span class="note">requested ${escapeHtml(launch.requestedAt)}</span></li>`,
      )
      .join("");
    const failed = overview.failed
      .map(
        (failure) =>
          `<li><code>${escapeHtml(failure.id)}</code> <span class="warn">${escapeHtml(failure.error || "unknown error")}</span></li>`,
      )
      .join("");
    return `<section aria-labelledby="queue" class="card"><h2 id="queue">Launch queue</h2>
${queued ? `<ul>${queued}</ul>` : '<p class="empty">Nothing queued.</p>'}
<h3>Failed</h3>
${failed ? `<ul>${failed}</ul>` : '<p class="empty">No failed launches.</p>'}
</section>`;
  }

  private auditLog(overview: DeliveryOverview): string {
    const audit = overview.audit;
    if (!audit.available)
      return '<section aria-labelledby="audit" class="card"><h2 id="audit">Audit log</h2><p class="empty">No audit log mounted.</p></section>';
    const state = audit.verified
      ? `<span class="chip working">Chain verified · ${audit.total} events</span>`
      : `<span class="chip blocked">Chain broken: ${escapeHtml(audit.problem ?? "")}</span>`;
    const rows = audit.recent
      .map(
        ({ at, event }) => `<tr>
<td class="mono">${escapeHtml(at.slice(0, 19).replace("T", " "))}</td>
<td class="mono">${escapeHtml(event.kind)}</td>
<td>#${escapeHtml(event.issue)}</td>
<td><span class="chip ${event.allowed ? "working" : "blocked"}">${escapeHtml(event.reason)}</span></td>
</tr>`,
      )
      .join("");
    return `<section aria-labelledby="audit" class="card"><div class="row"><h2 id="audit">Audit log</h2>${state}</div>
<div class="scroll"><table><thead><tr><th scope="col">Time (UTC)</th><th scope="col">Kind</th><th scope="col">Issue</th><th scope="col">Outcome</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
  }
}
