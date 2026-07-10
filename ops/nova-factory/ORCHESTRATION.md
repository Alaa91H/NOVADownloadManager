# NOVA Autonomous Production Orchestration

This edition adds a real coordination layer so NOVA can operate as a long-lived production control plane instead of a set of independent timers.

## Control-plane model

The server remains the coordination center. Heavy analysis, repair, and feature work should be dispatched to an external worker or cloud-backed agent. The server owns state, policy, release trains, audit, and emergency response.

Core tools:

- `nova-lease.py`: global leases and inhibitors. Scheduled maintenance and self-update defer while critical agent/release/update work is active.
- `nova-job-queue.py`: durable JSON-file job queue under `/var/lib/nova/jobs`.
- `nova-dispatcher.py`: dispatches queued jobs to a configured remote command/webhook or leaves them queued for an external worker.
- `nova-release-train.py`: alpha, beta, and stable channel planning and promotion.
- `nova-emergency.py`: service recovery and optional reboot policy with cooldown and boot-loop protection.
- `nova-roadmap.py`: evidence-based idea discovery and scoring.
- `nova-orchestrator.py`: coordination cycle for leases, health, dispatch, release train, and emergency status.

## Leases and deferral

The development agent publishes an `agent` lease while an opencode task is active. Maintenance and scheduled self-update call `should-defer` before running. Deferred operations are recorded in `/var/lib/nova/deferred` instead of being lost.

Manual owner actions can still be executed through `nova-admin.py`, but scheduled background tasks should never interrupt active critical work.

## Job queue and remote work

Default mode:

```bash
NOVA_AGENT_DISPATCH_MODE=remote-or-queue
NOVA_ALLOW_LOCAL_AGENT_DISPATCH=0
```

With no remote worker configured, jobs remain queued. This is deliberate: the weak server should not become a build/test machine.

To connect a worker, set one of:

```bash
NOVA_REMOTE_AGENT_COMMAND=/usr/local/bin/nova-remote-worker
NOVA_AGENT_WEBHOOK_URL=https://worker.example.internal/nova/jobs
```

The worker receives a job JSON document and performs the heavy work elsewhere. GitHub Actions remains the authoritative build/test gate.

## Release train

Channels:

- `alpha`: cut from develop when static gates pass.
- `beta`: promoted from alpha after CI is green and no P0/P1 blockers remain.
- `stable`: promoted from beta after release gates and soak criteria.

Commands:

```bash
sudo /usr/local/lib/nova/nova-admin.py release-train status
sudo /usr/local/lib/nova/nova-admin.py release-train cut alpha 1.2.3
sudo /usr/local/lib/nova/nova-admin.py release-train promote beta 1.2.3
sudo /usr/local/lib/nova/nova-admin.py release-train promote stable 1.2.3
sudo /usr/local/lib/nova/nova-admin.py release-train freeze --reason "release incident"
```

## Emergency policy

`nova-emergency.py` restarts unhealthy NOVA services and can optionally request server reboot, but reboot is disabled by default:

```bash
NOVA_EMERGENCY_REBOOT_ENABLED=0
```

Enable reboot only after provider-level recovery and backups are tested. Reboot is protected by failure threshold, cooldown, and boot-loop guards.

## Telegram commands

- `/queue list|stats|next|show|cancel`
- `/lease status|due|clean|release`
- `/dispatcher status|dispatch-one|dispatch-loop`
- `/train status|cut|promote|rollback|freeze|unfreeze`
- `/emergency status|check|restart-unhealthy`
- `/roadmap ideas|enqueue`
- `/orchestrator status|cycle`

All privileged commands still pass through `nova-admin.py` with actor and correlation ID audit.


## Production hardening notes

The orchestration kernel now executes due deferred operations through an explicit allowlist instead of merely listing them. Deferred commands are coalesced while a critical lease is active, then executed after the blocking lease clears. Queue and lease state use filesystem locks to prevent races between systemd timers, Telegram commands, and remote workers. The dispatcher no longer consumes queue attempts when no backend is configured; jobs remain queued for an external worker to claim.


## State integrity and quarantine

Long-running installations may be interrupted by disk-full events, abrupt reboot, or partial writes. `nova-state.py` audits runtime JSON state and quarantines unreadable files instead of deleting evidence.

Commands:

```bash
sudo /usr/local/lib/nova/nova-admin.py state summary
sudo /usr/local/lib/nova/nova-admin.py state audit
sudo /usr/local/lib/nova/nova-admin.py state repair
```

Corrupt state is moved to `/var/lib/nova/quarantine` by default. The orchestration cycle runs a state audit every pass, and runtime certification includes `state-audit` as a required check.

Deferred work now records attempts, return codes, last error, and exponential retry delay. Failed deferred commands stop after `NOVA_DEFERRED_MAX_ATTEMPTS` instead of retrying forever. The orchestrator itself publishes an `orchestrator` lease, preventing overlapping coordination cycles.
