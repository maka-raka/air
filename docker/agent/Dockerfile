# AIR agent runtime: one container per issue run (ADR-0011).
# It clones AIR_REPOSITORY itself and runs Claude Code in tmux as the agent
# account. See docs/engineering/docker.md.
#
#   docker build -t air-agent docker/agent
#   docker compose run -d --name air-agent-42 agent 42

# Base image pinned by digest (ADR-0010); Dependabot bumps it. Keep the
# Node major in step with .nvmrc.
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

# Pinned for reproducible runs; keep in step with compose.yaml.
ARG CLAUDE_CODE_VERSION=2.1.318

# Claude Code fetches its native binary in its install script: allowed here,
# at build time and without secrets. Project dependencies never run scripts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh tmux jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Managed settings apply to every session and cannot be changed by the agent.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY entrypoint.sh /usr/local/bin/air-agent
COPY check-branch.sh /usr/local/bin/air-check-branch
COPY stop-hook.sh /usr/local/bin/air-stop-hook
COPY finish-run.sh /usr/local/bin/air-finish-run
RUN chmod 0444 /etc/claude-code/managed-settings.json \
 && chmod 0555 /usr/local/bin/air-agent /usr/local/bin/air-check-branch \
      /usr/local/bin/air-stop-hook /usr/local/bin/air-finish-run \
 && mkdir -p /work /var/lib/air-audit \
 && chown node:node /work /var/lib/air-audit

USER node
WORKDIR /work
VOLUME ["/var/lib/air-audit"]
ENTRYPOINT ["/usr/local/bin/air-agent"]
