# Workflow operations

## Opt-in portable Windows PR build

The `portable-windows` workflow builds the canonical Windows x64 portable app
for a pull request only while that PR has the exact `portable-ci` label. The
workflow responds to PR creation, reopening, new commits, and applying that
label. Applying a different label or removing `portable-ci` does not build the
app.

A successful opt-in run exposes the executable under **Artifacts** on the
workflow-run summary as `germi-portable-windows-x64-pr-<PR number>`. PR
artifacts are retained for 14 days. Push, tag, and manual builds retain their
existing artifact name and release behavior.

### Manual verification

1. Open a PR into `main` without `portable-ci`; verify `portable-exe-pr` is
   skipped and no Windows runner starts.
2. Apply `portable-ci`; verify the `labeled` run builds `portable-exe-pr` and its
   artifact contains one `Germi-portable-<7-character SHA>-windows-x64.exe`.
3. Push another commit while the label remains; verify the `synchronize` run
   replaces the short SHA in the executable name.
4. Remove `portable-ci`; verify no `portable-windows` run is created for that
   removal. Reopen the unlabeled PR and verify `portable-exe-pr` is skipped.

Validate workflow syntax locally with:

```sh
actionlint .github/workflows/*.yml
```
