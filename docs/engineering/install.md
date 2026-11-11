# Adopting AIR in a Project

This guide connects a repository to AIR with the local poller. Read [Repository Hardening](security-hardening.md) first: its settings are required.

## 1. Install a pinned release

```bash
VERSION=v0.1.0
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

This adds the agent skill, the deploy workflow and `.env.air.example`, and ignores `.env.air` and `.air/`. Existing files are kept.

## 3. Accounts, keys and settings

1. Create the operator, agent and deployer accounts and their tokens ([Repository Hardening §1–2](security-hardening.md#1-accounts)).
2. `npx --no air keygen`. The signing key goes **only** to where the agent runs.
3. Apply branch, workflow and environment protection ([Repository Hardening §3](security-hardening.md#3-branch-and-workflow-protection)).
4. In *Settings → Secrets and variables → Actions*:
   - **variables:** `AIR_OPERATOR_LOGIN`, `AIR_AGENT_LOGIN`, `AIR_DEPLOY_LOGIN`, `AIR_AGENT_PUBLIC_KEY`, and optionally `AIR_ENVIRONMENT_STAGE` / `AIR_ENVIRONMENT_PROD`;
   - **environment secret** in each deploy environment: `AIR_DEPLOY_TOKEN`.

## 4. Local configuration

```bash
cp .env.air.example .env.air
chmod 600 .env.air        # AIR refuses a file other users can read
```

Fill in the repository, accounts, approvers, the public key, the operator token and, for the agent, `AIR_AGENT_TOKEN` and `AIR_AGENT_SIGNING_KEY`.

## 5. Run

| Who | Command |
| --- | --- |
| Poller (keep it running) | `npx --no air-local` |
| Agent (Claude Code, uses the skill) | `npx --no air start <n>`, `report`, `gate`, `block` |
| Deploy (CI) | call `.github/workflows/air-deploy.yml` after each deploy job (example at the top of the file) |

Approvers then work in the issue: `/air initialize`, `/air advance <phase>`, `/air close`.

## Pull request convention

The agent writes `AIR-Issue: #<n>` on its own line in the PR description and never `Closes #<n>`. The deploy workflow uses that line to find the issue; a closing keyword would close the issue on merge and stop the delivery.

## Upgrading

Repeat step 1 with the new version and review the lockfile diff. Re-run `npx --no air init` after removing a template file you want refreshed; it never overwrites.
