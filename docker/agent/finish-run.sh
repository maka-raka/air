#!/usr/bin/env bash
# air-finish-run <issue>: after a headless agent session (AIR_AGENT_MODE=
# headless), leaves no phase working with nobody on it. It asks the gate
# what it would say now (`air gate <issue> --check`):
#   would pass   -> runs `air gate`, as the agent should have;
#   would reject -> runs `air block` with the gate's problems, so an
#                   approver sees why the run stopped;
#   nothing to gate (blocked, waiting, closed) -> nothing to do.
# It acts as the agent, with the agent's token and key, and decides
# nothing the gate doesn't.
set -uo pipefail

issue="${1:-}"
[[ "$issue" =~ ^[1-9][0-9]*$ ]] || {
  echo "usage: air-finish-run <issue-number>" >&2
  exit 1
}

out="$(npx --no air gate "$issue" --check 2>&1)"
code=$?
echo "$out"
case "$code" in
0)
  [[ "$out" == "would pass:"* ]] || exit 0
  npx --no air gate "$issue"
  ;;
2)
  question="${TMPDIR:-/tmp}/air-finish-run-$issue.md"
  {
    echo "The agent session ended before the gate passed. The gate says:"
    echo
    printf '%s\n' "$out"
    echo
    echo "Unblock to start a new run, or answer what the agent needs."
  } >"$question"
  npx --no air block "$issue" --question-file "$question"
  ;;
*)
  echo "air-finish-run: could not check the gate; #$issue may still be working" >&2
  exit 1
  ;;
esac
