# NOVA Factory — professional autonomous development bundle

A portable, server-side factory for continuous repository development and operations. It installs the controller, Telegram interface, service monitor, watchdog, update manager, daily digest, guardian git hooks, and systemd units onto an Ubuntu 22.04/24.04 host.

This bundle contains no secrets: no bot token, no GitHub credentials, no SSH keys, and no runtime state. Secrets stay in `/etc/nova/nova.env` with mode `0600`.

## Capabilities

- Continuous development controller with CI-backed validation policy.
- Telegram control surface for status, plans, logs, service control, updates, rollback, and doctor checks.
- Privileged command boundary through `/usr/local/lib/nova/nova-admin.py`; the bot does not receive unrestricted root or shell access.
- Self-update manager through `/usr/local/lib/nova/nova-updater.py`:
  - checks the managed repo branch,
  - updates the repo with `ff-only`, `rebase`, or controlled `reset`,
  - validates Bash and Python syntax before applying runtime files,
  - backs up installed factory files and NOVA units,
  - applies bot/controller/systemd/script updates,
  - restarts services safely,
  - rolls back automatically on failure,
  - supports manual `/update apply` and timer-driven auto-update.
- Root-owned local factory cache at `/usr/local/lib/nova/factory-source` for recovery and fallback repairs.
- Systemd watchdog and monitor keep controller, Telegram, watchdog, maintenance, daily digest, API health, and self-update timers alive.
- Local heavy build/test/lint/package commands remain blocked by default; GitHub Actions is the validation authority.

## Layout

```text
nova-factory/
├── install.sh
├── VERSION
├── config/nova.env.example
├── lib/
│   ├── agent.sh
│   ├── monitor.sh
│   ├── controller-guard.sh
│   ├── daily-digest.py
│   ├── nova-admin.py
│   ├── nova-updater.py
│   ├── nova-config.py
│   ├── nova-backup.py
│   ├── nova-health.py
│   ├── blocked-bin/block-command
│   └── scripts/
│       ├── analyze.sh
│       ├── api-health.sh
│       ├── doctor.sh
│       ├── maintenance.sh
│       ├── metrics.sh
│       ├── research.sh
│       ├── self-update.sh
│       ├── package-validate.sh
│       └── watchdog.sh
├── repo-overlay/
│   ├── nova-bot.py
│   ├── nova-bot-update.py
│   ├── nova-dev-agent.sh
│   ├── nova-watchdog.py
│   ├── AGENTS.md
│   └── CONSTITUTION.md
├── git-hooks/
└── systemd/
```

## Prerequisites

Install these on the target server first:

| Tool | Purpose |
|---|---|
| Python 3.11+ and pip | Telegram bot, updater, digest, admin boundary |
| git and GitHub CLI `gh` | repository updates, pushes, CI status |
| opencode | autonomous execution engine |
| Node.js 20+ | optional context for the repo; local build tools remain blocked unless explicitly enabled |
| Telegram bot token | control and notifications |
| systemd + sudo | services, timers, controlled privileged actions |

## Install

```bash
tar xzf nova-factory.tar.gz
cd nova-factory
sudo TARGET_USER=ubuntu PROJECT_DIR=/home/ubuntu/NOVA ./install.sh
```

The installer:

1. installs root-owned runtime files to `/usr/local/lib/nova`,
2. stores a recovery source copy at `/usr/local/lib/nova/factory-source`,
3. writes `/etc/nova/nova.env` only if it does not already exist,
4. clones or reuses the configured repo,
5. overlays server-only bot/controller files into the repo worktree,
6. installs local git hooks,
7. installs systemd services/timers,
8. installs `/etc/sudoers.d/nova-factory` so the target user may run only `/usr/local/lib/nova/nova-admin.py *` as root,
9. enables the core services and timers.

## Configure

Edit:

```bash
sudo nano /etc/nova/nova.env
sudo chmod 600 /etc/nova/nova.env
```

Minimum required values:

```env
NOVA_BOT_TOKEN=<telegram-bot-token>
NOVA_OWNER_IDS=<your-numeric-telegram-user-id>
NOVA_OPERATOR_IDS=
NOVA_VIEWER_IDS=
NOVA_GH_REPO=owner/repo
NOVA_BRANCH=develop
NOVA_AGENT_MODEL=opencode/big-pickle
```

Recommended self-update settings:

```env
NOVA_SELF_UPDATE_ENABLED=1
NOVA_UPDATE_STRATEGY=ff-only
NOVA_FACTORY_SOURCE_DIR=ops/nova-factory
NOVA_BACKUP_DIR=/var/backups/nova
NOVA_BACKUP_RETENTION_DAYS=14
NOVA_BACKUP_MAX_COUNT=20
NOVA_UPDATE_BACKUP_KEEP=8
```

For full factory self-updates, keep this package inside the managed repo at `ops/nova-factory`. If that path is absent, the updater can still update the project repo and use the local cached factory source, but it cannot receive new factory files from the repo.

## Start

```bash
sudo -u ubuntu gh auth login
# install/authenticate opencode for ubuntu
sudo /usr/local/lib/nova/nova-admin.py config validate
sudo /usr/local/lib/nova/nova-admin.py health --write
sudo /usr/local/lib/nova/nova-admin.py doctor
sudo systemctl start nova-monitor nova-bot nova-dev-agent
```

In Telegram:

1. send `/myid`,
2. put the numeric ID in `NOVA_OWNER_IDS`,
3. restart `nova-bot.service`,
4. send `/register` from the owner account.

## Telegram operations

Core commands:

```text
/menu                 Open the control surface
/tasks                Show roadmap tasks
/server               Server status
/logs [n] [source]    Logs; sources: controller, telegram, watchdog, maintenance
/svc                  Show NOVA services
/svc <unit> <action>  status/start/stop/restart/enable/disable for allowlisted nova units
/update status        Show update manager state
/update check         Fetch/check remote status
/update apply         Backup, validate, apply update, restart services
/update rollback      Restore latest update backup
/doctor               Run installation diagnostics
/health               Generate health snapshot
/config validate      Validate /etc/nova/nova.env
/config safe          Print redacted configuration
/backup list          List backups
/backup create label  Owner-only operational backup
/backup restore path  Owner-only restore
/reload               Alias for controlled update apply
```

`/exec` remains disabled by default. Enabling it is not recommended; operational coverage should come from explicit commands and `nova-admin.py`, not arbitrary shell.

## Self-update model

The update path is deliberately controlled:

```text
Telegram / timer
  → sudo -n /usr/local/lib/nova/nova-admin.py update <action>
  → /usr/local/lib/nova/nova-updater.py
  → backup → git update → source validation → runtime sync → systemd reload → service restart
  → automatic rollback on failure
```

The updater never trusts arbitrary bot text as a shell command. It accepts fixed actions only.

### Manual update

```bash
sudo /usr/local/lib/nova/nova-admin.py update check
sudo /usr/local/lib/nova/nova-admin.py update apply
sudo /usr/local/lib/nova/nova-admin.py update rollback
```

### Timer-driven update

`nova-self-update.timer` runs periodically. The service exits without changes when `NOVA_SELF_UPDATE_ENABLED=0` or when the branch is already current.

```bash
systemctl list-timers 'nova-*'
journalctl -u nova-self-update.service -n 100 --no-pager
```

## Security defaults

- `/register` requires `NOVA_OWNER_IDS`; no first-user takeover.
- Bot privileged operations go through `nova-admin.py`, a root-owned allowlist boundary.
- Telegram users are role-gated via `NOVA_OWNER_IDS`, `NOVA_OPERATOR_IDS`, and `NOVA_VIEWER_IDS`.
- Every privileged admin invocation is recorded in `/var/log/nova/audit.log`.
- `/exec` is off by default and should stay off.
- Runtime state is under `/var/lib/nova`, logs under `/var/log/nova`.
- Build/test/lint/package tools are blocked in AI-controlled service PATH by default.
- Systemd units use resource caps and filesystem restrictions where compatible with required operations.
- Update backups are mode `0600` under `/var/lib/nova/backups`.

## Operational checks

```bash
sudo /usr/local/lib/nova/nova-admin.py config validate
sudo /usr/local/lib/nova/nova-admin.py health --write
sudo /usr/local/lib/nova/nova-admin.py doctor
systemctl status nova-dev-agent nova-monitor nova-bot --no-pager
systemctl list-timers 'nova-*'
journalctl -u nova-bot -n 100 --no-pager
journalctl -u nova-self-update.service -n 100 --no-pager
```

## Retargeting

```bash
sudo TARGET_USER=myuser PROJECT_DIR=/srv/NOVA ./install.sh
```

The installer rewrites user, group, home, project path, and writable systemd paths.

## Policy note

This factory is designed for autonomy without arbitrary privilege. Full root shell through Telegram is intentionally not provided. The professional model is controlled capability expansion: add explicit admin actions, test them, and keep sudoers limited to the root-owned admin boundary.

## Additional operations documents

- `ARCHITECTURE.md` — component boundaries and update flow.
- `SECURITY.md` — RBAC, sudo boundary, audit, backups.
- `OPERATIONS.md` — daily commands, logs, config, backup/restore.
- `UPDATING.md` — self-update policy and timer behavior.
- `ROLLBACK.md` — rollback and emergency recovery.
- `TELEGRAM_COMMANDS.md` — command map by role.

## Release validation

From the extracted package directory:

```bash
./lib/scripts/package-validate.sh .
python3 -m py_compile lib/*.py repo-overlay/*.py
find . -type f -name '*.sh' -exec bash -n {} \;
```

## Enterprise Plus additions

This bundle adds a release and acceptance layer on top of the Enterprise self-management edition.

New local/admin capabilities:

- `nova-release.py validate|manifest|package|checksum|changelog`
- `nova-ci.py status|failed|prs|release`
- `nova-acceptance.py --json`
- `lib/scripts/run-tests.sh`
- `lib/scripts/release.sh`

New Telegram/admin commands:

- `/ci status`, `/ci failed`, `/ci prs`, `/ci release`
- `/release validate`, `/release manifest`, `/release package`, `/release checksum`, `/release changelog`
- `/acceptance`

Privileged actions invoked from Telegram now pass an audited actor and correlation id into `nova-admin.py`. Audit records therefore identify the Telegram user role and a per-command correlation id, making restart/update/backup operations traceable.

Recommended release gate:

```bash
./lib/scripts/package-validate.sh .
./lib/nova-release.py validate --path .
./lib/nova-acceptance.py --path . --json
./lib/nova-release.py manifest --path .
./lib/nova-release.py package --path . --output-dir ./dist
```

## Production hardening layer

The production edition adds two explicit gates:

```bash
lib/scripts/package-validate.sh .
lib/nova-acceptance.py --path . --json
sudo /usr/local/lib/nova/nova-admin.py certify --json
```

The Telegram bot no longer uses `create_subprocess_shell` for operational reads. Server status, disk/process views, and runtime reports are collected through `nova-admin.py system --format json`, backed by the read-only `nova-system.py` helper. This keeps Telegram command handling shell-free while preserving operational visibility.

The self-update timer is intentionally conservative: it checks twice daily with jitter rather than every few minutes. Urgent updates remain available through `/update apply` or `nova-admin.py update apply`.

See `PRODUCTION_READINESS.md` and `RUNTIME_CERTIFICATION.md` before calling a VM production-ready.

## Autonomous production orchestration

This package includes the autonomous orchestration layer documented in `ORCHESTRATION.md`: global leases, durable job queue, remote agent dispatch, alpha/beta/stable release train, emergency policy, roadmap scoring, and an orchestration kernel. The server remains a control plane; heavy build/test/deep development work is delegated to remote workers and GitHub Actions.

## Complete orchestration durability layer

The complete edition adds `nova-state.py` and state-integrity certification. Runtime JSON state is audited and corrupt files are quarantined under `/var/lib/nova/quarantine` rather than silently deleted. Deferred operations now have attempt tracking, bounded retries, and retry backoff; the orchestrator holds its own lease so overlapping timer/manual cycles do not race.

Additional commands:

```bash
sudo /usr/local/lib/nova/nova-admin.py state summary
sudo /usr/local/lib/nova/nova-admin.py state audit
sudo /usr/local/lib/nova/nova-admin.py state repair
```

Telegram: `/state summary|audit|repair`.

## GitHub Actions worker autoprovision

This edition can use GitHub Actions as the remote worker and create the required workflow file automatically when repository permissions allow it. Set `NOVA_AGENT_DISPATCH_MODE=github-actions` and configure `NOVA_GITHUB_REPO`.

Safe first-run mode creates a PR:

```bash
NOVA_GITHUB_WORKER_PROVISION_MODE=pr
```

Direct provisioning mode commits `.github/workflows/nova-worker.yml` to the base branch and then dispatches workflow runs:

```bash
NOVA_GITHUB_WORKER_PROVISION_MODE=commit
```

Operational commands:

```bash
sudo /usr/local/lib/nova/nova-admin.py github-worker status
sudo /usr/local/lib/nova/nova-admin.py github-worker ensure-workflow
sudo /usr/local/lib/nova/nova-admin.py github-worker dispatch --task "Analyze repository and report issues" --mode analyze --target-branch main
```

See `GITHUB_ACTIONS_WORKER.md` for the full policy.

- Branch policy adoption is documented in `BRANCH_POLICY.md`; use `nova-admin.py branch-policy ensure` before enabling continuous PR-based development.
