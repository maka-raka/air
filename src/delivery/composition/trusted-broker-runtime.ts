import {
  GitHubAppPrivilegedWriter,
  type GitHubAppTokenIssuer,
} from "../adapters/github/github-app-privileged-writer.js";
import { GitHubGraphqlAtomicRefUpdater } from "../adapters/github/github-graphql-atomic-ref-updater.js";
import { GitHubRestClient } from "../adapters/github/github-rest-client.js";
import {
  GitHubTrustedPushEvidenceProvider,
  type TrustedPushApprovalPort,
} from "../adapters/github/github-trusted-push-evidence-provider.js";
import { TrustedPushBroker } from "../adapters/github/trusted-push-broker.js";
import { TrustedPushSocketServer } from "./trusted-push-socket-server.js";

export type TrustedBrokerRuntimeOptions = Readonly<{
  owner: string;
  repo: string;
  repositoryId: number;
  socketPath: string;
  readToken: string;
  approvals: TrustedPushApprovalPort;
  issuer: GitHubAppTokenIssuer;
}>;

/**
 * Trusted-only composition root. Neither approval decisions nor GitHub App
 * credentials may originate from the agent. The operator must supply both
 * ports from independently authenticated, privileged infrastructure.
 */
export class TrustedBrokerRuntime {
  readonly listener: TrustedPushSocketServer;

  constructor(options: TrustedBrokerRuntimeOptions) {
    if (
      !Number.isSafeInteger(options.repositoryId) ||
      options.repositoryId <= 0
    ) {
      throw new Error("Invalid repository ID");
    }
    if (
      !options.socketPath.startsWith("/") ||
      !options.socketPath.endsWith(".sock")
    ) {
      throw new Error("Broker socket must use an absolute .sock path");
    }
    const github = new GitHubRestClient({
      owner: options.owner,
      repo: options.repo,
      token: options.readToken,
    });
    const evidence = new GitHubTrustedPushEvidenceProvider(
      github,
      options.approvals,
    );
    const updater = new GitHubGraphqlAtomicRefUpdater({
      owner: options.owner,
      repo: options.repo,
    });
    const writer = new GitHubAppPrivilegedWriter(
      options.repositoryId,
      options.issuer,
      updater,
    );
    this.listener = new TrustedPushSocketServer(
      new TrustedPushBroker(evidence, writer),
      options.socketPath,
    );
  }
}
