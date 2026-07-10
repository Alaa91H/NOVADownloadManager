# NOVA Factory Architecture

NOVA Factory is a server-side DevOps control plane for a managed repository. The system is intentionally split into layers so automation can be high while privilege remains auditable.

## Control path

```text
Telegram bot / systemd timer
  -> command router and RBAC
  -> /usr/local/lib/nova/nova-admin.py
  -> allowlisted tools only
  -> systemd, updater, backup, config, health, logs
```

The Telegram bot is not a privileged component. It runs as the target user and requests privileged work through `sudo -n /usr/local/lib/nova/nova-admin.py ...`. The sudoers rule grants only that root-owned executable.

## Runtime components

- `nova-bot.py`: Telegram interface, RBAC, menus, notifications, update/backup/config/health commands.
- `nova-admin.py`: privileged allowlist boundary and JSONL audit writer.
- `nova-updater.py`: self-update workflow with validation, backup, runtime sync, service restart, and rollback.
- `nova-config.py`: non-evaluating env parser, validator, redacted safe printer, template diff.
- `nova-backup.py`: root-owned backup/restore/prune manager.
- `nova-health.py`: health snapshot generator written to `/var/lib/nova/health.json`.
- `monitor.sh`: service monitor, restart cooldowns, health snapshot cadence.
- `watchdog.sh`: emergency recovery timer.
- `doctor.sh`: end-to-end diagnostics wrapper.

## State locations

```text
/etc/nova/nova.env          secrets and configuration, mode 0600
/usr/local/lib/nova/        root-owned runtime tools
/usr/local/lib/nova/factory-source/ local recovery source snapshot
/var/lib/nova/              state, health, update status, chat registration
/var/log/nova/              operational logs and audit log
/var/backups/nova/          root-owned backups
```

## Update lifecycle

```text
check -> backup -> git update -> source validation -> sync runtime files
      -> systemd daemon-reload -> service restart -> health snapshot -> status commit
      -> rollback on failure
```

Validation currently covers Bash syntax, Python compilation, package cleanliness, and basic systemd unit checks. Project build/test/lint remains CI-backed by default.
