# NOVA Telegram Commands

## Public/bootstrap

```text
/start       show bot info and current role
/myid        show your Telegram numeric user ID
/register    owner-only chat registration
```

## Read-only/viewer

```text
/menu
/server
/health
/logs [n] [controller|telegram|monitor|watchdog|maintenance|updater|audit]
/config validate
/config safe
/backup list
/backup inspect <archive>
/update status
/update history
```

## Operator

```text
/doctor
/update check
/svc <nova-unit> status
/svc <nova-unit> restart
/opencode <prompt>
```

Direct non-command messages are sent to the controller and therefore require operator permission.

## Owner

```text
/update apply
/update rollback
/backup create <label>
/backup restore <archive>
/backup prune
/config diff
/broadcast <message>
/reload
```

`/exec` is disabled by default and remains owner-only with an allowlist if enabled.

## Production hardening commands

```text
/ci status
/ci failed
/ci prs
/ci release

/release validate
/release manifest
/release package
/release checksum
/release changelog

/acceptance
/certify [--include-backup]
```

Access model:

- `/ci *`: viewer and above.
- `/release validate`: operator and above.
- `/release manifest|package|changelog`: owner only.
- `/acceptance`: operator and above.
- `/certify`: operator and above; `--include-backup` is owner-only.

All admin-backed commands are routed through `nova-admin.py` with actor and correlation id auditing.

## Autonomous orchestration commands

- `/queue list|stats|next|show|cancel` — inspect or control the durable job queue.
- `/lease status|due|clean|release` — inspect active leases and deferred operations.
- `/dispatcher status|dispatch-one|dispatch-loop` — dispatch queued jobs to a configured remote worker.
- `/train status|cut|promote|rollback|freeze|unfreeze` — manage alpha/beta/stable release trains.
- `/emergency status|check|restart-unhealthy` — inspect or run emergency recovery policy. Reboot requires owner and must be enabled in env.
- `/roadmap ideas|enqueue` — generate evidence-based roadmap ideas and optionally enqueue them.
- `/orchestrator status|cycle` — inspect or run a coordination pass.


## Additional production operations

`/queue reap-stale` requeues stale claimed/running jobs after the configured timeout. `/orchestrator cycle roadmap` runs one coordinated pass with deferred execution, queue reaping, dispatch, health snapshot, and optional roadmap enqueue.


## State integrity

```text
/state summary
/state audit
/state repair
```

`summary` and `audit` are viewer-safe. `repair` requires operator because it moves corrupt runtime JSON to quarantine.

## GitHub Actions worker

```text
/github_worker status
/github_worker ensure-workflow
/github_worker dispatch Analyze repository and report issues
```

`status` requires operator. `ensure-workflow` and `dispatch` require owner because they can create or trigger repository automation. In PR mode, workflow provisioning opens/updates a PR and the job is retried after merge. In commit mode, the workflow is committed directly to the configured base branch.

## Branch policy adoption

```text
/branch_policy status
/branch_policy ensure
/branch_policy validate-branch develop
/branch_policy guard-push main
/branch_policy target-for fix
/branch_policy branch-name fix downloader retry bug
```

`status` and validation commands are viewer-safe. `ensure` requires owner because it may create the `develop` branch and, if explicitly enabled with `NOVA_BRANCH_POLICY_APPLY_PROTECTION=1`, attempt to apply GitHub branch protection. The adopted policy is PR-based: `main` is stable-only, `develop` is continuous integration/development, and autonomous work uses `agent/*`, `fix/*`, `feature/*`, `release/*`, or `hotfix/*` branches.
