import { randomUUID } from "node:crypto";
import { AgentCommands } from "../application/agent-commands.js";
import { ReadAgentContext } from "../application/agent-context.js";
import type { AuditPort } from "../application/audit.js";
import { CommentCommandHandler } from "../application/comment-command-handler.js";
import { TrustedDeliveryRecords } from "../application/delivery-record.js";
import { ExecuteDeliveryCommand } from "../application/execute-delivery-command.js";
import { IngestHumanCommand } from "../application/ingest-human-command.js";
import { EvaluatePhaseGate } from "../application/phase-gate.js";
import { RecordDeployment } from "../application/record-deployment.js";
import { RecordedDeliveryEvidence } from "../application/recorded-delivery-evidence.js";
import { StateAnchorMode, TrustPolicy } from "../domain/trust-policy.js";
import { InMemoryDeliveryClaims } from "../adapters/local/in-memory-delivery-claims.js";
import { HashChainedAuditLog } from "../adapters/local/hash-chained-audit-log.js";
import {
  MemoryAccountPreflight,
  MemoryAuthorAccess,
} from "../adapters/memory/memory-account-access.js";
import { MemoryAuditLines } from "../adapters/memory/memory-audit-lines.js";
import { MemoryCodeChangeAdapter } from "../adapters/memory/memory-code-change.js";
import { MemoryCommandReplies } from "../adapters/memory/memory-command-reply.js";
import { MemoryCommentIngress } from "../adapters/memory/memory-comment-ingress.js";
import {
  MemoryDeliveryStateStore,
  MemoryStateProvenance,
} from "../adapters/memory/memory-delivery-state-store.js";
import {
  MemoryIssueNotices,
  MemoryIssueText,
} from "../adapters/memory/memory-issue-adapter.js";
import {
  MemoryDeliveryRecordStore,
  MemoryStateAnchorStore,
} from "../adapters/memory/memory-signed-stores.js";
import type {
  MemoryAccount,
  MemoryTracker,
} from "../adapters/memory/memory-tracker.js";
import {
  Ed25519RecordSigner,
  generateRecordKeys,
} from "../adapters/signature/record-signature.js";
import type { Ed25519RecordVerifier } from "../adapters/signature/record-signature.js";

/** AIR's three service accounts and its approvers on the memory tracker. */
export type MemoryRoster = Readonly<{
  operator: MemoryAccount;
  agent: MemoryAccount;
  deployer: MemoryAccount;
  approvers: readonly MemoryAccount[];
}>;

/** Each service account's signing key, held only by its own process. */
export type MemoryKeys = Readonly<{
  operator: Ed25519RecordSigner;
  agent: Ed25519RecordSigner;
  deployer: Ed25519RecordSigner;
}>;

export type MemoryConfig = Readonly<{
  roster: MemoryRoster;
  keys: MemoryKeys;
  now: () => Date;
  runTtlMs: number;
  leaseMs: number;
  newRunId?: () => string;
}>;

/** One AIR process: what it can do and the audit log it writes. */
type Process<T> = T & Readonly<{ audit: MemoryAuditLines }>;

export type MemoryServices = Readonly<{
  /** The operator's process: turns `/air` comments into transitions. */
  operator: Process<{ ingress: MemoryCommentIngress }>;
  /** The agent's process: what `air start | report | gate | block | context` run. */
  agent: Process<{
    commands: AgentCommands;
    gate: EvaluatePhaseGate;
    context: ReadAgentContext;
  }>;
  /** The deployer's process: what `air-deploy` runs. */
  deployer: Process<{ deployment: RecordDeployment }>;
}>;

/** A fresh key for each service account, for tests and demos. */
export function generateMemoryKeys(): MemoryKeys {
  const key = () =>
    Ed25519RecordSigner.fromBase64(generateRecordKeys().privateKey);
  return { operator: key(), agent: key(), deployer: key() };
}

/**
 * The only place concrete adapters are selected for the memory tracker. The
 * same application use cases as the GitHub composition, wired per process
 * with that process's own account, key and audit log: no process can sign
 * for another, so the zero-trust checks run exactly as they do on GitHub.
 */
export class MemoryComposition {
  private readonly trust: TrustPolicy;
  private readonly verifiers: ReadonlyMap<number, Ed25519RecordVerifier>;

  constructor(
    private readonly tracker: MemoryTracker,
    private readonly config: MemoryConfig,
  ) {
    const { operator, agent, deployer, approvers } = config.roster;
    this.trust = new TrustPolicy({
      sourceId: tracker.project.id,
      approverIds: approvers.map(({ id }) => id),
      operatorId: operator.id,
      agentId: agent.id,
      deployerId: deployer.id,
      operatorMayApprove: false,
      stateAnchors: StateAnchorMode.Require,
    });
    this.verifiers = new Map([
      [operator.id, config.keys.operator.verifier],
      [agent.id, config.keys.agent.verifier],
      [deployer.id, config.keys.deployer.verifier],
    ]);
  }

  compose(): MemoryServices {
    return {
      operator: this.operator(),
      agent: this.agent(),
      deployer: this.deployer(),
    };
  }

  private operator(): MemoryServices["operator"] {
    const { roster, keys } = this.config;
    const audit = new MemoryAuditLines();
    const log = this.log(audit);
    const records = this.records(roster.operator, log);
    const handler = new CommentCommandHandler(
      new RecordedDeliveryEvidence(
        records,
        new MemoryCodeChangeAdapter(this.tracker),
        this.config.now,
        this.config.runTtlMs,
      ),
      this.executor(roster.operator, keys.operator, log),
      new MemoryCommandReplies(this.tracker, roster.operator.id),
      new MemoryCommandReplies(this.tracker, roster.operator.id),
      this.trust,
    );
    const ingestion = new IngestHumanCommand(
      new InMemoryDeliveryClaims(this.config.leaseMs),
      new MemoryAuthorAccess(this.tracker),
      this.trust,
      handler,
      log,
    );
    return {
      audit,
      ingress: new MemoryCommentIngress(this.tracker, ingestion),
    };
  }

  private agent(): MemoryServices["agent"] {
    const { roster, keys, now, runTtlMs } = this.config;
    const audit = new MemoryAuditLines();
    const log = this.log(audit);
    const executor = this.executor(roster.agent, keys.agent, log);
    const records = this.records(roster.agent, log, keys.agent);
    const preflight = new MemoryAccountPreflight(
      this.tracker,
      roster.agent.id,
      roster.agent.id,
    );
    return {
      audit,
      commands: new AgentCommands(executor, records, preflight, {
        now,
        newRunId: this.config.newRunId ?? (() => randomUUID().slice(0, 8)),
        runTtlMs,
      }),
      gate: new EvaluatePhaseGate(
        new MemoryDeliveryStateStore(this.tracker, roster.agent.id),
        executor,
        records,
        new MemoryCodeChangeAdapter(this.tracker),
        preflight,
        { now, runTtlMs },
      ),
      context: new ReadAgentContext(
        new MemoryIssueText(this.tracker),
        new MemoryAuthorAccess(this.tracker),
        this.trust,
        this.tracker.project,
        log,
      ),
    };
  }

  private deployer(): MemoryServices["deployer"] {
    const { roster, keys, now, runTtlMs } = this.config;
    const audit = new MemoryAuditLines();
    const log = this.log(audit);
    const notices = new MemoryIssueNotices(this.tracker, roster.deployer.id);
    const changes = new MemoryCodeChangeAdapter(this.tracker);
    return {
      audit,
      deployment: new RecordDeployment(
        this.executor(roster.deployer, keys.deployer, log),
        this.records(roster.deployer, log),
        changes,
        notices,
        notices,
        new MemoryAccountPreflight(
          this.tracker,
          roster.deployer.id,
          roster.deployer.id,
        ),
        { now, runTtlMs },
      ),
    };
  }

  private log(lines: MemoryAuditLines): AuditPort {
    return new HashChainedAuditLog(lines, this.config.now);
  }

  /** Records are always checked with the agent's key; only it may sign. */
  private records(
    account: MemoryAccount,
    audit: AuditPort,
    signer?: Ed25519RecordSigner,
  ): TrustedDeliveryRecords {
    return new TrustedDeliveryRecords(
      new MemoryDeliveryRecordStore(this.tracker, account.id, {
        verifier: this.config.keys.agent.verifier,
        ...(signer ? { signer } : {}),
      }),
      this.trust,
      audit,
    );
  }

  private executor(
    account: MemoryAccount,
    signer: Ed25519RecordSigner,
    audit: AuditPort,
  ): ExecuteDeliveryCommand {
    return new ExecuteDeliveryCommand(
      new MemoryDeliveryStateStore(this.tracker, account.id),
      new MemoryStateProvenance(this.tracker),
      new MemoryStateAnchorStore(
        this.tracker,
        account.id,
        { verifiers: this.verifiers, signer },
        this.config.now,
      ),
      this.trust,
      audit,
    );
  }
}
