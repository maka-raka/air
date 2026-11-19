# AIR agent runtime: one container per issue run (ADR-0011).
# It clones AIR_REPOSITORY itself and runs Claude Code in tmux as the agent
# account. See docs/engineering/docker.md.
#
#   docker build -t air-agent docker/agent
#   docker compose run -d --name air-agent-42 agent 42

# Base image pinned by digest (ADR-0010); Dependabot bumps it. Keep the
# Node major in step with .nvmrc.
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

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
RUN chmod 0444 /etc/claude-code/managed-settings.json \
 && chmod 0555 /usr/local/bin/air-agent /usr/local/bin/air-check-branch \
 && mkdir -p /work /var/lib/air-audit \
 && chown node:node /work /var/lib/air-audit

USER node
WORKDIR /work
VOLUME ["/var/lib/air-audit"]
ENTRYPOINT ["/usr/local/bin/air-agent"]
