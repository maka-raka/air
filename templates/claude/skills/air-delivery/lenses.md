# Review lenses

Which `air-review-<lens>` subagents to run in the review phase. Edit this file to fit the project: AIR's `air templates` command never overwrites it once you changed it.

Some lenses are **required**: `npx air lenses <issue>` prints them, from the `lenses` section of `.github/air-policy.json` (always, by changed path, by risk), and the review gate stays closed until the report names each one. Change that file to change what is required; this table can't. Run the required lenses, plus each lens below whose trigger matches the diff or the issue. Run only lenses that are installed in `.claude/agents/`. A typical pull request needs two to four.

| Lens | Model | Run when |
| --- | --- | --- |
| `code` | sonnet | always |
| `tests` | sonnet | always |
| `scope` | haiku | always |
| `security` | opus | auth, authorization, crypto, secrets, `.github/`, build scripts, input parsing, external calls, or the issue is high-risk |
| `ux` | sonnet | user-facing UI, copy, forms, flows or error messages |
| `architecture` | opus | new modules, changes across layers, new dependencies between components, public interfaces |
| `performance` | sonnet | loops over data, database or API calls, hot paths, caching |
| `data` | opus | migrations, schemas, stored formats, code that deletes data |
| `api` | sonnet | public API, CLI, event or config formats |
| `docs` | haiku | changed behaviour, configuration, commands or setup |
| `deps` | sonnet | package manifests, lock files, base images |
| `resilience` | sonnet | external calls, queues, retries, background jobs |
| `concurrency` | opus | parallel code, shared state, locks, caches, event handling |
| `privacy` | opus | personal data, logging, analytics, data export |
| `infra` | sonnet | Terraform, Kubernetes, Docker, compose, CI configuration |
| `rollout` | sonnet | risky changes, migrations, new user-facing features |
| `cost` | haiku | cloud resources, model calls, heavy queries, verbose logging |
| `ai-safety` | opus | features that call language models or agents |
| `observability` | haiku | new features, background work, error handling |

The first eleven are installed by `air init`; the others with `air init --lens <name>` or `air templates --lens <name>`.

A project lens of your own: add `.claude/agents/air-review-<name>.md` (read-only tools: `Read, Grep, Glob`) and a row here. Report it in `lenses` like any other.
