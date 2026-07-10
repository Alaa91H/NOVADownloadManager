# Branch Policy

NOVA adopts a PR-based branch model for long-running production development.

## Permanent branches

- `main`: stable releases only.
- `develop`: continuous development and integration.

`Dev` is supported as a legacy migration branch through `NOVA_LEGACY_DEVELOP_BRANCH=Dev`, but the preferred branch is `develop`.

## Temporary branches

- `agent/*`: autonomous task branches.
- `feature/*`: human feature branches.
- `fix/*`: scoped fixes and CI repairs.
- `release/*`: beta/stable preparation.
- `hotfix/*`: urgent stable fixes from `main`.

## Enforcement

The policy tool is installed at:

```bash
/usr/local/lib/nova/nova-branch-policy.py
```

Admin boundary commands:

```bash
sudo /usr/local/lib/nova/nova-admin.py branch-policy status
sudo /usr/local/lib/nova/nova-admin.py branch-policy ensure
sudo /usr/local/lib/nova/nova-admin.py branch-policy validate-branch develop
sudo /usr/local/lib/nova/nova-admin.py branch-policy guard-push main
sudo /usr/local/lib/nova/nova-admin.py branch-policy target-for fix
sudo /usr/local/lib/nova/nova-admin.py branch-policy branch-name --kind fix --title "repair CI failure"
```

Default safety settings:

```bash
NOVA_STABLE_BRANCH=main
NOVA_DEVELOP_BRANCH=develop
NOVA_BRANCH=develop
NOVA_BRANCH_POLICY_ENFORCE=1
NOVA_BRANCH_POLICY_ALLOW_DIRECT_MAIN=0
NOVA_BRANCH_POLICY_ALLOW_DIRECT_DEVELOP=0
NOVA_BRANCH_POLICY_CREATE_DEVELOP=1
NOVA_BRANCH_POLICY_APPLY_PROTECTION=0
```

`ensure` creates `develop` from `Dev` when the legacy branch exists; otherwise it creates `develop` from `main`. If `NOVA_BRANCH_POLICY_APPLY_PROTECTION=1`, it attempts to apply GitHub branch protection for `main` and `develop` using `gh api`. Protection requires a token with sufficient repository administration rights.

## GitHub Actions worker integration

`nova-github-actions-worker.py` now renders workflow triggers from the adopted policy. Regular jobs target `develop`. Stable release checks target `main`. Invalid target branches fall back to the policy target.

## Local agent integration

If local agent execution is explicitly used, the agent calls `guard-push` before committing. Direct pushes to `main` and `develop` are denied by default; the agent creates an allowed task branch and opens a PR to `develop` when `gh` is available.
