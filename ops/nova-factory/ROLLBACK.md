# NOVA Factory Rollback

Rollback is designed for failed factory updates or unsafe operational changes.

## Update rollback

```bash
sudo /usr/local/lib/nova/nova-admin.py update rollback
```

This restores the latest update backup recorded by `nova-updater.py`.

## Backup restore

```bash
sudo /usr/local/lib/nova/nova-admin.py backup list
sudo /usr/local/lib/nova/nova-admin.py backup restore /var/backups/nova/<backup>.tar.gz
sudo systemctl restart nova-bot nova-dev-agent nova-monitor
```

## Emergency checks after rollback

```bash
sudo /usr/local/lib/nova/nova-admin.py config validate
sudo /usr/local/lib/nova/nova-admin.py doctor
systemctl status nova-bot nova-dev-agent nova-monitor --no-pager
```

Backups may contain secrets. Do not upload them to public systems.
