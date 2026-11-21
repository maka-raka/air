#!/usr/bin/env bash
# air-stop-hook: Claude Code Stop hook in the AIR agent container (#98).
# Before the session ends, it asks what the gate would say now
# (`air gate <issue> --check`). If the phase is working and the gate would
# refuse it, it exits 2 with the problems on stderr, and Claude Code goes
# on with them as feedback. It is a hint, not a decision: the gate still
# decides when the agent runs `air gate`. It never traps the session: it
# sends the agent back at most AIR_STOP_HOOK_MAX times per run (default 3),
# and lets it stop on any error or when there is nothing to gate.
set -uo pipefail

issue="${AIR_ISSUE:-}"
[[ "$issue" =~ ^[1-9][0-9]*$ ]] || exit 0
max="${AIR_STOP_HOOK_MAX:-3}"
[[ "$max" =~ ^[0-9]+$ ]] || max=3

count_file="${TMPDIR:-/tmp}/air-stop-hook-$issue"
count="$(cat "$count_file" 2>/dev/null || echo 0)"
[[ "$count" =~ ^[0-9]+$ ]] || count=0
((count < max)) || exit 0

# Claude Code passes the event on stdin; nothing in it is needed.
cat >/dev/null

out="$(npx --no air gate "$issue" --check 2>&1)"
code=$?
# 0: would pass or nothing to gate; 1: an error, which is not the agent's.
((code == 2)) || exit 0

echo $((count + 1)) >"$count_file"
{
  echo "AIR: the gate would refuse this phase. Fix what it lists, record a new report and run 'npx air gate $issue'. If you can't, run 'npx air block $issue' with your question."
  echo "$out"
} >&2
exit 2
