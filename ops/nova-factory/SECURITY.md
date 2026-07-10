# NOVA Factory Security Model

The system is designed around constrained capability rather than arbitrary remote shell.

## Hard rules

- No open `/register`. Registration requires `NOVA_OWNER_IDS`.
- No unrestricted sudo for the bot user.
- No raw root shell from Telegram.
- `/exec` is disabled by default and owner-only if explicitly enabled.
- Privileged operations must pass through `nova-admin.py`.
- Secrets live only in `/etc/nova/nova.env` and are redacted in safe diagnostics.
- Admin actions are logged to `/var/log/nova/audit.log` as JSONL.

## Roles

- `owner`: update apply/rollback, backup create/restore/prune, broadcast, optional exec.
- `operator`: service restart/start/stop, update check, doctor, direct controller prompts.
- `viewer`: status, health, logs, config safe/validate, backup list/inspect.

Configure roles in `/etc/nova/nova.env`:

```env
NOVA_OWNER_IDS=123456789
NOVA_OPERATOR_IDS=987654321
NOVA_VIEWER_IDS=111111111
```

Owners inherit all permissions.

## Sudo boundary

The only expected sudoers grant is:

```text
<TARGET_USER> ALL=(root) NOPASSWD: /usr/local/lib/nova/nova-admin.py *
```

Do not grant `NOPASSWD: ALL`.

## Audit log

`nova-admin.py` writes one JSONL record per privileged invocation with timestamp, command, return code, duration, sudo user, and optional correlation metadata. The log should remain root-owned and mode `0600`.

## Backups

Backups may contain `/etc/nova/nova.env`; treat backup archives as secrets. They are created mode `0600` under `/var/backups/nova` by default.
