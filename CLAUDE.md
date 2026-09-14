# CLAUDE.md

## Releases

- One merge to main is one release: the next release candidate (`v0.1.0-rc.3` → `v0.1.0-rc.4`). `install.sh` installs `latest`, so the latest release has to be what is on main at all times.
- `.github/workflows/release.yml` cuts it after `ci` passes on main. Do not tag or release release candidates by hand.
- Wait for the previous merge's release to be published before merging the next PR. A merge that lands while the previous one is still in CI makes the workflow skip the older commit, and that merge gets no rc of its own.
- A merge is not done until its release exists: check `gh release view` shows a tag on the merged commit before reporting it.
- The version lives only in the tag. Every `package.json` stays at `0.0.0`.
- A final version is cut by pushing its tag (`v0.1.0`) by hand. The next merge after it becomes `v0.1.1-rc.1`.
