# Runtime Certification Runbook

`nova-runtime-certify.py` is the live production gate. It complements package validation; it cannot be fully proven inside an extracted archive because it needs systemd, installed sudoers, real paths, timers, and the configured environment.

## Recommended sequence on a clean VM

```bash
tar xzf nova-factory-enterprise-production.tar.gz
cd nova-factory
sudo TARGET_USER=ubuntu PROJECT_DIR=/home/ubuntu/NOVA ./install.sh
sudo nano /etc/nova/nova.env
sudo /usr/local/lib/nova/nova-admin.py config validate
sudo systemctl start nova-monitor nova-bot nova-dev-agent
sudo systemctl start nova-watchdog.timer nova-maintenance.timer nova-daily-digest.timer nova-api-health.timer nova-self-update.timer
sudo /usr/local/lib/nova/nova-admin.py certify --json
```

## Expected result

The final JSON should contain:

```json
{
  "ok": true,
  "status": "production-runtime-certified"
}
```

If certification fails, do not call the installation production-ready. Use:

```bash
sudo /usr/local/lib/nova/nova-admin.py doctor --json
sudo journalctl -u nova-bot -u nova-monitor -u nova-dev-agent --no-pager -n 200
sudo /usr/local/lib/nova/nova-admin.py logs audit 200
```

## Re-certification cadence

Run certification after:

- first installation;
- system package upgrades;
- changes to `/etc/nova/nova.env`;
- self-update changes;
- rollback;
- systemd unit changes;
- Telegram bot permission changes.
