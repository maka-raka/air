# Adopting AIR in a Project

This guide connects a repository to AIR with the local poller. Read [Repository Hardening](security-hardening.md) first: its settings are required.

Requires **Node.js 24 or later** (`engines` in `package.json`). npm only warns on an older Node; AIR is not tested there.

## Try it (demo mode, throwaway repository only)

To see AIR work before setting it up properly, use demo mode on a new, empty, preferably private repository you can throw away. It skips the repository hardening, makes you both operator and approver, and puts every key and token in one local file. It is **not production-safe** ([ADR-0014](../architecture/adr/0014-demo-mode.md)).

You need your own GitHub account and a second account for the agent with write access to the repository. In a clone of that repository, with AIR installed (step 1 below):

```bash
npx --no air init --demo <owner>/<repo>
```

This adds the agent skill and four review lenses, and writes a private `.env.air` with both key pairs already generated. Fill in:

- `AIR_OPERATOR_LOGIN` and `AIR_APPROVER_LOGINS`: your login; `AIR_GITHUB_TOKEN`: your fine-grained token for this repository only;
- `AIR_AGENT_LOGIN` and `AIR_AGENT_TOKEN`: the agent account and its token for this repository only.

The permissions each token needs are in the file. Then run `npx --no air-local`, open an issue, comment `/air initialize`, and ask Claude Code to deliver the issue.

Every AIR process prints a demo warning, and `air doctor` fails while `AIR_DEMO` is set. Demo mode is bound to the repository named in `AIR_DEMO` and refuses any other. The agent can read `.env.air`, which holds your token, so add a Claude Code deny rule `Read(./.env.air)` and use short-lived tokens. For a real repository, delete the demo `.env.air` and follow the steps below; never reuse the demo keys.

## 1. Install a pinned release

```bash
VERSION=v0.4.0
FILE=air-delivery-core-${VERSION#v}.tgz
gh release download "$VERSION" --repo maka-raka/air --pattern "$FILE"
gh attestation verify "$FILE" --repo maka-raka/air   # built by AIR's release workflow
npm install --save-dev "https://github.com/maka-raka/air/releases/download/$VERSION/$FILE"
rm "$FILE"
```

Commit `package.json` and `package-lock.json`; the lockfile pins the tarball's hash. Always run AIR as `npx --no air …` or `npm exec --no -- air-deploy …`, so npm never downloads a different package.

## 2. Add the project files

```bash
npx --no air init
```

This adds the agent skill, the standard review lenses (`.claude/agents/air-review-*.md`), the rules for choosing them (`.claude/skills/air-delivery/lenses.md`), the deploy workflow, the delivery policy `.github/air-policy.json` and `.env.air.example`, and ignores `.env.air` and `.air/`. The policy lists the paths a delivery's pull request may not change; the gate reads it from the default branch ([ADR-0017](../architecture/adr/0017-protected-paths.md)). Existing files are kept. Add optional lenses with `--lens privacy,cost` or `--lens all` ([ADR-0013](../architecture/adr/0013-agent-roles.md)). Commit these files; edit `lenses.md` and the lens files to fit the project.

## 3. Accounts, keys and settings

1. Create the operator, agent and deployer accounts and their tokens ([Repository Hardening §1–2](security-hardening.md#1-accounts)).
2. `npx --no air keygen agent`, `… operator` and, if you report deployments, `… deployer`. Each private key goes **only** to the process that signs with it ([Repository Hardening §5](security-hardening.md#5-signing-keys)).
3. Apply branch, workflow and environment protection ([Repository Hardening §3](security-hardening.md#3-branch-and-workflow-protection)).
4. In *Settings → Secrets and variables → Actions*:
   - **variables:** `AIR_OPERATOR_LOGIN`, `AIR_AGENT_LOGIN`, `AIR_DEPLOY_LOGIN`, `AIR_AGENT_PUBLIC_KEY`, `AIR_OPERATOR_PUBLIC_KEY`, `AIR_DEPLOY_PUBLIC_KEY`, and optionally `AIR_ENVIRONMENT_STAGE` / `AIR_ENVIRONMENT_PROD` / `AIR_STATE_ANCHORS`;
   - **environment secrets** in each deploy environment: `AIR_DEPLOY_TOKEN` and `AIR_DEPLOY_SIGNING_KEY`.

5. Verify with `AIR_DOCTOR_TOKEN=$(gh auth token) npx --no air doctor --strict` after step 4. Fix every `FAIL` and `??` before running AIR.

## 4. Local configuration

```bash
cp .env.air.example .env.air
chmod 600 .env.air        # AIR refuses a file other users can read
```

Fill in the repository, accounts, approvers, the public keys, the operator token and signing key and, for the agent, `AIR_AGENT_TOKEN` and `AIR_AGENT_SIGNING_KEY`.

## 5. Run

| Who | Command |
| --- | --- |
| Poller (keep it running) | `npx --no air-local` |
| Agent (Claude Code, uses the skill) | `npx --no air start <n>`, `report`, `gate`, `block` |
| Deploy (CI) | call `.github/workflows/air-deploy.yml` after each deploy job (example at the top of the file) |

To run the poller and each agent in their own container instead, see [Running AIR in Docker](docker.md).

Approvers then work in the issue: `/air initialize`, `/air advance <phase>`, `/air close`. When the gate says a pull request changes protected files, an approver who reviewed it comments `/air allow-protected <commit>` ([ADR-0017](../architecture/adr/0017-protected-paths.md)).

## Pull request convention

The agent writes `AIR-Issue: #<n>` on its own line in the PR description and never `Closes #<n>`. The deploy workflow uses that line to find the issue; a closing keyword would close the issue on merge and stop the delivery.

## Upgrading

Repeat step 1 with the new version and review the lockfile diff, then update the project files:

```bash
npx --no air templates --check   # what would change; exit code 2 if anything is behind
npx --no air templates           # update untouched files, add new standard ones
```

Files you changed are reported as `modified` and kept; compare them with the template under `node_modules/@air/delivery-core/templates/<provider>/` (`claude/`, `github/`), or replace them with `--force`. Files written by an AIR version before template markers count as changed. Your own lenses (any other `.claude/agents/` file) are never touched.

Read [CHANGELOG.md](../../CHANGELOG.md) before upgrading: it lists changes that need action in your project.
