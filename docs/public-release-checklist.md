# AI Relay — Public Release Readiness Checklist

> Status: **Public.** The repository was made public and the owner decided on 2026-11-18 to keep it public under Apache-2.0. Unchecked items below still need the owner's sign-off. This is a decision gate, not proof of permission or safety.

## Ownership and legal review — mandatory manual approval

- [ ] Confirm that all pre-existing material, architecture descriptions and derivations are owned by the publisher or are authorized for public release.
- [ ] Confirm no employer, contractor, partner or confidentiality terms restrict publication.
- [ ] Identify any third-party material and comply with its license/attribution terms.
- [x] Choose and add an explicit root `LICENSE` **only after** rights are confirmed. Apache-2.0, chosen by the owner on 2026-11-18.
- [ ] Record owner approval outside the repository if confidential.

Without an explicit license, third parties do not automatically gain permission to copy, modify or redistribute the repository contents.

## Security and privacy

- [ ] CI secret scanner passes for current files and full reachable Git history.
- [ ] Manually review old commits, removed material, PR descriptions, comments and Actions logs.
- [ ] Scan detached/unreachable refs and any forks or artifacts before public exposure when accessible.
- [ ] Confirm there are no private project identifiers, real resource paths, data, service account IDs, production domains or incident details.
- [ ] Confirm any accidentally exposed credentials were rotated; rewriting history is not a substitute.
- [ ] Confirm no workflow grants unnecessary write permissions or runs privileged code from untrusted PRs.
- [ ] Enable secret scanning, Dependabot and branch protection/rulesets as available on the selected plan.
- [ ] Make a deliberate decision about publishing architecture diagrams: public Pages content is accessible to others.

## Repository hygiene

- [ ] Review `SECURITY.md` and private reporting mechanism.
- [ ] Review `CONTRIBUTING.md` and documentation for external audiences.
- [ ] Configure required CI checks and PR review on `main`.
- [ ] Check CI remains passing after visibility change.
- [ ] Make sure examples are synthetic and future adapter configurations reside outside the public repository.

## Release decision

- Decision owner: repository owner (maka-raka)
- Date: 2026-11-18
- Rights confirmation reference (non-sensitive):
- Approved license: Apache-2.0
- Security review:
- Final decision: **Public, Apache-2.0** (2026-11-18)

Publishing GitHub Pages is a separate decision. Projects that run the AIR agent should stay private: see `air doctor` and [security hardening](engineering/security-hardening.md).
