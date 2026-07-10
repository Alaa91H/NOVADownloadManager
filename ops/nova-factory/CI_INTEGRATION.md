# NOVA CI Integration

`nova-ci.py` is read-only. It uses GitHub CLI to inspect workflow runs, failed runs, pull requests, and releases. It does not run local builds, tests, package managers, TypeScript, ESLint, Playwright, or project compilation on the orchestration server.

Commands:

```bash
/usr/local/lib/nova/nova-admin.py ci status
/usr/local/lib/nova/nova-admin.py ci failed
/usr/local/lib/nova/nova-admin.py ci prs
/usr/local/lib/nova/nova-admin.py ci release
```

Telegram equivalents:

```text
/ci status
/ci failed
/ci prs
/ci release
```

The server remains an orchestrator. Heavy validation remains in GitHub Actions unless `NOVA_LOCAL_BUILD_ENABLED` is explicitly introduced and implemented in a sandboxed runner.

## Auto-provisioned Nova Worker workflow

When `NOVA_AGENT_DISPATCH_MODE=github-actions`, NOVA uses `nova-github-actions-worker.py` to ensure that `.github/workflows/nova-worker.yml` exists before dispatching queued work. This keeps the weak server as a control plane and moves validation work to GitHub-hosted runners.

Use PR provisioning for safe rollout:

```bash
NOVA_GITHUB_WORKER_PROVISION_MODE=pr
```

Use direct commit provisioning only after repository permissions and branch protection policy are intentionally configured:

```bash
NOVA_GITHUB_WORKER_PROVISION_MODE=commit
```
