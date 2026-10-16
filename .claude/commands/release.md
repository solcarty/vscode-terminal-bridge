# /release — Manual backup for a release CI didn't publish

Releases are automatic. Merging a PR to `main` runs
`.github/workflows/release.yml`, which packages the VSIX, pushes an annotated
`v<version>` tag and creates the GitHub Release with
`terminal-bridge-<version>.vsix` attached. The version bump lives in the PR and
`.github/workflows/version-check.yml` enforces it (see "Releasing" in
`CLAUDE.md`). **Normally there is nothing to do here.**

## When to use

Only when the workflow can't finish the job:

- `release` failed and a re-run won't fix it (for example GitHub Actions is down).
- The run logged `vX.Y.Z is tagged at another commit and has no release`.

If a merged version simply has no release yet, first try re-running the
workflow: **Actions → release → Run workflow** on `main`, or
`gh workflow run release.yml --repo solcarty/vscode-terminal-bridge`. A run that
tagged the current commit and then failed is finished by a re-run.

Never bump the version here: that belongs in a PR.

## Steps

1. **Check what's missing.**
   ```bash
   gh release list --repo solcarty/vscode-terminal-bridge -L 3
   git fetch --tags && git tag -l 'v*' --sort=-v:refname | head -3
   gh run list --repo solcarty/vscode-terminal-bridge --workflow release.yml -L 5
   ```

2. **Package from the commit the tag points at** (or `origin/main` if there's no tag yet), into a scratch dir, never the repo:
   ```bash
   git checkout v<version>          # or origin/main
   npx @vscode/vsce package --skip-license -o /tmp/terminal-bridge-release/
   ```

3. **Tag, if the tag doesn't exist yet:**
   ```bash
   git tag -a v<version> -m "v<version>"
   git push origin v<version>
   ```

4. **Create the release with the VSIX attached:**
   ```bash
   gh release create v<version> /tmp/terminal-bridge-release/terminal-bridge-<version>.vsix \
     --repo solcarty/vscode-terminal-bridge --verify-tag \
     --title "v<version>" --generate-notes --notes-start-tag v<previous-version>
   ```

5. **Check it, then clean up:**
   ```bash
   gh release download v<version> --repo solcarty/vscode-terminal-bridge -p '*.vsix' -D /tmp/check
   rm -rf /tmp/terminal-bridge-release /tmp/check
   ```

A version bump on `main` with no tag and no GitHub Release is not a release.
Both the tag and the release with the VSIX attached are required.
