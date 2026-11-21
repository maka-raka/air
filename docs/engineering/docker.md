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
2. clones `AIR_REPOSITORY` as the agent account and switches to `air/issue-42`. If that branch was pushed before, it continues it only when the branch's own changes leave `.claude/`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.mcp.json`, `.github/` and the AIR entry in `package-lock.json` as they were on the default branch; otherwise it stops and names the files. Anyone with write access can push that branch, and those files configure the session before the model reads anything. Review such a branch and remove the changes, or delete it;
3. runs `npm ci --ignore-scripts`, so no dependency script runs next to the agent's secrets;
4. starts Claude Code with the prompt `Take issue #42 …` (override with `AIR_AGENT_PROMPT`), with onboarding skipped, the checkout trusted and the API key from the environment accepted. With `AIR_AGENT_MODE=interactive` (the default) it runs in tmux; with `headless` it runs as described below.

### Headless runs

Set `AIR_AGENT_MODE=headless` in `.env.air.agent` for runs nobody watches, such as the ones the launcher starts (§4). In an interactive run, the first command Claude Code wants to confirm waits for a person who isn't there. A headless run differs in four ways:

- Claude Code runs as `claude -p … --permission-mode acceptEdits --max-turns $AIR_AGENT_MAX_TURNS` (default 200) and never prompts. A session still going after `AIR_AGENT_MAX_RUNTIME` (default `2h`) is stopped. It runs what the managed `permissions.allow` rules cover and refuses the rest: reading and editing files, `npx air`, `npm test` / `npm run` / `npm ci`, `node`, everyday `git` commands, `gh pr create|view|checks|diff|list`, `gh run view|list` and common shell tools. The deny rules still win, so a push to the default branch, a force push or an edit under `.github/` or `.claude/` stays refused.
- The prompt tells the agent nobody is watching, so it asks with `npx air block` instead of waiting.
- The session's transcript (`--output-format stream-json`) goes to the container log and to `claude-issue-<n>-<time>.jsonl` in the `air-agent-audit` volume.
- When the session ends for any reason (done, out of turns, crashed), `air-finish-run` closes the run. It asks `air gate <n> --check`:
  - **would pass**: it runs `air gate`;
  - **would reject**: it runs `air block`, with the gate's problems as the question, so an approver sees why the run stopped and can `/air unblock` for a new one;
  - **nothing to gate**: there is nothing to do.

  It acts as the agent and decides nothing the gate doesn't. No issue is left in a working phase with nobody on it.

Git pushes use `AIR_AGENT_TOKEN` through a credential helper that reads it from the environment; the token is never written to disk.

The container stops when the Claude Code session ends. Remove it with `docker rm air-agent-42`; anything not pushed is lost, which is intended. Each run writes its own audit log to the `air-agent-audit` volume (`agent-issue-<n>-<time>.jsonl`).

`docker/agent/managed-settings.json` makes Claude Code ignore the checkout's hooks, MCP servers and permission rules (`allowManagedHooksOnly`, `allowManagedMcpServersOnly` with an empty `allowedMcpServers`, `allowManagedPermissionRulesOnly`) and disables bypass-permissions mode. That is why the entrypoint can mark the checkout as trusted. It also adds deny rules the agent cannot change: no unclassified issue text, merges, reviews, releases, workflow runs, label edits, force pushes or edits under `.github/`. They catch mistakes; they are not a security boundary, because another spelling of a command is not denied ([Repository Hardening §4](security-hardening.md#4-agent-environment)). They back up branch protection; they do not replace it.

The managed settings also add AIR's own **Stop hook**, `air-stop-hook`. When Claude Code is about to end the session, it runs `air gate <issue> --check`. If the phase is working and the gate would refuse it, the hook returns the problems and Claude Code carries on with them. If the gate would pass, if there is nothing to gate (the agent blocked, or already moved the phase to waiting), or if the check fails, the session ends as usual. It sends the agent back at most `AIR_STOP_HOOK_MAX` times per run (default 3), so it can't keep a stuck session alive. It is a hint: the gate still decides.

Each container has a process limit, and the poller and agent have memory and CPU limits; raise the agent's in `compose.yaml` if a project's build needs more.

Claude Code is pinned in `docker/agent/Dockerfile` and `compose.yaml`. To build another version:

```bash
CLAUDE_CODE_VERSION=2.1.318 docker compose build agent
```

## 4. Automatic agent runs

The poller can request an agent run when an approver's command makes a phase ready, and a separate `air-launcher` process starts it ([ADR-0011](../architecture/adr/0011-agent-execution.md) §3–4).

Launched runs have nobody attached, so set `AIR_AGENT_MODE=headless` in `.env.air.agent` (§3). Otherwise each run waits at its first permission prompt until someone attaches.

**Watchdog.** A headless run closes itself, but a container killed from outside never gets that far, for example one stopped for using too much memory, or one the host stopped. Each round, the launcher looks for agent containers that exited with an error and starts one finisher for each: `air-agent --finish <issue>`, labelled `air.agent.finishes=<run>`. The finisher clones the default branch, installs AIR from its lockfile and runs `air-finish-run`, without Claude Code. It closes the run with `air gate` or `air block` like any headless run. The launcher still holds no AIR key, because the finisher uses the agent's credentials from `.env.air.agent`. A finisher is never finished itself, and a run gets at most one while its container is kept. The launcher logs `#<n> <run> died: finishing (exit 137)`.

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

Choose a model per phase, and a stronger one for high-risk issues ([ADR-0013](../architecture/adr/0013-agent-roles.md)), in the launcher's environment:

```bash
AIR_AGENT_MODELS=default=claude-sonnet-5-5,requirements=claude-fable-5-2,build=claude-opus-5-5,high-risk=claude-opus-5-5
```

`high-risk` wins whenever the newest trusted requirements report says `"risk":"high"`; then the phase; then `default`. The launcher passes the model to the container as `ANTHROPIC_MODEL`; unset means Claude Code's default. For a run started by hand: `docker compose run -d -e ANTHROPIC_MODEL=claude-opus-5-5 --name air-agent-42 agent 42`.

Only trusted transitions count: a ready label set by hand, a replayed command, or a deployment event never launches anything. Phases made ready by the deploy workflow (`accept`, `observe`) are not launched by the poller. The launched agent still has to pass `air start`, which checks the state again.

Attach to a run as before: `docker exec -it air-agent-42-build-<time> tmux attach -t agent`; list them with `docker ps --filter label=air.agent.issue`. Stopped containers stay for their logs: `docker container prune --filter label=air.agent.issue`.

The launcher needs the Docker API, which is root-equivalent on the host: prefer rootless Docker or Podman (`AIR_DOCKER=podman`). It reads `.env.air.agent` only through `docker compose`, and never holds the operator's key.

## 5. Console

A read-only page on `http://localhost:7420/` ([ADR-0012](../architecture/adr/0012-read-only-console.md)):

- **Board**: every open issue with AIR state, by phase, with a warning on any state AIR did not write or cannot verify, and *where the time goes*: waiting on people versus agent work, time per phase, lead time and throughput ([ADR-0015](../architecture/adr/0015-delivery-flow-metrics.md)).
- **Needs you**: what waits for an approver, most urgent first (repairs, then agent questions, then approvals), each with the exact `/air` command to post and a link to the issue.
- **Issue** (`/issues/<n>`): the state and why it is or is not trusted, phase progress, the newest signed report of each phase (with risk, recommendation and review lenses), a timeline of signed state changes and agent records (entries that do not count are marked), where its time went, this issue's agent runs, and the next command.
- **Agents & audit**: agent containers with their attach command, the launch queue, failed launches, and the poller's audit log with its hash chain checked.

```bash
cp docker/env/ui.env.example .env.air.ui && chmod 600 .env.air.ui   # add a read-only token
docker compose --profile ui up -d ui
```

The console holds one read-only token (Issues: Read, Metadata: Read) of a person or a reader account. It refuses a token of `air-bot`, `air-agent` or the deployer, and refuses to start with any AIR signing key or service token in its environment. It never posts: copy the command and post it in the issue as yourself, so the approval is yours.

It listens on `127.0.0.1` only, answers only `GET`/`HEAD`, rejects requests for other host names, and serves no scripts. It reads the audit log and the launch directory through read-only mounts; agent runs come from a snapshot `air-launcher` writes after each round, so the console has no Docker access and shows a stopped container as stopped after the launcher's next round (`AIR_LAUNCH_INTERVAL_MS`, 5 s). Trust is checked again on every refresh (`AIR_UI_REFRESH_MS`, 30 s): two GitHub API calls per open AIR issue, plus one per recently closed issue in the flow sample (at most 20).

Without Docker: `npm run build && node dist/src/delivery/composition/console.js --env-file .env.air.ui` with the repository, logins, `AIR_OPERATOR_PUBLIC_KEY`, `AIR_AGENT_PUBLIC_KEY` and `AIR_UI_TOKEN` in that file only.

## 6. Without Docker

The host workflow in [Local runtime](local-runtime.md) still works and suits development, but the agent then sees your machine's credentials. The Stop hook isn't installed there. `npx air gate <issue> --check` works anywhere, and a project can add it as a Stop hook of its own.

## Limits (see ADR-0011)

- The agent runs interactively in tmux: an automatically launched agent waits at Claude Code's first permission prompt until someone attaches. A headless mode with an allow-list is not built yet.
- Network egress is not restricted. Restrict it in your Docker network or firewall to `github.com`, `api.github.com`, `registry.npmjs.org` and `api.anthropic.com` if you can.
- Never mount `/var/run/docker.sock` into either container.
