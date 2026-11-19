# AIR agent runtime: one container per issue run (ADR-0011).
# It clones AIR_REPOSITORY itself and runs Claude Code in tmux as the agent
# account. See docs/engineering/docker.md.
#
#   docker build -t air-agent docker/agent
#   docker compose run -d --name air-agent-42 agent 42

ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE}

# Pin a Claude Code version for reproducible runs, e.g. --build-arg CLAUDE_CODE_VERSION=2.1.0
ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh tmux jq \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --ignore-scripts "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force

# Managed settings apply to every session and cannot be changed by the agent.
COPY managed-settings.json /etc/claude-code/managed-settings.json
COPY entrypoint.sh /usr/local/bin/air-agent
RUN chmod 0444 /etc/claude-code/managed-settings.json \
 && chmod 0555 /usr/local/bin/air-agent \
 && mkdir -p /work /var/lib/air-audit \
 && chown node:node /work /var/lib/air-audit

USER node
WORKDIR /work
VOLUME ["/var/lib/air-audit"]
ENTRYPOINT ["/usr/local/bin/air-agent"]
