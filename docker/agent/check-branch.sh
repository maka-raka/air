#!/usr/bin/env bash
# air-check-branch <base-ref> <branch-ref>: refuses an existing agent branch
# that changes what configures the session before the model's first step.
# Anyone with write access can push to air/issue-<n>, so its content is not
# trusted just because it is there. Its changes since it left the default
# branch must not touch Claude Code configuration, instruction files or
# workflows, and it must not change the AIR package the lockfile pins.
# Everything else is ordinary work in progress the agent reviews.
set -euo pipefail

base="${1:?usage: air-check-branch <base-ref> <branch-ref>}"
branch="${2:?usage: air-check-branch <base-ref> <branch-ref>}"

fail() {
  echo "air-check-branch: $*" >&2
  exit 1
}

fork="$(git merge-base "$base" "$branch")" ||
  fail "$branch shares no history with $base"

# Read by Claude Code or GitHub as configuration or instructions.
protected=(
  ':(glob).claude/**'
  ':(glob)**/.claude/**'
  ':(glob)**/CLAUDE.md'
  ':(glob)**/CLAUDE.local.md'
  ':(glob)**/AGENTS.md'
  ':(glob).mcp.json'
  ':(glob).github/**'
)
changed="$(git diff --name-only "$fork" "$branch" -- "${protected[@]}")"
[[ -z "$changed" ]] ||
  fail "$branch changes files that configure the agent; review and remove these changes or delete the branch:
$changed"

# The AIR package npm ci installs, as the lockfile pins it.
air_pin() {
  git show "$1:package-lock.json" 2>/dev/null |
    jq -c '.packages["node_modules/@air/delivery-core"] // null | if . then {version, resolved, integrity} else null end' ||
    echo invalid
}
[[ "$(air_pin "$branch")" == "$(air_pin "$fork")" ]] ||
  fail "$branch changes the AIR package pinned in package-lock.json"
