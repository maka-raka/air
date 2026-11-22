#!/usr/bin/env bash
# air-agent <issue>: one AIR agent run in this container (ADR-0011).
# air-agent --finish <issue>: no Claude Code; closes a run whose container
# died before air-finish-run could (the launcher starts this, §7).
# Clones AIR_REPOSITORY as the agent account, then runs Claude Code: in tmux
# (AIR_AGENT_MODE=interactive, the default; attach with
# docker exec -it <container> tmux attach -t agent), or headless.
set -euo pipefail

fail() {
  echo "air-agent: $*" >&2
  exit 1
}

finish=false
if [[ "${1:-}" == --finish ]]; then
  finish=true
  shift
fi
issue="${1:-}"
[[ "$issue" =~ ^[1-9][0-9]*$ ]] || fail "usage: air-agent [--finish] <issue-number>"

# Fail closed if broker/operator credentials are accidentally injected into the
# untrusted agent container. AIR_AGENT_TOKEN remains a legacy write-capable
# credential until broker transport replaces direct agent pushes.
for name in \
  AIR_GITHUB_TOKEN \
  AIR_OPERATOR_SIGNING_KEY \
  AIR_DEPLOY_TOKEN \
  AIR_DEPLOY_SIGNING_KEY \
  AIR_GITHUB_APP_PRIVATE_KEY \
  AIR_GITHUB_APP_PRIVATE_KEY_PEM \
  AIR_GITHUB_APP_INSTALLATION_TOKEN \
  GITHUB_APP_PRIVATE_KEY \
  GH_APP_PRIVATE_KEY; do
  [[ -z "${!name:-}" ]] || fail "privileged credential $name must not enter the agent container"
done

for name in AIR_REPOSITORY AIR_AGENT_LOGIN AIR_AGENT_TOKEN AIR_AGENT_SIGNING_KEY; do
  [[ -n "${!name:-}" ]] || fail "set $name"
done
$finish || [[ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ]] ||
  fail "set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)"
[[ "$AIR_REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "AIR_REPOSITORY must be <owner>/<repo>"
# interactive: Claude Code in tmux, for a person to attach to.
# headless: `claude -p`, no prompts; air-finish-run closes the run after it.
mode="${AIR_AGENT_MODE:-interactive}"
[[ "$mode" == interactive || "$mode" == headless ]] ||
  fail "AIR_AGENT_MODE must be interactive or headless"
max_turns="${AIR_AGENT_MAX_TURNS:-200}"
[[ "$max_turns" =~ ^[1-9][0-9]*$ ]] || fail "AIR_AGENT_MAX_TURNS must be a positive number"
# Headless only: the session ends after this long, and the run is closed.
max_runtime="${AIR_AGENT_MAX_RUNTIME:-2h}"
[[ "$max_runtime" =~ ^[1-9][0-9]*[smhd]?$ ]] ||
  fail "AIR_AGENT_MAX_RUNTIME must be a duration such as 90m or 2h"

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
if $finish; then
  # The default branch's AIR, never the run's branch: nothing the dead run
  # pushed is installed or read here.
  [[ -f package-lock.json ]] || fail "$AIR_REPOSITORY has no package-lock.json (install AIR first)"
  npm ci --ignore-scripts --no-audit --no-fund
  export AIR_AUDIT_LOG="${AIR_AUDIT_LOG:-/var/lib/air-audit/agent-issue-$issue-finish-$(date -u +%Y%m%dT%H%M%SZ).jsonl}"
  echo "air-agent: closing the run of #$issue"
  exec air-finish-run "$issue"
fi
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

if [[ "$mode" == headless ]]; then
  # Nobody answers a permission prompt here: Claude Code refuses what the
  # managed allow rules don't cover, and the agent asks people through AIR.
  prompt+=" No person is watching this session: when you need a decision, run npx air block $issue with your question instead of waiting."
  transcript="/var/lib/air-audit/claude-issue-$issue-$(date -u +%Y%m%dT%H%M%SZ).jsonl"
  echo "air-agent: issue #$issue on $branch, headless; transcript: $transcript"
  set +e
  timeout --kill-after=30s "$max_runtime" \
    claude -p "$prompt" --permission-mode acceptEdits --max-turns "$max_turns" \
    --output-format stream-json --verbose | tee "$transcript"
  status="${PIPESTATUS[0]}"
  set -e
  ((status == 124)) && echo "air-agent: session stopped after $max_runtime (AIR_AGENT_MAX_RUNTIME)"
  echo "air-agent: session ended ($status)"
  air-finish-run "$issue"
  exit 0
fi

tmux new-session -d -s agent -c "$repo_dir" claude "$prompt"
echo "air-agent: issue #$issue on $branch; attach with: docker exec -it $(hostname) tmux attach -t agent"

while tmux has-session -t agent 2>/dev/null; do
  sleep 5
done
echo "air-agent: session ended"
