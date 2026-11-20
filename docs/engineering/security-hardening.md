# Repository Hardening for AIR

AIR verifies who set delivery state and who wrote the evidence ([ADR-0007](../architecture/adr/0007-threat-model-and-trust-boundaries.md)). It cannot stop someone with write access from pushing code or editing workflows. Apply **every** item below to each repository before AIR runs on it.

Demo mode (`air init --demo`, [ADR-0014](../architecture/adr/0014-demo-mode.md)) skips these items for one throwaway repository. It is never a substitute: `air doctor` fails while `AIR_DEMO` is set.

Lite mode (`AIR_MODE=lite`, [ADR-0016](../architecture/adr/0016-lite-mode.md)) is for repositories whose plan offers no branch rules, such as a private repository on GitHub Free. `air doctor` then skips the default-branch rules in §3 and warns that the branch isn't protected. Every other item still applies.

## Check it automatically

```bash
AIR_DOCTOR_TOKEN=$(gh auth token) npx --no air doctor            # exit 1 on any FAIL
AIR_DOCTOR_TOKEN=$(gh auth token) npx --no air doctor --strict   # also fail on unknown settings
```

`air doctor` reads the settings below through the GitHub API (read-only) and prints `ok`, `FAIL` or `??` for each:
- repository visibility;
- default-branch rules and classic protection, and who can bypass them;
- CODEOWNERS coverage of `.github/`;
- the workflow token defaults;
- deploy environments;
- every AIR account's access;
- the local `.env.air`.

Some settings are visible only to repository admins. Run it with an admin's token (your own `gh auth token`), not with an AIR service token. Settings it cannot read are reported as `??`, never as `ok`. The doctor does not check the agent environment (§4) or token scopes; review those by hand.

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
| `AIR_GITHUB_TOKEN` (operator) | Issues: read and write · Pull requests: read · Commit statuses: read (**read and write** in lite mode, for `air-check`) · Checks: read · Metadata: read |
| `AIR_AGENT_TOKEN` | Issues: read and write · Pull requests: read and write · Contents: read and write · Commit statuses: read · Checks: read · Metadata: read · **no Workflows, no Administration** |
| `AIR_DEPLOY_TOKEN` | Issues: read and write · Pull requests: read · Contents: read · Deployments: read · Metadata: read |

If a token cannot read check runs, `advance review` fails closed with `precondition-failed`; confirm this on the first live run.

## 3. Branch and workflow protection

- [ ] Protect the default branch with a ruleset: pull request required, at least one approving review, review from **Code Owners** required, stale approvals dismissed, status checks required, force pushes and deletion blocked, **no bypass** for the agent, operator or deployer.
- [ ] `CODEOWNERS` assigns a human approver to `.github/**`, `CODEOWNERS` itself, any deploy scripts, and the files that configure or instruct Claude Code: `.claude/**`, `CLAUDE.md`, `AGENTS.md`, `.mcp.json`.
- [ ] Add a second ruleset for the agent's branches `air/**`: force pushes and deletion blocked. Where your plan allows it, restrict updates so that only the agent account can push (for example through a team that holds only it). A writer who pushes to `air/issue-<n>` otherwise decides what the next agent run starts from; the Docker agent refuses a branch that changes Claude Code configuration, instruction files, workflows or the AIR package ([Running AIR in Docker](docker.md#3-agent-runs)), but ordinary code on the branch still runs when the agent runs tests.
- [ ] In *Settings → Actions*: workflow permissions **read-only** by default; "Allow GitHub Actions to create and approve pull requests" **off**.
- [ ] Every workflow sets an explicit minimal `permissions:` block. Third-party actions are pinned to a full commit SHA.
- [ ] Deployment secrets (`AIR_DEPLOY_TOKEN` and your cloud credentials) live in **environments** (`staging`, `production`) with required reviewers and a deployment branch rule that allows only the default branch.

## 4. Agent environment

- [ ] Use **private** repositories. In a public repository anyone can comment, and the agent reads comments: that is a prompt-injection channel to an account with write access.
- [ ] The agent reads issues only through `npx air context <n>`, which marks approver instructions and fences everything else as data ([ADR-0010](../architecture/adr/0010-zero-trust.md)). Back it with a Claude Code deny rule, e.g. `Bash(gh issue view:*)` and `Bash(gh api:*comments*)`, so the agent cannot read unclassified issue text. The installed skill says so; projects that ran `air init` before this change must copy the new `SKILL.md`.
- [ ] Run the agent with Claude Code permission rules that deny destructive commands and pushes to the default branch; prefer a container or VM with only the repository checked out ([Running AIR in Docker](docker.md), [ADR-0011](../architecture/adr/0011-agent-execution.md)).
- [ ] Treat Claude Code deny rules as a guard against mistakes, **not as a security boundary**. They match the start of a command, so another spelling (`bash -c …`, `git push origin HEAD:main`, `curl` with the token, printing an environment variable) is not denied, and every command the agent runs, including tests and project code, sees its token and signing key. What actually limits a compromised agent is the agent token's permissions, branch rulesets and the container.
- [ ] Keep `.env` out of git (it is ignored) and readable only by you (`chmod 600 .env`).

## 5. Signing keys

Each account that writes state has its own Ed25519 key pair ([ADR-0010](../architecture/adr/0010-zero-trust.md)): the agent signs records and state anchors, the operator and the deployer sign the state anchors they write.

| Key pair | `npx air keygen …` | Private key goes only to | Public key goes to |
| --- | --- | --- | --- |
| Agent | `agent` (default) | where the agent runs (`AIR_AGENT_SIGNING_KEY`) | every process (`AIR_AGENT_PUBLIC_KEY`) |
| Operator | `operator` | the poller (`AIR_OPERATOR_SIGNING_KEY`) | every process (`AIR_OPERATOR_PUBLIC_KEY`) |
| Deployer | `deployer` | the deploy environments, as a secret (`AIR_DEPLOY_SIGNING_KEY`) | every process (`AIR_DEPLOY_PUBLIC_KEY`) |

- [ ] Never put the agent or operator private key in CI, in the repository or in a shared password vault entry that others can read. The deployer key lives only in the deploy environments' secrets.
- [ ] If a private key may have leaked, generate a new pair and update the public key everywhere. Records and state anchors signed with the old key stop counting: open deliveries become `untrusted-state` and must be repaired by an administrator (or re-anchored in bootstrap mode, below).
- [ ] **Upgrading from an AIR without state anchors:** open deliveries have no anchor yet. Set `AIR_STATE_ANCHORS=bootstrap` in every process until each open delivery has been moved by an approver's command once (that writes the operator's anchor, where the checked history starts), then remove it. In bootstrap mode an issue without any anchor is judged by its label history alone, as before.

## 6. Audit log

Every AIR process records its trust decisions in a hash-chained audit log ([ADR-0010](../architecture/adr/0010-zero-trust.md)): the poller in `.air/audit-poller.jsonl`, the agent CLI in `.air/audit-agent.jsonl` (override with `AIR_AUDIT_LOG`), and the deploy reporter as `air-audit:` lines in the job log.

- [ ] Keep one writer per log file: never point two processes at the same `AIR_AUDIT_LOG`.
- [ ] Copy the log files off the machine regularly (backup, log shipping). The chain detects edited, deleted or reordered entries, but not the newest entries being cut off.
- [ ] Check a log with `npx --no air audit verify .air/audit-poller.jsonl`.
- [ ] If the log cannot be written, AIR refuses to act: fix the disk or permissions, not the check.

## 7. Running AIR

- [ ] Set `AIR_OPERATOR_LOGIN`, `AIR_AGENT_LOGIN`, `AIR_APPROVER_LOGINS` and, if you deploy, `AIR_DEPLOY_LOGIN` in **every** AIR process (poller, agent CLI, deploy workflow, console). They must match, or legitimate state is rejected as `untrusted-state`.
- [ ] Do not set `AIR_ALLOW_OPERATOR_APPROVER` outside a throwaway test repository.
- [ ] Install AIR only from a release tarball, verify it with `gh attestation verify` and commit the lockfile ([Adopting AIR](install.md)). Run it as `npx --no air …` / `npm exec --no -- air-deploy …`, so npm never downloads an unrelated package of the same name.

## 8. Agent launcher and console

Both are optional ([ADR-0011](../architecture/adr/0011-agent-execution.md), [ADR-0012](../architecture/adr/0012-read-only-console.md)).

**`air-launcher`** starts agent containers. The Docker API it needs is root-equivalent on the host.

- [ ] Never mount `/var/run/docker.sock` into the poller, the agent or the console. Only the launcher talks to Docker.
- [ ] Run the launcher with no AIR token or signing key in its environment; it refuses to start otherwise. The agent's secrets reach the container only through `.env.air.agent`, which `docker compose` reads.
- [ ] Prefer rootless Docker or Podman (`AIR_DOCKER=podman`) for the launcher's host.
- [ ] Bound it: `AIR_AGENT_LAUNCH_PHASES` lists only the phases you want launched, `AIR_AGENT_MAX` stays small.
- [ ] Restrict the agent container's network to GitHub, npm and the model API if you can; AIR does not enforce it yet.

**`air-ui`** shows delivery state and never writes.

- [ ] Give it a fine-grained token of a **person or a reader account** with Issues: Read and Metadata: Read only. It refuses a token of the operator, agent or deployer account, and any AIR signing key or service token in its environment.
- [ ] Keep it on `127.0.0.1` (the default; `compose.yaml` publishes `127.0.0.1:7420` only). If you put it behind a proxy, add that host name to `AIR_UI_ALLOWED_HOSTS` and protect the proxy; the console has no login.
- [ ] Mount the audit log and the launch directory read-only, as `compose.yaml` does.

## When AIR says `untrusted-state`

Someone other than AIR's accounts added the current state label. Find who in the issue timeline, decide what the state should be, and restore it with a trusted account, or close the delivery and start again with `/air initialize`. Do not set `AIR_ALLOW_OPERATOR_APPROVER` to work around it.
