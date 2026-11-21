# First Live Run

A checklist for the first end-to-end run of AIR on a real repository, with real tokens and a headless agent. Every part of the flow is covered by tests on an in-memory tracker, but not against GitHub and Claude Code together. This run is where setup mistakes, permission gaps and wrong assumptions show up.

Plan for two to three hours and a few dollars of model usage. Write down what you see at each step, especially where it differs from **Expect**. Section 9 lists what to send back.

## 0. What you need

- [ ] **A throwaway repository** with a small Node project:
  - a `package.json` with a `test` script;
  - a committed `package-lock.json`;
  - a CI workflow that runs `npm test` on pull requests.

  Private is better ([Repository Hardening §4](security-hardening.md#4-agent-environment)). Note which plan it is on:
  - **Branch rules available** (public, or a paid plan): use standard mode.
  - **No branch rules** (private on GitHub Free): use `AIR_MODE=lite` ([ADR-0016](../architecture/adr/0016-lite-mode.md)). Checks then come from `air-check`, which the operator runs (§6); the agent never runs it.
- [ ] **Accounts:** you (approver), an operator account and an agent account, each a collaborator with write access, with fine-grained tokens for this repository only ([Repository Hardening §1–2](security-hardening.md#1-accounts)).
- [ ] **An Anthropic API key** for the agent container.
- [ ] **Docker** with Compose 2.24 or later, and a clone of `maka-raka/air` at the release candidate's tag (step 1), for `compose.yaml`, the images and the launcher.

## 1. A release candidate

The new behaviour is not in v0.4.0. The agent container installs AIR from the project's lockfile with `npm ci --ignore-scripts`, so the project needs a published release tarball, not a local path or a git dependency.

- [ ] A maintainer tags `v0.5.0-rc.1` on `main`, and the release workflow publishes the attested tarball.
- [ ] In the test repository, do [Adopting AIR](install.md) step 1 with `VERSION=v0.5.0-rc.1`.
- [ ] Commit `package.json` and `package-lock.json`.

## 2. Project files

- [ ] `npx --no air init`, then commit everything it created.
- [ ] Open `.github/air-policy.json`. **Expect** `protected` with `.github/**` and `.claude/**`; `lenses` with `always`, `paths` and `risk`; and `"reviewRounds": 2`.
- [ ] `ls .claude/agents/`. **Expect** the eleven standard `air-review-*.md` lenses.

## 3. Keys and configuration (Docker layout)

In the AIR clone, build once. A package can't run its own bin with `npx`, so the AIR commands run here as `node dist/…`:

- [ ] `npm ci && npm run build`.
- [ ] Run `node dist/src/delivery/composition/agent-cli.js keygen agent`, then the same with `operator`.
- [ ] Do [Running AIR in Docker §1](docker.md#1-environment-files): create `.env.air`, `.env.air.poller` and `.env.air.agent`, each with `chmod 600`.
- [ ] In `.env.air`: set `AIR_REPOSITORY`, the logins, `AIR_APPROVER_LOGINS` (you) and both public keys. Set `AIR_MODE=lite` if §0 said so.
- [ ] In `.env.air.poller`, set:
  - `AIR_GITHUB_TOKEN` (operator);
  - `AIR_OPERATOR_SIGNING_KEY`;
  - `AIR_AGENT_LAUNCH_PHASES=requirements,design,build,review`.
- [ ] In `.env.air.agent`, set:
  - `AIR_AGENT_TOKEN`, `AIR_AGENT_SIGNING_KEY` and `ANTHROPIC_API_KEY`;
  - `AIR_AGENT_MODE=headless`;
  - `AIR_AGENT_MAX_RUNTIME=1h`.
- [ ] Build the images: `docker compose --profile agent build`.

## 4. Doctor

- [ ] In the AIR clone, run `AIR_DOCTOR_TOKEN=$(gh auth token) node dist/src/delivery/composition/agent-cli.js doctor`.

**Expect** `ok` for:

- `AIR_GITHUB_TOKEN belongs to operator …` and `AIR_AGENT_TOKEN belongs to agent …`;
- `The operator's signing key matches its public key`, and the same for the agent;
- `The AIR policy is valid`;
- `Every lens the policy can require is installed (…)`.

**Expect no** `setup.agent-mode` warning, since the agent is headless.

Fix every `FAIL` before going on. Then try one failure on purpose:

- [ ] Put the operator token in `AIR_AGENT_TOKEN` for a moment. **Expect** `FAIL  AIR_AGENT_TOKEN belongs to <operator>, not to agent …`. Put it back.

## 5. Start

- [ ] `docker compose up -d poller`, then follow `docker compose logs -f poller`.
- [ ] Start the launcher with no tokens or keys in its environment, as in [Running AIR in Docker §4](docker.md#4-automatic-agent-runs): `mkdir -p .air/launch`, then `AIR_AGENT_MAX=1 node dist/src/delivery/composition/launcher.js`.
- [ ] Optional: start the console as in [Running AIR in Docker §5](docker.md#5-console), with its own `.env.air.ui`, and open `http://localhost:7420/`.

## 6. The happy path

Open issue **A**: *"Add a `sum(a, b)` function in `src/sum.js` with tests."*

1. [ ] Comment `/air initialize`.
   - **Expect:** a reply `applied. State: requirements:ready`.
   - **Expect:** the launcher logs `#A requirements: started`.
   - **Expect:** a container `air-agent-A-requirements-…` (check with `docker ps --filter label=air.agent.issue`).
2. [ ] Wait for the requirements report.
   - **Expect:** it starts with `## Summary` and one to five bullets.
   - **Expect:** the run ends by itself, and the issue moves to `requirements:waiting`.
   - **Expect:** the console's issue page shows the bullets.
   - In the agent audit volume, look for the `claude-issue-A-….jsonl` transcript.
3. [ ] Advance as the reply suggests (`/air advance design` or `/air advance build`). In build, **expect**:
   - a pull request from `air/issue-A`;
   - green checks (in lite mode, the operator runs `air-check` after each push, as [ADR-0016](../architecture/adr/0016-lite-mode.md) describes);
   - the gate passes, and the issue moves to `build:waiting`.
4. [ ] `/air advance review`. **Expect** a review report with `lenses` and `lensVerdicts`, at least `code`, `tests` and `scope`, all `pass`; then `review:waiting`. The console shows `code (pass), …`.
5. [ ] Merge the pull request yourself. Accept and observe need the deploy workflow; this run stops here.

## 7. The safeguards

Run each with its own issue. Each one checks a rule that tests can't check against the real services.

**B. Protected paths** ([ADR-0017](../architecture/adr/0017-protected-paths.md)). Issue: *"Reword the first paragraph of `.claude/skills/air-delivery/lenses.md`."*

- [ ] **Expect:** in build, the gate refuses with `Pull request changes protected files: .claude/skills/air-delivery/lenses.md. An approver who reviewed this commit can allow it with /air allow-protected <sha>`.
- [ ] **Expect:** the run ends in `build:blocked`, and the block quotes that line.
- [ ] Review the pull request, then comment `/air allow-protected <sha>`. **Expect** `applied`, and an operator comment *Protected change allowed for #… at commit …*.
- [ ] `/air unblock` with a short note. **Expect** a new run whose gate passes.
- [ ] Push one more commit to the branch yourself, then advance. **Expect** the protected-files problem again with the new commit: the approval was for the old one.
- [ ] Try `/air allow-protected <old sha>`. **Expect** `rejected (precondition-failed) … not <old sha>: review the latest commit`.

**C. Review rounds.** Before the issue, set `"reviewRounds": 1` in `.github/air-policy.json` on the default branch, committed by you. Issue: *"Add `parse(expr)` that evaluates arithmetic from user input; `eval` is fine."*

- [ ] **Expect** the `security` lens to say `changes`.
- [ ] **Expect** one of two outcomes, and note which:
  - the agent fixes it within the round and the next report is all `pass`;
  - or the gate says `Review lenses still ask for changes after 1 round: security …` and the run ends blocked with the findings.
- [ ] Set `reviewRounds` back to 2 afterwards.

**D. A session that stops early.** Set `AIR_AGENT_MAX_TURNS=5` in `.env.air.agent` for one issue. You don't need to rebuild; each run reads it.

- [ ] **Expect:** the session runs out of turns.
- [ ] **Expect:** the container log shows `air-agent: session ended`, then `would reject: …`.
- [ ] **Expect:** the issue is `…:blocked`, with *The agent session ended before the gate passed* and the gate's problems.
- [ ] Remove the setting afterwards.

**E. A container that dies.** Start any issue. While the agent works, run `docker kill air-agent-<n>-<phase>-<time>`.

- [ ] **Expect:** within a few seconds, the launcher logs `#<n> air-agent-… died: finishing (exit 137)`.
- [ ] **Expect:** a container `air-agent-<n>-finish-…` labelled `air.agent.finishes=…`.
- [ ] **Expect:** the issue ends `…:blocked`, or `…:waiting` if the gate happened to pass.
- [ ] **Expect:** the launcher starts no second finisher in later rounds.

**F. The Stop hook.** This one is hard to provoke on purpose. While reading the transcripts from 6–7, look for a turn where Claude Code continued after `AIR: the gate would refuse this phase…`, and note whether it happened.

## 8. Afterwards

- [ ] Verify the audit logs:
  - poller: `docker compose run --rm --entrypoint node poller dist/src/delivery/composition/agent-cli.js audit verify /var/lib/air/audit-poller.jsonl`;
  - agent: run `audit verify` on the files in the `air-agent-audit` volume.
- [ ] Check that no `…:working` label is left without a running container.
- [ ] Revoke the tokens, or keep the repository for the next release.

## 9. What to send back

For each of 4, 6 and 7 (B–F): **ok** or **differs**, and for each difference:

- what you did and what you expected, from this page;
- what happened: the issue comments, or a screenshot of the console's issue page;
- the poller and launcher logs around that time;
- for agent runs, the container log (`docker logs air-agent-…`) and, if useful, the `claude-issue-….jsonl` transcript. Transcripts hold the repository's code and the agent's reasoning; check them before sharing.

Never send `.env.air*` files, tokens or signing keys.
