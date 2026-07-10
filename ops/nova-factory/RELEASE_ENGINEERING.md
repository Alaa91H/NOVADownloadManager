# NOVA Release Engineering

The factory package is released through a deterministic release helper rather than ad-hoc tar commands.

Core commands:

```bash
./lib/nova-release.py validate --path .
./lib/nova-release.py manifest --path .
./lib/nova-release.py package --path . --output-dir ./dist
./lib/nova-release.py checksum --path ./dist/nova-factory-<version>.tar.gz
./lib/nova-acceptance.py --path . --json
```

Release invariants:

- no CRLF
- no `__pycache__`
- no `.pyc`
- valid Bash syntax
- valid Python syntax
- `/exec` disabled by default
- no unrestricted sudoers rule
- required operational tools present
- bot admin calls include actor and correlation id
- manifest regenerated before packaging

The packaged archive contains a single top-level directory: `nova-factory/`.
