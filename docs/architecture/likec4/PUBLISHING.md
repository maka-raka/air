# Viewing and publishing AI Relay diagrams

The LikeC4 source model lives in this folder. Every pull request touching the model runs a validation and static-site build in GitHub Actions.

## Preview privately (default)

1. Open the `LikeC4 architecture` workflow run in the repository's Actions tab.
2. Download the `air-likec4-site` build artifact.
3. Extract it and serve the directory with a local static HTTP server (for example `python3 -m http.server 8080 --directory dist`).
4. Open http://localhost:8080/air/ **only if the files are served at that prefix**; for a local standalone preview the easiest approach is to run the development server instead (below).

For local interactive previews:

```bash
npm install --global likec4@1.60.0
cd docs/architecture/likec4
likec4 validate
likec4 start
```

Open http://localhost:5173. This does not publish anything.

## Public GitHub Pages (opt-in)

**Security warning:** a GitHub Pages site may be public even when the source repository is private. Only enable publication after confirming the model and its labels/metadata are suitable for public access. Private Pages access control requires eligible GitHub Enterprise Cloud features.

The workflow **does not deploy to Pages by default**. To explicitly publish:

1. Confirm that public publishing is acceptable.
2. In repository **Settings → Pages**, enable **GitHub Actions** as the build/deploy source (availability depends on GitHub plan).
3. In **Settings → Secrets and variables → Actions → Variables**, add `AIR_PAGES_PUBLICATION_ENABLED=true`.
4. Run the `LikeC4 architecture` workflow manually or merge a LikeC4 change into main.
5. Inspect the deployment URL in the workflow's `deploy` job.

Before opt-in, the workflow only validates the model, builds a static website and uploads an Actions artifact; it does **not** make the architecture publicly accessible.

## Local static production preview

The Pages output is built for `/air/`. To preview that exact build locally, run a web server rooted at the parent directory with the build output located at `air/`. For a simple local preview use `likec4 start` as described above.

## Maintenance

- Current LikeC4 version in CI: `1.60.0` (pinned).
- After a version update, rerun validation and inspect rendered diagrams before merge.
- Validation must pass for publication. All actual GitHub Pages deployments still require the explicit opt-in flag.
