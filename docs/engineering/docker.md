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

## 4. Automatic agent runs

The poller can request an agent run when an approver's command makes a phase ready, and a separate `air-launcher` process starts it ([ADR-0011](../architecture/adr/0011-agent-execution.md) §3–4).

1. Choose the phases in `.env.air.poller` and restart the poller:

   ```bash
   AIR_AGENT_LAUNCH_PHASES=requirements,design,build,review
   ```

2. Create the queue directory the poller writes to, owned by your user:

   ```bash
   mkdir -p .air/launch
   ```

3. Run the launcher on the host, next to `compose.yaml`, with no AIR tokens or keys in its environment (it refuses to start otherwise):

   ```bash
   npm ci && npm run build
   AIR_AGENT_MAX=2 node dist/src/delivery/composition/launcher.js
   ```

What happens:

- `/air initialize` or `/air advance build` is applied → the poller writes `.air/launch/<issue>-<phase>.json` and audits `agent-launch`.
- The launcher sees it within `AIR_LAUNCH_INTERVAL_MS` (5 s) and runs `docker compose run --detach --name air-agent-<issue>-<phase>-<time> agent <issue>`, with labels `air.agent.issue` and `air.agent.phase`.
- At most `AIR_AGENT_MAX` agent containers run at once (default 2), and one per issue: a request for an issue whose container is still running waits until it stops.
- A container that cannot start leaves `<issue>-<phase>.json.failed` with the error; nothing is retried automatically.

Only trusted transitions count: a ready label set by hand, a replayed command, or a deployment event never launches anything. Phases made ready by the deploy workflow (`accept`, `observe`) are not launched by the poller. The launched agent still has to pass `air start`, which checks the state again.

Attach to a run as before: `docker exec -it air-agent-42-build-<time> tmux attach -t agent`; list them with `docker ps --filter label=air.agent.issue`. Stopped containers stay for their logs: `docker container prune --filter label=air.agent.issue`.

The launcher needs the Docker API, which is root-equivalent on the host: prefer rootless Docker or Podman (`AIR_DOCKER=podman`). It reads `.env.air.agent` only through `docker compose`, and never holds the operator's key.

## 5. Console

A read-only page on `http://localhost:7420/` ([ADR-0012](../architecture/adr/0012-read-only-console.md)):

- **Board**: every open issue with AIR state, by phase, with a warning on any state AIR did not write or cannot verify.
- **Needs you**: what waits for an approver, most urgent first (repairs, then agent questions, then approvals), each with the exact `/air` command to post and a link to the issue.
- **Issue** (`/issues/<n>`): the state and why it is or is not trusted, phase progress, the newest signed report of each phase, a timeline of signed state changes and agent records (entries that do not count are marked), this issue's agent runs, and the next command.
- **Agents & audit**: agent containers with their attach command, the launch queue, failed launches, and the poller's audit log with its hash chain checked.

```bash
cp docker/env/ui.env.example .env.air.ui && chmod 600 .env.air.ui   # add a read-only token
docker compose --profile ui up -d ui
```

The console holds one read-only token (Issues: Read, Metadata: Read) of a person or a reader account. It refuses a token of `air-bot`, `air-agent` or the deployer, and refuses to start with any AIR signing key or service token in its environment. It never posts: copy the command and post it in the issue as yourself, so the approval is yours.

It listens on `127.0.0.1` only, answers only `GET`/`HEAD`, rejects requests for other host names, and serves no scripts. It reads the audit log and the launch directory through read-only mounts; agent runs come from a snapshot `air-launcher` writes after each round, so the console has no Docker access. Trust is checked again on every refresh (`AIR_UI_REFRESH_MS`, 30 s): two GitHub API calls per open AIR issue.

Without Docker: `npm run build && node dist/src/delivery/composition/console.js --env-file .env.air.ui` with the repository, logins, `AIR_OPERATOR_PUBLIC_KEY`, `AIR_AGENT_PUBLIC_KEY` and `AIR_UI_TOKEN` in that file only.

## 6. Without Docker

The host workflow in [Local runtime](local-runtime.md) still works and suits development, but the agent then sees your machine's credentials.

## Limits (see ADR-0011)

- Network egress is not restricted. Restrict it in your Docker network or firewall to `github.com`, `api.github.com`, `registry.npmjs.org` and `api.anthropic.com` if you can.
- Never mount `/var/run/docker.sock` into either container.
