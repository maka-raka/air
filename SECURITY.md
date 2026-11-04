# Security Policy

AI Relay is currently in an **architecture-first, pre-release** stage. No stable supported version or production deployment is advertised.

## Reporting a vulnerability

**Do not open a public issue or pull request containing a secret, exploit details, or sensitive data.**

Use GitHub's **Report a vulnerability** / private vulnerability reporting feature if it is enabled for this repository. If it is not enabled, contact the repository maintainer privately through a previously established channel. Do not include credentials in initial reports.

The maintainer will triage a report, assess affected revisions, and coordinate a fix and disclosure. No response-time SLA is promised at this stage.

## Security boundaries

- AIR domain state machine and gates must not rely on instructions to an AI model as a security boundary.
- Never commit tokens, service-account files, production data, private endpoints, or customer information.
- Agent access to production systems must be limited by credentials and enforcement outside the agent process.
- Changes to `.github/`, `docs/architecture/`, and security rules require explicit maintainer review.

## If a secret is accidentally committed

Revoke or rotate the secret **first**, then remove affected material and investigate whether it was accessed. Removing a secret from a later commit does not make it safe in earlier Git history.
