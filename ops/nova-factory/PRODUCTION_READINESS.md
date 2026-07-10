# Production Readiness

This factory is production-oriented only when two gates pass:

1. Static package acceptance before release.
2. Runtime certification after installation on the target VM.

## Static gate

Run inside the package tree before publishing:

```bash
lib/scripts/package-validate.sh .
lib/nova-release.py validate --path .
lib/nova-acceptance.py --path . --json
```

Required invariants:

- no CRLF, `__pycache__`, or `.pyc` files;
- all Bash and Python syntax valid;
- Telegram bot has no `create_subprocess_shell` and no `shell=True`;
- `/exec` disabled by default and production allowlist remains narrow;
- privileged operations pass through `nova-admin.py`;
- manifest and release validation are current.

## Runtime gate

Run after installation, after `/etc/nova/nova.env` is configured:

```bash
sudo /usr/local/lib/nova/nova-admin.py certify --json
```

For a stronger live test that also creates a real backup:

```bash
sudo /usr/local/lib/nova/nova-admin.py certify --json --include-backup
```

The runtime certification checks:

- config validation;
- health snapshot write;
- production system snapshot;
- update status readability;
- backup list or backup creation;
- systemd unit/timer status;
- installed tool executability;
- systemd unit verification where available.

## Production operating rules

- Keep `NOVA_ENABLE_EXEC=0`.
- Keep `NOVA_UPDATE_STRATEGY=ff-only` unless a human intentionally chooses a reset strategy.
- Keep owner/operator/viewer IDs explicit in `/etc/nova/nova.env`.
- Do not grant `NOPASSWD: ALL`.
- Use `/update apply`, not raw `git pull && systemctl restart`.
- Use `/certify` after major operational changes.
- Treat warnings from `doctor` as backlog items, not noise.

## Additional production gate: orchestration coherence

Before long-term production use, verify:

```bash
sudo /usr/local/lib/nova/nova-admin.py lease status
sudo /usr/local/lib/nova/nova-admin.py queue stats
sudo /usr/local/lib/nova/nova-admin.py dispatcher status
sudo /usr/local/lib/nova/nova-admin.py release-train status
sudo /usr/local/lib/nova/nova-admin.py emergency status
sudo /usr/local/lib/nova/nova-admin.py orchestrator status
```

A scheduled maintenance or self-update must defer while an `agent`, `release`, or `update` lease is active. Runtime certification now checks the orchestration tools and timers.


## Long-term stability hardening

Production readiness requires race-safe coordination. The queue and lease stores are lock-protected, stale claimed/running jobs can be reaped, and the orchestrator processes due deferred maintenance/update commands only through allowlisted executables. Self-update restarts the orchestration timers as well as the original bot/monitor/agent timers.


## Additional complete-edition gates

Before production approval, verify state integrity and orchestration idempotency:

```bash
sudo /usr/local/lib/nova/nova-admin.py state audit
sudo /usr/local/lib/nova/nova-admin.py orchestrator cycle --dispatch-limit 0
sudo /usr/local/lib/nova/nova-admin.py certify --json
```

`state audit` must report `ok: true`. If it does not, use `state repair` to quarantine invalid JSON, then re-run `doctor`, `acceptance`, and `certify`.
