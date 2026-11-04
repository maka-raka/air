# AIR Agent Engineering Contract

Follow `docs/engineering/architecture/playbook.md` and
`architecture/model.json` before editing production code.

For nontrivial changes, describe the domain responsibility, application
use case, required ports, adapters, and permitted dependencies before coding.

Do not weaken policy files or suppress checks to make a PR pass.
Run `npm run architecture:check`, `npm run policy:check`,
`npm run typecheck`, and `npm test`. Fix violations at their source.

The architecture model is an explicit contract, not an excuse to approve
arbitrary dependencies. Changes to it require architectural review.
