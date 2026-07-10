# NOVA Factory Updating

Self-update is controlled by `nova-updater.py` through `nova-admin.py`.

## Recommended settings

```env
NOVA_SELF_UPDATE_ENABLED=1
NOVA_UPDATE_CHANNEL=stable
NOVA_UPDATE_STRATEGY=ff-only
NOVA_FACTORY_SOURCE_DIR=ops/nova-factory
NOVA_UPDATE_BACKUP_KEEP=8
```

`ff-only` is the safest default. Use `reset` only when you explicitly accept discarding local changes.

## Manual update

```bash
sudo /usr/local/lib/nova/nova-admin.py update check
sudo /usr/local/lib/nova/nova-admin.py update apply
sudo /usr/local/lib/nova/nova-admin.py update status
```

## Timer update

```bash
systemctl list-timers nova-self-update.timer
journalctl -u nova-self-update.service -n 100 --no-pager
```

## Source of factory updates

For true self-updates, place this package in the managed repo at:

```text
ops/nova-factory
```

If absent, the updater uses `/usr/local/lib/nova/factory-source` as recovery fallback and cannot receive new factory files from the repo.
