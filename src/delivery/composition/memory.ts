import { randomUUID } from "node:crypto";
import {
  AgentLaunchPolicy,
  LaunchAgentOnReady,
  RecordedRisk,
} from "../application/agent-launch.js";
import type { AgentLaunchRequestPort } from "../application/agent-launch.js";
import type { DeliveryCommandExecutor } from "../application/comment-command-handler.js";
import { ReadDeliveryDetail } from "../application/delivery-detail.js";
import { ReadDeliveryOverview } from "../application/delivery-overview.js";
import type { Phase } from "../domain/state-machine.js";
import { FileAgentLaunchQueue } from "../adapters/local/file-agent-launch-queue.js";
import {
  FileAgentRunsSnapshot,
  agentRunsFile,
} from "../adapters/local/file-agent-runs-snapshot.js";
import {
  MemoryAuditTrail,
  MemoryOpenDeliveries,
} from "../adapters/memory/memory-console.js";
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
import { MemoryDeliveryPolicy } from "../adapters/memory/memory-delivery-policy.js";
import { CodeChangeCheck } from "../application/code-change-check.js";
import { ReadRequiredLenses } from "../application/read-required-lenses.js";
import { AllowProtectedChange } from "../application/allow-protected-change.js";
import { TrustedProtectedChangeApprovals } from "../application/protected-change-approval.js";
import { deliveryPolicyCodec } from "./delivery-policy.js";
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
  MemoryProtectedChangeApprovalStore,
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

/** Agent runs the operator requests after trusted ready transitions. */
export type MemoryLaunchConfig = Readonly<{
  phases: readonly Phase[];
  queue: AgentLaunchRequestPort;
}>;

export type MemoryConfig = Readonly<{
  roster: MemoryRoster;
  keys: MemoryKeys;
  now: () => Date;
  runTtlMs: number;
  leaseMs: number;
  newRunId?: () => string;
  /** ADR-0011 step 3; absent: no agent run is ever requested. */
  launch?: MemoryLaunchConfig;
  /** The project's policy file, as text; absent: the defaults (ADR-0017). */
  policy?: string;
}>;

/** The read-only console's use cases over the memory tracker (ADR-0012). */
export type MemoryConsole = Readonly<{
  overview: ReadDeliveryOverview;
  detail: ReadDeliveryDetail;
}>;

/** One AIR process: what it can do and the audit log it writes. */
type Process<T> = T & Readonly<{ audit: MemoryAuditLines }>;

export type MemoryServices = Readonly<{
  /** The operator's process: turns `/air` comments into transitions. */
  operator: Process<{ ingress: MemoryCommentIngress }>;
  /** The agent's process: what `air start | report | gate | lenses | block | context` run. */
  agent: Process<{
    commands: AgentCommands;
    gate: EvaluatePhaseGate;
    lenses: ReadRequiredLenses;
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
      this.launching(
        this.executor(roster.operator, keys.operator, log),
        records,
        log,
      ),
      new MemoryCommandReplies(this.tracker, roster.operator.id),
      new MemoryCommandReplies(this.tracker, roster.operator.id),
      this.trust,
    );
    const replies = new MemoryCommandReplies(this.tracker, roster.operator.id);
    const commands = new AllowProtectedChange(handler, {
      state: new MemoryDeliveryStateStore(this.tracker, roster.operator.id),
      records,
      changes: new MemoryCodeChangeAdapter(this.tracker),
      approvals: this.approvals(log, keys.operator),
      replies,
      processed: replies,
      trust: this.trust,
      audit: log,
      now: this.config.now,
    });
    const ingestion = new IngestHumanCommand(
      new InMemoryDeliveryClaims(this.config.leaseMs),
      new MemoryAuthorAccess(this.tracker),
      this.trust,
      commands,
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
        this.codeChanges(log),
        preflight,
        { now, runTtlMs },
      ),
      lenses: new ReadRequiredLenses(records, this.codeChanges(log)),
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

  /**
   * The console as `air-ui` composes it on GitHub, over this tracker: it
   * reads the operator's audit log and the launcher's directory, and holds
   * no key.
   */
  console(operatorAudit: MemoryAuditLines, launchDir: string): MemoryConsole {
    const { roster, now } = this.config;
    const reader = roster.operator.id;
    const deliveries = new MemoryOpenDeliveries(this.tracker);
    const provenance = new MemoryStateProvenance(this.tracker);
    const states = new MemoryStateAnchorStore(
      this.tracker,
      reader,
      { verifiers: this.verifiers },
      now,
    );
    const queue = new FileAgentLaunchQueue(launchDir);
    const runs = new FileAgentRunsSnapshot(agentRunsFile(launchDir));
    const trail = new MemoryAuditTrail(operatorAudit);
    return {
      overview: new ReadDeliveryOverview(
        deliveries,
        provenance,
        states,
        this.trust,
        runs,
        queue,
        queue,
        trail,
        trail,
        now,
      ),
      detail: new ReadDeliveryDetail(
        deliveries,
        provenance,
        states,
        new MemoryDeliveryRecordStore(this.tracker, reader, {
          verifier: this.config.keys.agent.verifier,
        }),
        this.trust,
        runs,
        queue,
        now,
      ),
    };
  }

  private codeChanges(log: AuditPort): CodeChangeCheck {
    const codec = deliveryPolicyCodec();
    const policy = this.config.policy;
    return new CodeChangeCheck(
      new MemoryCodeChangeAdapter(this.tracker),
      new MemoryDeliveryPolicy(
        policy === undefined ? codec.fallback() : codec.decode(policy),
      ),
      this.approvals(log),
    );
  }

  /** Approvals signed by the operator; only the operator gets its signer. */
  private approvals(
    log: AuditPort,
    signer?: Ed25519RecordSigner,
  ): TrustedProtectedChangeApprovals {
    const { roster, keys } = this.config;
    return new TrustedProtectedChangeApprovals(
      new MemoryProtectedChangeApprovalStore(this.tracker, roster.operator.id, {
        verifier: keys.operator.verifier,
        ...(signer ? { signer } : {}),
      }),
      this.trust,
      log,
    );
  }

  /** Requests agent runs when the launch config says so (ADR-0011). */
  private launching(
    executor: DeliveryCommandExecutor,
    records: TrustedDeliveryRecords,
    audit: AuditPort,
  ): DeliveryCommandExecutor {
    const launch = this.config.launch;
    if (!launch) return executor;
    return new LaunchAgentOnReady(
      executor,
      launch.queue,
      new AgentLaunchPolicy(new Set(launch.phases)),
      audit,
      this.config.now,
      new RecordedRisk(records),
    );
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
