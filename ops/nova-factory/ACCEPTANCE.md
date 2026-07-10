# NOVA Factory Acceptance Matrix

A release is acceptable only when the following pass:

- Bash syntax for every packaged shell script.
- Python syntax for every packaged Python module.
- Package validation with no CRLF, pycache, `.pyc`, or missing required files.
- Release validation through `nova-release.py validate`.
- Unit tests under `tests/`.
- Actor-correlated audit path from Telegram to `nova-admin.py`.
- Root operations reachable only through `/usr/local/lib/nova/nova-admin.py`.
- `/exec` disabled by default.
- Self-update has validation, backup, healthcheck, and rollback.

Run locally from the package root:

```bash
./lib/scripts/package-validate.sh .
./lib/nova-release.py validate --path .
./lib/nova-acceptance.py --path . --json
```
