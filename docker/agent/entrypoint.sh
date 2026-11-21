#!/usr/bin/env bash
# air-agent <issue>: one AIR agent run in this container (ADR-0011).
# Clones AIR_REPOSITORY as the agent account, then runs Claude Code in tmux.
# Attach with: docker exec -it <container> tmux attach -t agent
set -euo pipefail

fail() {
  echo "air-agent: $*" >&2
  exit 1
}

issue="${1:-}"
[[ "$issue" =~ ^[1-9][0-9]*$ ]] || fail "usage: air-agent <issue-number>"

for name in AIR_REPOSITORY AIR_AGENT_LOGIN AIR_AGENT_TOKEN AIR_AGENT_SIGNING_KEY; do
  [[ -n "${!name:-}" ]] || fail "set $name"
done
[[ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] ||
  fail "set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)"
[[ "$AIR_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "AIR_REPOSITORY must be <owner>/<repo>"

# gh and git act as the agent account only.
export GH_TOKEN="$AIR_AGENT_TOKEN"
unset GITHUB_TOKEN
login="$(gh api user --jq .login)"
id="$(gh api user --jq .id)"
[[ "${login,,}" == "${AIR_AGENT_LOGIN,,}" ]] ||
  fail "AIR_AGENT_TOKEN belongs to $login, not to AIR_AGENT_LOGIN ($AIR_AGENT_LOGIN)"
# git pushes with the agent token; nothing is written to disk.
git config --global credential.https://github.com.helper \
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
git config --global user.name "$login"
git config --global user.email "${id}+${login}@users.noreply.github.com"

repo_dir=/work/repo
branch="air/issue-$issue"
git clone --filter=blob:none "https://github.com/$AIR_REPOSITORY.git" "$repo_dir"
cd "$repo_dir"
default_ref="$(git symbolic-ref --short refs/remotes/origin/HEAD)"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
  git fetch origin "$branch"
  # Anyone with write access can push this branch: refuse one that changes
  # the session's configuration before Claude Code reads it.
  air-check-branch "$default_ref" "origin/$branch"
  git switch --track -c "$branch" "origin/$branch"
else
  git switch -c "$branch"
fi

# The project pins AIR in its lockfile; never run install scripts here.
[[ -f package-lock.json ]] || fail "$AIR_REPOSITORY has no package-lock.json (install AIR first)"
npm ci --ignore-scripts --no-audit --no-fund

# One audit-log writer per file: one file per run.
export AIR_AUDIT_LOG="${AIR_AUDIT_LOG:-/var/lib/air-audit/agent-issue-$issue-$(date -u +%Y%m%dT%H%M%SZ).jsonl}"

# Claude Code first run: skip onboarding, trust this checkout and accept the
# API key from the environment, so the session opens straight on the task.
# Trusting it is safe only because managed settings ignore project hooks,
# MCP servers and permission rules, and air-check-branch refused changes to
# instruction files that did not come from the default branch.
claude_state="$HOME/.claude.json"
api_key="${ANTHROPIC_API_KEY:-}"
(( ${#api_key} > 20 )) && api_key="${api_key: -20}"
if [[ ! -f "$claude_state" ]]; then
  jq -n --arg dir "$repo_dir" --arg key "$api_key" '{
    hasCompletedOnboarding: true,
    projects: { ($dir): { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: (if $key == "" then [] else [$key] end), rejected: [] }
  }' >"$claude_state"
  chmod 600 "$claude_state"
fi

# The managed Stop hook (air-stop-hook) asks the gate about this issue.
export AIR_ISSUE="$issue"
prompt="${AIR_AGENT_PROMPT:-Take issue #$issue under AIR delivery control, following the air-delivery skill.}"
tmux new-session -d -s agent -c "$repo_dir" claude "$prompt"
echo "air-agent: issue #$issue on $branch; attach with: docker exec -it $(hostname) tmux attach -t agent"

while tmux has-session -t agent 2>/dev/null; do
  sleep 5
done
echo "air-agent: session ended"
