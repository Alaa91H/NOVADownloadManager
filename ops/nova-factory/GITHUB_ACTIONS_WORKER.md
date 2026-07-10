# GitHub Actions Worker Autoprovisioning

NOVA can use GitHub Actions as the remote worker for public repositories. The weak server remains a control plane: it creates jobs, dispatches workflows, monitors CI, and reports results. It does not run heavy local build, lint, test, or package work.

## Required repository permissions

The `gh` identity configured on the server must have permission to create or update `.github/workflows/nova-worker.yml`.

For a classic PAT, include `repo` and `workflow` scopes when direct workflow commits are enabled. For fine-grained tokens, allow repository contents and actions/workflows access according to the repository policy.

## Default safe mode

By default the factory uses PR provisioning:

```bash
NOVA_AGENT_DISPATCH_MODE=github-actions
NOVA_GITHUB_WORKER_AUTO_PROVISION=1
NOVA_GITHUB_WORKER_PROVISION_MODE=pr
NOVA_GITHUB_WORKER_BASE_BRANCH=main
```

In this mode, the first dispatch creates or updates a branch named `nova/bootstrap-github-worker` and opens a PR. The workflow is not dispatched until the PR is merged. This avoids silently changing CI on the default branch.

## Direct commit mode

If the repository permissions are already adjusted and you want the agent to create the workflow immediately, set:

```bash
NOVA_AGENT_DISPATCH_MODE=github-actions
NOVA_GITHUB_REPO=Alaa91H/NOVADownloadManager
NOVA_GITHUB_WORKER_AUTO_PROVISION=1
NOVA_GITHUB_WORKER_PROVISION_MODE=commit
NOVA_GITHUB_WORKER_BASE_BRANCH=main
```

Then run:

```bash
sudo /usr/local/lib/nova/nova-admin.py github-worker ensure-workflow
sudo /usr/local/lib/nova/nova-admin.py github-worker dispatch --task "Analyze repository and report issues" --mode analyze --target-branch main
```

Or from Telegram:

```text
/github_worker status
/github_worker ensure-workflow
/github_worker dispatch Analyze repository and report issues
```

## Behavior

`nova-github-actions-worker.py` performs these steps:

1. Checks whether `.github/workflows/nova-worker.yml` exists on the configured base branch.
2. If missing and autoprovision is enabled, renders a workflow matching NOVA worker requirements.
3. In `pr` mode, opens or updates a PR and tells the dispatcher to retry later.
4. In `commit` mode, commits the workflow directly to the base branch and dispatches it.
5. Calls `gh workflow run` with `job_id`, `task`, `mode`, and `target_branch`.

## Production recommendation

Use `pr` mode for first-time rollout, verify the generated workflow, merge the PR, then keep the mode as `commit` only if you intentionally want NOVA to maintain that workflow automatically.

## Branch policy integration

The worker follows the adopted NOVA branch policy automatically.

Recommended settings:

```bash
NOVA_STABLE_BRANCH=main
NOVA_DEVELOP_BRANCH=develop
NOVA_BRANCH=develop
NOVA_BRANCH_POLICY_AUTOPROVISION=1
NOVA_GITHUB_WORKER_BASE_BRANCH=develop
```

Before the worker provisions `.github/workflows/nova-worker.yml`, it runs branch-policy adoption when enabled. This creates `develop` from the legacy `Dev` branch when present, otherwise from `main`. The generated workflow listens on `main`, `develop`, and optionally legacy `Dev` during migration.

Use:

```bash
sudo /usr/local/lib/nova/nova-admin.py branch-policy ensure
sudo /usr/local/lib/nova/nova-admin.py github-worker ensure-workflow
```
