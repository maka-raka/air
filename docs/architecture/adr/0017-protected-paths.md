# ADR-0017 — Protected Paths and Required Lenses in the Gate

- **Status:** Proposed for review (implemented: protected paths, required lenses, policy file, `air lenses`)
- **Date:** 2026-11-21
- **Scope:** Which files a delivery's own pull request may not change, which review lenses it must run, where those rules come from, and how the phase gate enforces them
- **Builds on:** [ADR-0007](0007-threat-model-and-trust-boundaries.md) (threat model), [ADR-0010](0010-zero-trust.md) (zero trust), [ADR-0013](0013-agent-roles.md) (review lenses), [ADR-0016](0016-lite-mode.md) (lite mode)
- **Tracking:** [#98](https://github.com/maka-raka/air/issues/98)

## Context

The gate judges a pull request by its checks and, in review, by the lenses the agent ran. Both are made of files in the repository: CI workflows in `.github/`, the review lenses in `.claude/agents/air-review-*.md`, the lens table and the delivery skill in `.claude/skills/air-delivery/`. A pull request can change those files too, so an agent could weaken a lens, drop a CI step or rewrite the skill in the same change the gate then lets through.

Until now, only the platform guarded these files: Code Owners and branch rules in the [repository hardening](../../engineering/security-hardening.md), and the Docker agent's check of an existing branch. The gate itself didn't look. In lite mode there are no branch rules at all, so nothing did.

The lenses had the same weakness. The agent chose them from the table in `lenses.md`, and nothing checked that the ones the table calls for actually ran: the gate only read the `lenses` the report named.

The ZazenCodes "software factory" (v2) solves both with configuration its scripts read: a `protected_paths` list its gate enforces, and a routing table that picks reviewers from risk and changed surfaces.

## Decision

1. **Domain.** `PathPattern` is a path glob anchored at the repository root: `*` and `?` match within one segment, a `**` segment matches any number of segments. Matching ignores case and treats every character, line breaks included, as part of a path, so a name can't slip past a pattern. `ProtectedPaths` lists the paths of a change that some pattern matches. The domain knows nothing about files on disk or platforms.

2. **Use case.** `CodeChangeCheck` gives the gate's problems for a code change. The gate stays closed when:
   - the change doesn't merge into the default branch, since its file list would be relative to a branch the agent may have made;
   - the tracker can't list all its files (GitHub lists at most 3,000);
   - it adds, changes, removes or renames a protected path, where both paths of a rename count;
   - the policy file is invalid.

   The problem names up to ten paths, made safe to show on one line.

3. **Ports.** `CodeChangeFilesPort` reads what a change touches. `DeliveryPolicyPort` reads the project's policy. On GitHub, `/pulls/{n}` and `/pulls/{n}/files` serve the first, and `/contents/.github/air-policy.json` on the default branch serves the second. The policy is never read from the pull request, so the change can't edit the rules it is judged by. The memory tracker implements both for tests (ADR-0009).

4. **Where it applies.** `EvaluatePhaseGate` runs the check in the build and review phases, after the pull request is found open or merged. Requirements, design, accept and observe have no code change to check.

5. **Required lenses.** `LensRules` in the domain derives the lenses a change needs: some always, some for each path rule a changed path matches, some for the intake's risk. In review, `CodeChangeCheck` compares them with the report's `lenses`, and the gate names any that are missing. The agent may run more, never fewer. The risk is the one the requirements report recorded, `low` when it named none, as for model routing. The agent states it, so path rules, which it can't influence, carry the lenses that matter most.

6. **`air lenses <issue>`.** `ReadRequiredLenses` prints the lenses the gate will require for the delivery's pull request, with anything else that would keep the gate closed. It reads and records nothing. The skill tells the agent to run it before choosing lenses.

7. **The policy file.** `.github/air-policy.json`, written by `air init` (not in demo mode) and never updated by `air templates`, because JSON can't carry a template marker:

   ```json
   {
     "protected": [".github/**", ".claude/**"],
     "lenses": {
       "always": ["code", "tests", "scope"],
       "paths": {
         "**/package.json": ["deps"],
         "**/package-lock.json": ["deps"],
         "**/migrations/**": ["data"]
       },
       "risk": { "high": ["security"] }
     }
   }
   ```

   Without the file, AIR uses these defaults. A `protected` list replaces the default list, and a `lenses` section replaces the default lens rules, where a part it leaves out requires nothing. The defaults name standard lenses only, which `air init` installs: a required lens the project lacks would keep every review gate closed. The policy file itself is always protected. The file is strict: an unknown key, a malformed pattern or lens name, an unknown risk, more than 100 patterns or path rules, or more than 32 lenses in a list makes it invalid. The gate then stays closed, so a typo can't quietly drop a protection or a required lens.

## Consequences

- A delivery that needs to change a protected file can't pass the gate. A person makes that change in a separate pull request, outside AIR, for now. A signed operator decision that allows it for one head commit is planned (#98, step 3).
- AIR's own repository, and any project that keeps product code under `.github/` or `.claude/`, will want to narrow the list in the policy file.
- The check runs when the gate is evaluated. A commit pushed after the review gate passed isn't seen until the next gate. In standard mode, branch rules and Code Owners still cover that gap. Binding the gate's result to the head commit is follow-up work, as it is for checks.
- One more API call per gate, plus one per hundred changed files.
- `lenses.md` stays as guidance for optional lenses. What is required lives in the policy file, so it is protected like the rest of the rules.
- A project that has removed a standard lens must also remove it from the policy, or reviews can't pass.
