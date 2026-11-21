/**
 * Setup readiness (`air doctor`, #98 follow-up): what a first run would
 * trip over that the hardening audit doesn't look at. Tokens that belong
 * to the wrong account, a signing key that doesn't match its public key, an
 * invalid policy file, a required lens that isn't installed, launched runs
 * that would wait on a prompt. Reads only.
 */

import { AuditFindings, AuditStatus } from "./repository-audit.js";
import type { AccountRole, AuditFinding, Known } from "./repository-audit.js";
import type { DeliveryPolicyPort } from "./code-change-check.js";

/** What one service account is configured with, in this environment. */
export type ServiceCredentials = Readonly<{
  role: AccountRole;
  login: string;
  /** Name of the variable that holds the token, for messages. */
  tokenName: string;
  token?: string;
  signingKey?: string;
  publicKey?: string;
}>;

export const AgentMode = {
  Interactive: "interactive",
  Headless: "headless",
} as const;
export type AgentMode = (typeof AgentMode)[keyof typeof AgentMode];

export type SetupFacts = Readonly<{
  credentials: readonly ServiceCredentials[];
  /** AIR_AGENT_MODE as set, or undefined. */
  agentMode?: string;
  /** Phases the poller requests agent runs for (AIR_AGENT_LAUNCH_PHASES). */
  launchPhases: readonly string[];
}>;

export interface TokenOwnerPort {
  /** The login the token belongs to, or why it can't be told. */
  owner(token: string): Promise<Known<string>>;
}

export interface KeyPairPort {
  /** Whether the signing key belongs to the public key, or why not known. */
  matches(signingKey: string, publicKey: string): Known<boolean>;
}

export interface InstalledLensesPort {
  /** Lens names installed on the default branch (`air-review-<name>.md`). */
  installed(): Promise<Known<readonly string[]>>;
}

const AGENT_MODES: readonly string[] = Object.values(AgentMode);

export class CheckSetup {
  constructor(
    private readonly tokens: TokenOwnerPort,
    private readonly keys: KeyPairPort,
    private readonly policy: DeliveryPolicyPort,
    private readonly lenses: InstalledLensesPort,
  ) {}

  async run(facts: SetupFacts): Promise<readonly AuditFinding[]> {
    const tokens = await Promise.all(
      facts.credentials.map((credential) => this.token(credential)),
    );
    return [
      ...tokens.flat(),
      ...facts.credentials.flatMap((credential) => this.key(credential)),
      ...(await this.policyAndLenses()),
      ...this.agentMode(facts),
    ];
  }

  private async token(
    credential: ServiceCredentials,
  ): Promise<readonly AuditFinding[]> {
    const { role, login, token, tokenName } = credential;
    const id = `setup.token.${role}`;
    if (!token) return [];
    const owner = await this.tokens.owner(token);
    if (!owner.known)
      return [{ id, status: AuditStatus.Unknown, message: owner.reason }];
    return [
      AuditFindings.check(
        id,
        owner.value.toLowerCase() === login.toLowerCase(),
        `${tokenName} belongs to ${role} ${login}`,
        `${tokenName} belongs to ${owner.value}, not to ${role} ${login}`,
      ),
    ];
  }

  private key(credential: ServiceCredentials): readonly AuditFinding[] {
    const { role, signingKey, publicKey } = credential;
    if (!signingKey || !publicKey) return [];
    const id = `setup.key.${role}`;
    const match = this.keys.matches(signingKey, publicKey);
    if (!match.known)
      return [AuditFindings.fail(id, `The ${role}'s keys: ${match.reason}`)];
    return [
      AuditFindings.check(
        id,
        match.value,
        `The ${role}'s signing key matches its public key`,
        `The ${role}'s signing key does not match its public key: records it signs would be ignored`,
      ),
    ];
  }

  private async policyAndLenses(): Promise<readonly AuditFinding[]> {
    const policy = await this.policy.load();
    if (!policy)
      return [
        AuditFindings.fail(
          "setup.policy",
          "The AIR policy file on the default branch is invalid: every gate stays closed",
        ),
      ];
    const required = policy.lenses.names();
    const installed = await this.lenses.installed();
    if (!installed.known)
      return [
        AuditFindings.pass("setup.policy", "The AIR policy is valid"),
        {
          id: "setup.lenses",
          status: AuditStatus.Unknown,
          message: installed.reason,
        },
      ];
    const missing = required.filter((lens) => !installed.value.includes(lens));
    return [
      AuditFindings.pass("setup.policy", "The AIR policy is valid"),
      AuditFindings.check(
        "setup.lenses",
        missing.length === 0,
        `Every lens the policy can require is installed (${required.length})`,
        `The policy requires lenses that are not installed: ${missing.join(", ")}; reviews needing them can't pass`,
      ),
    ];
  }

  private agentMode({
    agentMode,
    launchPhases,
  }: SetupFacts): readonly AuditFinding[] {
    if (agentMode !== undefined && !AGENT_MODES.includes(agentMode))
      return [
        AuditFindings.fail(
          "setup.agent-mode",
          `AIR_AGENT_MODE must be ${AGENT_MODES.join(" or ")}, not ${agentMode}`,
        ),
      ];
    if (launchPhases.length === 0 || agentMode === AgentMode.Headless)
      return [];
    return [
      AuditFindings.warn(
        "setup.agent-mode",
        `The poller launches agent runs (${launchPhases.join(", ")}) but AIR_AGENT_MODE is not headless here: launched runs wait at their first prompt. Set it in .env.air.agent`,
      ),
    ];
  }
}
