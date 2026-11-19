# Running AIR in Docker

AIR's poller and each agent run can live in their own container ([ADR-0011](../architecture/adr/0011-agent-execution.md)). This keeps the operator's and the agent's secrets in separate processes and gives every agent run a fresh checkout of one repository, with no access to your machine's logins.

Do [Adopting AIR](install.md) steps 1–3 and [Repository Hardening](security-hardening.md) first. The target project must have AIR in its `package-lock.json`: the agent container runs the AIR version the project pins.

## 1. Environment files

Create three files next to `compose.yaml` from the templates in `docker/env/`. They are git-ignored.

```bash
cp docker/env/air.env.example    .env.air
cp docker/env/poller.env.example .env.air.poller
cp docker/env/agent.env.example  .env.air.agent
chmod 600 .env.air .env.air.poller .env.air.agent
```

Requires Docker Compose 2.24 or later (`env_file` with `path:`).

| File | Contents | Used by |
| --- | --- | --- |
| `.env.air` | `AIR_REPOSITORY`, `AIR_OPERATOR_LOGIN`, `AIR_AGENT_LOGIN`, `AIR_DEPLOY_LOGIN`, `AIR_APPROVER_LOGINS`, `AIR_*_PUBLIC_KEY`, optional `AIR_STATE_ANCHORS`, `AIR_RUN_TTL_MS` | poller and agent |
| `.env.air.poller` | `AIR_GITHUB_TOKEN`, `AIR_OPERATOR_SIGNING_KEY`, optional `AIR_POLL_INTERVAL_MS`, `AIR_LEASE_MS` | poller only |
| `.env.air.agent` | `AIR_AGENT_TOKEN`, `AIR_AGENT_SIGNING_KEY`, `ANTHROPIC_API_KEY` | agent only |

Never put a signing key in `.env.air`: both containers read it.

## 2. Poller

```bash
docker compose up -d poller
docker compose logs -f poller
```

The cursor and `audit-poller.jsonl` live in the `air-poller-state` volume, so a restart does not replay or skip comments. Run one poller per repository. Its root filesystem is read-only, it runs as `node` with every capability dropped.

Verify the audit log:

```bash
docker compose run --rm --entrypoint node poller \
  dist/src/delivery/composition/agent-cli.js audit verify /var/lib/air/audit-poller.jsonl
```

## 3. Agent runs

One container per issue run:

```bash
docker compose run -d --name air-agent-42 agent 42
docker exec -it air-agent-42 tmux attach -t agent    # detach: Ctrl-b d
```

The entrypoint:

1. refuses to start unless `AIR_AGENT_TOKEN` belongs to `AIR_AGENT_LOGIN`;
2. clones `AIR_REPOSITORY` as the agent account and switches to `air/issue-42` (continuing it if it was pushed before);
3. runs `npm ci --ignore-scripts`, so no dependency script runs next to the agent's secrets;
4. starts Claude Code in tmux with the prompt `Take issue #42 …` (override with `AIR_AGENT_PROMPT`), with onboarding skipped, the checkout trusted and the API key from the environment accepted.

Git pushes use `AIR_AGENT_TOKEN` through a credential helper that reads it from the environment; the token is never written to disk.

The container stops when the Claude Code session ends. Remove it with `docker rm air-agent-42`; anything not pushed is lost, which is intended. Each run writes its own audit log to the `air-agent-audit` volume (`agent-issue-<n>-<time>.jsonl`).

`docker/agent/managed-settings.json` adds Claude Code deny rules the agent cannot change: no unclassified issue text, merges, reviews, releases, workflow runs, label edits, force pushes or edits under `.github/`. They back up branch protection; they do not replace it.

Pin Claude Code for reproducible runs:

```bash
CLAUDE_CODE_VERSION=2.1.0 docker compose build agent
```

## 4. Without Docker

The host workflow in [Local runtime](local-runtime.md) still works and suits development, but the agent then sees your machine's credentials.

## Limits (see ADR-0011)

- Agents are started by hand; automatic launch after `/air advance` is roadmap step 3.
- Network egress is not restricted. Restrict it in your Docker network or firewall to `github.com`, `api.github.com`, `registry.npmjs.org` and `api.anthropic.com` if you can.
- Never mount `/var/run/docker.sock` into either container.
