# NOVA Factory Operations

## Daily checks

```bash
sudo /usr/local/lib/nova/nova-admin.py health --write
sudo /usr/local/lib/nova/nova-admin.py doctor
systemctl list-timers 'nova-*'
systemctl status nova-bot nova-dev-agent nova-monitor --no-pager
```

## Telegram commands

```text
/status or /server          current server state
/health                     health snapshot
/doctor                     diagnostics
/config validate|safe|diff  configuration checks
/backup list|inspect        backup inventory
/backup create              owner-only backup
/update status|check        update state
/update apply|rollback      owner-only lifecycle actions
/svc                        list NOVA units
/svc <unit> <action>        allowlisted service actions
```

## Logs

```bash
sudo /usr/local/lib/nova/nova-admin.py logs telegram 100
sudo /usr/local/lib/nova/nova-admin.py logs updater 100
sudo /usr/local/lib/nova/nova-admin.py logs audit 100
journalctl -u nova-bot -n 100 --no-pager
journalctl -u nova-self-update.service -n 100 --no-pager
```

## Configuration

After editing `/etc/nova/nova.env`:

```bash
sudo chmod 600 /etc/nova/nova.env
sudo /usr/local/lib/nova/nova-admin.py config validate
sudo systemctl restart nova-bot nova-dev-agent nova-monitor
```

## Backup and restore

```bash
sudo /usr/local/lib/nova/nova-admin.py backup create before-change
sudo /usr/local/lib/nova/nova-admin.py backup list
sudo /usr/local/lib/nova/nova-admin.py backup inspect /var/backups/nova/<file>.tar.gz
sudo /usr/local/lib/nova/nova-admin.py backup restore /var/backups/nova/<file>.tar.gz
```

Restoring a backup reloads systemd units. Restart relevant services afterward.
