# Changelog

Changes that affect projects using AIR. Versions follow semver; before 1.0 a minor version may break.

## 0.3.0 (unreleased)

### Breaking

- **Node.js 24 is required** (was 22). AIR's bins, Docker images and CI now run on Node 24.
- **The deploy workflow moves to Node 24.** `air templates` updates an untouched `.github/workflows/air-deploy.yml` to `node-version: "24"`. Run `npx --no air templates --check` first and make sure the project's CI can use Node 24; if you changed the file, edit `node-version` yourself.

### Added

- **Demo mode** for a first try on a throwaway repository: `npx --no air init --demo <owner>/<repo>` installs the skill and four review lenses and writes a private `.env.air` with generated keys. Demo mode skips the repository hardening and is not production-safe: it is bound to the repository in `AIR_DEMO`, every process warns, and `air doctor` fails while it is on ([ADR-0014](docs/architecture/adr/0014-demo-mode.md)). Projects that do not set `AIR_DEMO` are unaffected.

### Changed

- Templates are grouped by provider in the package: `templates/claude/` (review lenses, `air-delivery` skill) and `templates/github/` (deploy workflow). Where they are installed in your project is unchanged, and untouched files update normally.
- Docker base images are pinned by digest.
