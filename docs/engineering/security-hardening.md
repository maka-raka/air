# Repository Hardening for AIR

AIR verifies who set delivery state and who wrote the evidence ([ADR-0007](../architecture/adr/0007-threat-model-and-trust-boundaries.md)). It cannot stop someone with write access from pushing code or editing workflows. Apply **every** item below to each repository before AIR runs on it.

## 1. Accounts

| Role | Account | Repository role | Notes |
| --- | --- | --- | --- |
| Approver(s) | your personal account(s) | Write or Maintain | listed in `AIR_APPROVER_LOGINS` |
| Operator | dedicated, e.g. `air-bot` | Write | runs the poller; never a person's account |
| Agent | dedicated, e.g. `air-agent` | Write | used only by `npx air` |
| Deployer | dedicated, e.g. `air-deployer` | Write | used only by `air-deploy` in CI |

Give every account two-factor authentication. Grant **Triage** to nobody you do not trust: triage can change labels (AIR detects it and blocks the issue).

## 2. Tokens (fine-grained, one repository each, shortest expiry you can manage)

| Token | Repository permissions |
| --- | --- |
| `AIR_GITHUB_TOKEN` (operator) | Issues: read and write · Pull requests: read · Commit statuses: read · Checks: read · Metadata: read |
| `AIR_AGENT_TOKEN` | Issues: read and write · Pull requests: read and write · Contents: read and write · Commit statuses: read · Checks: read · Metadata: read · **no Workflows, no Administration** |
| `AIR_DEPLOY_TOKEN` | Issues: read and write · Pull requests: read · Contents: read · Deployments: read · Metadata: read |

If a token cannot read check runs, `advance review` fails closed with `precondition-failed`; confirm this on the first live run.

## 3. Branch and workflow protection

- [ ] Protect the default branch with a ruleset: pull request required, at least one approving review, review from **Code Owners** required, stale approvals dismissed, status checks required, force pushes and deletion blocked, **no bypass** for the agent, operator or deployer.
- [ ] `CODEOWNERS` assigns a human approver to `.github/**`, `CODEOWNERS` itself, and any deploy scripts.
- [ ] In *Settings → Actions*: workflow permissions **read-only** by default; "Allow GitHub Actions to create and approve pull requests" **off**.
- [ ] Every workflow sets an explicit minimal `permissions:` block. Third-party actions are pinned to a full commit SHA.
- [ ] Deployment secrets (`AIR_DEPLOY_TOKEN` and your cloud credentials) live in **environments** (`staging`, `production`) with required reviewers and a deployment branch rule that allows only the default branch.

## 4. Agent environment

- [ ] Use **private** repositories. In a public repository anyone can comment, and the agent reads comments: that is a prompt-injection channel to an account with write access.
- [ ] Tell the agent to treat issue and PR text from non-approvers as untrusted data, never as instructions.
- [ ] Run the agent with Claude Code permission rules that deny destructive commands and pushes to the default branch; prefer a container or VM with only the repository checked out.
- [ ] Keep `.env` out of git (it is ignored) and readable only by you (`chmod 600 .env`).

## 5. Record-signing key

- [ ] Run `npx air keygen` once. Put `AIR_AGENT_SIGNING_KEY` **only** where the agent runs. Put `AIR_AGENT_PUBLIC_KEY` in every AIR process: poller, agent and deploy workflow (it is not secret).
- [ ] Never store the signing key in CI, in the repository or in a shared password vault entry that others can read.
- [ ] If the signing key may have leaked, generate a new pair and update the public key everywhere. Records signed with the old key stop counting, so open deliveries must re-report.

## 6. Running AIR

- [ ] Set `AIR_OPERATOR_LOGIN`, `AIR_AGENT_LOGIN`, `AIR_APPROVER_LOGINS` and, if you deploy, `AIR_DEPLOY_LOGIN` in **every** AIR process (poller, agent CLI, deploy workflow). They must match, or legitimate state is rejected as `untrusted-state`.
- [ ] Do not set `AIR_ALLOW_OPERATOR_APPROVER` outside a throwaway test repository.
- [ ] In CI, install AIR from a pinned version with a lockfile and run it with `npm exec --no -- air-deploy …`, so npm never downloads an unrelated package of the same name.

## When AIR says `untrusted-state`

Someone other than AIR's accounts added the current state label. Find who in the issue timeline, decide what the state should be, and restore it with a trusted account, or close the delivery and start again with `/air initialize`. Do not set `AIR_ALLOW_OPERATOR_APPROVER` to work around it.
