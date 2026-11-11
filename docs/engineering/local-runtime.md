# AIR Local Runtime

Run AIR on your own machine against a **test repository**. GitHub cannot reach `localhost`, so the local runtime **polls** repository comments instead of receiving webhooks. It feeds them to the same `IngestGitHubWebhook` use case a hosted webhook endpoint will use. Only the adapters differ.

```text
every AIR_POLL_INTERVAL_MS:
  GET /repos/<owner>/<repo>/issues/comments?since=<cursor>
    → GitHubCommentPoller (ID order, cursor saved after each comment)
    → IngestGitHubWebhook: /air issue comment? → write access? → claim
    → CommentCommandHandler → ExecuteDeliveryCommand (labels)
    → reply comment on the issue
```

## Setup

1. Create a private **test** repository and apply [Repository Hardening](security-hardening.md).
2. Create the accounts: an **operator** (the poller runs as it), an **agent** and, if you deploy, a **deployer**. Each is a separate GitHub account with write access. Approvers are your own accounts ([ADR-0007](../architecture/adr/0007-threat-model-and-trust-boundaries.md)).
3. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the **operator**, limited to that repository. The permissions are listed in [Repository Hardening §2](security-hardening.md#2-tokens-fine-grained-one-repository-each-shortest-expiry-you-can-manage).
4. Create the record-signing keys once with `npm run build && npx air keygen`. The signing key goes only to the agent; the public key goes into every AIR process.
5. Configure and start:

   ```bash
   cp .env.example .env   # set the repository, accounts, approvers and token
   chmod 600 .env
   npm ci
   npm run local:run
   ```

   AIR refuses to start when the token is not the operator's, when two service accounts are the same, or when the operator is also an approver (set `AIR_ALLOW_OPERATOR_APPROVER=true` only in a throwaway repository).

6. As an approver, comment in an issue of the test repository:

   ```text
   /air initialize
   Adopting this issue.
   ```

   Within one poll interval the issue gets `air:requirements:ready` and a reply.

The first start records "now" as the cursor: existing comments are never replayed as commands. The cursor lives in `.air/cursor.json`; delete it to start from "now" again.

## Agent CLI

The agent (a Claude Code session) uses its **own** GitHub account ([ADR-0004](../architecture/adr/0004-agent-identity-and-issue-records.md)). Set `AIR_AGENT_TOKEN` in `.env` next to the account variables, then:

```bash
npm run build
set -a; source .env; set +a      # or export the variables another way

npx air start 42                 # T01 ready → working, records the run
npx air report 42 requirements --summary-file report.md \
  --facts '{"taskSize":"S","miniDesign":true}'
npx air gate 42                  # T02 working → waiting if the phase report passes
npx air block 42 --question "Which API version should we target?"   # T03
```

Exit codes: `0` applied or recorded, `2` rejected by policy (the reason is printed), `1` usage or configuration error. The CLI refuses to run when the token does not belong to `AIR_AGENT_LOGIN`, and refuses to start from a state label that AIR's accounts did not set (`untrusted-state`).

## Deployment events

After a deployment, a workflow reports it with the **deployer** account ([ADR-0006](../architecture/adr/0006-deployment-events.md)). It needs `AIR_DEPLOY_TOKEN` and the same account variables as every other AIR process:

```yaml
# .github/workflows/deploy.yml (excerpt, after your deploy step)
- run: npm exec --no -- air-deploy stage "$ISSUE" "$GITHUB_SHA"
  env:
    AIR_REPOSITORY: ${{ github.repository }}
    AIR_DEPLOY_TOKEN: ${{ secrets.AIR_DEPLOY_TOKEN }} # environment secret
    AIR_OPERATOR_LOGIN: air-bot
    AIR_DEPLOY_LOGIN: air-deployer
    AIR_AGENT_LOGIN: air-agent
    AIR_AGENT_PUBLIC_KEY: ${{ vars.AIR_AGENT_PUBLIC_KEY }}
    AIR_ENVIRONMENT_STAGE: staging   # your GitHub environment name
```

`review:waiting` advances to `accept:ready` and `accept:waiting` advances to `observe:ready`. Any other state is preserved and gets a `deployment-state-mismatch` comment. The `air:deployed:<env>` label is always added.

## What works locally

| Command | Locally |
| --- | --- |
| `initialize` | ✅ |
| `npx air start` / `report` / `gate` / `block` (agent) | ✅ (gate rules: [ADR-0005](../architecture/adr/0005-phase-gate.md)) |
| `unblock`, `rework` (with a reason) | ✅ |
| `advance <phase>` | ✅ requirements facts come from the agent's `report`; `advance review` also needs the PR from the build report to be open or merged with all checks green |
| `recover` | ✅ once no run is active (ended, or older than `AIR_RUN_TTL_MS`) |
| `close` | ✅ when the latest observe report has `"verdict":"go"` |
| a command from a writer not in `AIR_APPROVER_LOGINS` | ❌ ignored (`unauthorized`), no reply |
| a command edited before AIR read it | ❌ ignored; post a new comment |
| any command after someone set the state label by hand | ❌ `untrusted-state`, the reply names who added the label |

## Limitations

- **Replies are posted as the operator account.** They can never trigger a command, because a reply's first line is never `/air`. Because the operator is not you, GitHub notifies you about them.
- **Claims are in memory.** Run one process only. After a restart, protection against duplicates comes from the persisted cursor alone.
- **Latency** is up to one poll interval (default 20 s, minimum 5 s). A 20 s interval uses about 180 API requests per hour, plus a few per command.
- Comments are ingested in ID order. A comment that becomes visible in the API after a later comment was already processed is skipped. This is rare and is accepted for local use.
