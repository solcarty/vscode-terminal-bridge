# /release — Cut a new version and publish a GitHub Release with the VSIX

Ships a new version of this extension the way every past release has been done:
version bump, packaged VSIX, annotated tag, and a GitHub Release with the VSIX
attached and real release notes — not just a commit on `main`.

## When to use

After merging fixes/features you want to ship. If the user says "make a
release" or "cut a new version," this is the full checklist — don't stop at
just committing and pushing.

## Steps

1. **Confirm the working tree is clean and pushed.** `git status`, and make
   sure whatever you're releasing is already committed. If there are
   uncommitted changes relevant to the release, commit them first (see repo's
   CLAUDE.md / global git-commit conventions) — don't fold release mechanics
   into the same commit as the actual fix/feature.

2. **Pick the version number.** Check `package.json`'s current `version` and
   `git tag -l` / `gh release list` for the last shipped version. Bump
   patch/minor/major based on the size of the change (this project has used
   minor bumps liberally, e.g. every new endpoint or behavior change gets a
   minor bump: 0.14.0 → 0.15.0).

3. **Bump `package.json`:**
   ```bash
   # edit "version" field to the new version
   ```

4. **Package the VSIX into a scratch dir:**
   ```bash
   mkdir -p /tmp/terminal-bridge-release
   npx vsce package -o /tmp/terminal-bridge-release/
   ```
   Don't package into the repo tree at all — GitHub's release asset is the
   permanent copy, and old versions can always be reproduced later with
   `git checkout <tag> && npx vsce package` if ever needed. There is no
   reason to keep built VSIXes sitting in the repo (that's what got messy
   before — 16 of them accumulated in the repo root over time). If it warns
   about a missing LICENSE, that's expected and pre-existing — ignore it.

5. **Commit the version bump** (and any other release-relevant doc changes,
   e.g. README updates) with a message summarizing what's in the release —
   look at `git log` for the style prior releases used (e.g. `v0.14.0: add
   remote job execution via worker nodes + rmux`).

6. **Push the commit:**
   ```bash
   git push origin main
   ```

7. **Tag and push the tag** — this is the step that's easy to forget and the
   reason a version bump alone doesn't show up as a release:
   ```bash
   git tag -a v<version> -m "v<version>: <one-line summary>"
   git push origin v<version>
   ```

8. **Create the GitHub Release with the VSIX attached:**
   ```bash
   gh release create v<version> /tmp/terminal-bridge-release/terminal-bridge-<version>.vsix \
     --repo solcarty/vscode-terminal-bridge \
     --title "v<version>: <one-line summary>" \
     --notes "<release notes — see below>"
   ```
   Look at `gh release view v<prior-version> --repo solcarty/vscode-terminal-bridge --json body`
   for the notes style/format prior releases used (bullet list per
   fix/feature, referencing issue numbers where applicable).

9. **Clean up the scratch dir** — the VSIX now lives permanently as a
   GitHub Release asset, so there's no reason to keep the local copy:
   ```bash
   rm -rf /tmp/terminal-bridge-release
   ```

10. **If the release fixes filed GitHub issues**, close each one with a
    comment referencing the commit/tag, e.g.:

    ```bash
    gh issue close <n> --repo solcarty/vscode-terminal-bridge \
      --comment "Fixed in v<version>: <what changed>."
    ```

## Common mistake this skill exists to prevent

Bumping `package.json`'s version and committing is **not** a release — it's
invisible on the GitHub Releases page. A release requires an annotated git
tag pushed to the remote AND a `gh release create` call with the VSIX
attached. Both steps 7 and 8 are required; skipping either means "the new
release" won't show up where the user expects it.
