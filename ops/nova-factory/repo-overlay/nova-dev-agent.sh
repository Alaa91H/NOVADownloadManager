#!/usr/bin/env bash
# ============================================================
#  NOVA Agent — Repo Wrapper
#  This file calls the real agent at /usr/local/lib/nova/agent.sh
#  The real agent, constitution, and state files live on server.
#  Only Plan.md stays in repo.
# ============================================================
exec /usr/local/lib/nova/agent.sh "$@"
