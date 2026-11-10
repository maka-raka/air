# ADR-0006 — Conservative Deployment Events (`air-deploy`)

- **Status:** Proposed for review (approach selected for MVP)
- **Date:** 2026-11-11
- **Scope:** T10 `review:waiting → accept:ready`, T11 `accept:waiting → observe:ready`
- **Resolves:** the conservative rule in [Delivery State Machine §4](../delivery-state-machine.md#4-deployment-event-handling), accepted for the MVP

## Decision

A deployment workflow runs `air-deploy <stage|prod> <issue> <sha>` after a deployment finishes. `RecordDeployment`:

1. Validates the SHA and runs a deployer identity preflight.
2. **Always** adds the independent `air:deployed:<env>` label. `POST` adds a label without replacing the others.
3. Reads facts live from GitHub. The caller never supplies them:
   - `deploymentVerified`: the latest GitHub Deployment of `sha` to the mapped environment has status `success`;
   - `changeIncluded`: the merge commit of the PR named in the latest review or build report is `sha` or one of its ancestors (`compare` → `identical`/`ahead`);
   - `approvedMergedPr` (stage only): that PR is merged and has an `APPROVED` review.
4. Requests T10/T11 as `DeploymentWorkflow`. The policy advances **only** from `review:waiting` (stage) or `accept:waiting` (prod).
5. On any rejection the state is preserved and a `deployment-state-mismatch` notice is posted on the issue for human reconciliation. **Blocked is never overwritten.**

### Identity

The deployer is a third dedicated account: `AIR_DEPLOY_TOKEN`/`AIR_DEPLOY_LOGIN`, checked with `GET /user`. It must differ from `AIR_AGENT_LOGIN`, so the agent can never act as the deployment workflow. Agent records (which PR belongs to the issue) are trusted only from `AIR_AGENT_LOGIN`.

GitHub environment names are mapped with `AIR_ENVIRONMENT_STAGE`/`AIR_ENVIRONMENT_PROD` (defaults `stage`/`prod`).

## Consequences

- `air-deploy` exits `0` when the state is preserved. A mismatch is an expected outcome to reconcile, not a failed deployment.
- The deploy token needs Deployments: read, Pull requests: read, Issues: read and write and Contents: read (for compare).
- Only GitHub Deployments count as verification. Deployments recorded elsewhere must also be reported to GitHub.
