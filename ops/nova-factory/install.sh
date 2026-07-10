#!/usr/bin/env bash
# ============================================================================
# NOVA factory installer — deploy the continuous-development factory onto a
# fresh Ubuntu server. Idempotent: safe to re-run.
#
# Usage:
#   sudo TARGET_USER=ubuntu PROJECT_DIR=/home/ubuntu/NOVA ./install.sh
#
# Prerequisites (install these first — see README.md):
#   node (20+), python3 (3.11+), git, gh, opencode, and a Telegram bot token.
# ============================================================================
set -euo pipefail

TARGET_USER="${TARGET_USER:-${SUDO_USER:-ubuntu}}"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_HOME="${TARGET_HOME:-/home/$TARGET_USER}"
PROJECT_DIR="${PROJECT_DIR:-$TARGET_HOME/NOVA}"
LIB_DIR=/usr/local/lib/nova
ENV_FILE=/etc/nova/nova.env
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $EUID -ne 0 ]]; then echo "Run with sudo." >&2; exit 1; fi
echo ">> Installing NOVA factory for user '$TARGET_USER' (project: $PROJECT_DIR)"

# --- 1. Directories ----------------------------------------------------------
install -d -o "$TARGET_USER" -g "$TARGET_USER" /var/lib/nova /var/lib/nova/jobs /var/lib/nova/leases /var/lib/nova/deferred /var/log/nova /var/cache/nova/releases "$LIB_DIR/scripts" "$LIB_DIR/blocked-bin"
install -d -m 0700 -o root -g root /var/backups/nova
install -d /etc/nova

# --- 2. Controller library ---------------------------------------------------
cp "$HERE/lib/agent.sh" "$HERE/lib/monitor.sh" "$HERE/lib/controller-guard.sh" \
   "$HERE/lib/daily-digest.py" "$HERE/lib/nova-admin.py" "$HERE/lib/nova-updater.py" \
   "$HERE/lib/nova-config.py" "$HERE/lib/nova-backup.py" "$HERE/lib/nova-health.py" \
   "$HERE/lib/nova-release.py" "$HERE/lib/nova-ci.py" "$HERE/lib/nova-acceptance.py" \
   "$HERE/lib/nova-system.py" "$HERE/lib/nova-runtime-certify.py" \
   "$HERE/lib/nova-lease.py" "$HERE/lib/nova-job-queue.py" "$HERE/lib/nova-dispatcher.py" \
   "$HERE/lib/nova-github-actions-worker.py" "$HERE/lib/nova-branch-policy.py" \
   "$HERE/lib/nova-release-train.py" "$HERE/lib/nova-emergency.py" "$HERE/lib/nova-roadmap.py" \
   "$HERE/lib/nova-orchestrator.py" "$HERE/lib/nova-state.py" "$LIB_DIR/"
cp "$HERE"/lib/scripts/*.sh "$LIB_DIR/scripts/" 2>/dev/null || true
cp "$HERE/lib/blocked-bin/block-command" "$LIB_DIR/blocked-bin/"
chmod 755 "$LIB_DIR"/*.sh "$LIB_DIR"/*.py "$LIB_DIR"/scripts/*.sh "$LIB_DIR/blocked-bin/block-command"
# Recreate command-block symlinks (keep heavy tools off this node)
for c in cargo eslint npm npx playwright pnpm tauri tsc vite vitest yarn; do
  ln -sf "$LIB_DIR/blocked-bin/block-command" "$LIB_DIR/blocked-bin/$c"
done
# Keep a root-owned copy of the factory package. The self-updater uses this as
# a local recovery source and as the fallback factory source when the project repo
# does not yet contain ops/nova-factory.
rm -rf "$LIB_DIR/factory-source"
install -d -m 0755 "$LIB_DIR/factory-source"
( cd "$HERE" && tar --exclude='__pycache__' --exclude='*.pyc' --exclude='.git' -cf - . ) | ( cd "$LIB_DIR/factory-source" && tar -xf - )
chown -R root:root "$LIB_DIR/factory-source"
chmod -R go-w "$LIB_DIR/factory-source"
echo ">> Controller library installed to $LIB_DIR"

# --- 3. Config template ------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$HERE/config/nova.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo ">> Wrote $ENV_FILE — EDIT IT and add real values before starting services."
  NEED_ENV=1
else
  echo ">> $ENV_FILE already exists; left unchanged."
fi

# --- 4. Repository + server-only overlay -------------------------------------
# shellcheck disable=SC1090
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE" || true
if [[ -z "${NOVA_OWNER_IDS:-}" ]]; then
  echo "!! NOVA_OWNER_IDS is empty. /register will remain disabled until you set it."
fi
REPO_URL="${REPO_URL:-https://github.com/${NOVA_GH_REPO:-Alaa91H/NOVADownloadManager}.git}"
BRANCH="${NOVA_BRANCH:-${NOVA_DEVELOP_BRANCH:-develop}}"
if [[ ! -d "$PROJECT_DIR/.git" ]]; then
  echo ">> Cloning $REPO_URL -> $PROJECT_DIR"
  sudo -u "$TARGET_USER" git clone "$REPO_URL" "$PROJECT_DIR" || echo "!! clone failed — clone manually, then re-run."
  sudo -u "$TARGET_USER" git -C "$PROJECT_DIR" checkout "$BRANCH" 2>/dev/null || sudo -u "$TARGET_USER" git -C "$PROJECT_DIR" checkout "${NOVA_LEGACY_DEVELOP_BRANCH:-Dev}" 2>/dev/null || true
fi
if [[ -d "$PROJECT_DIR/.git" ]]; then
  cp "$HERE"/repo-overlay/* "$PROJECT_DIR/"
  chown "$TARGET_USER:$TARGET_USER" "$PROJECT_DIR"/nova-*.py "$PROJECT_DIR"/nova-*.sh "$PROJECT_DIR"/AGENTS.md "$PROJECT_DIR"/CONSTITUTION.md 2>/dev/null || true
  chmod +x "$PROJECT_DIR/nova-dev-agent.sh" 2>/dev/null || true
  # Guardian git hooks (local, never tracked)
  install -d "$PROJECT_DIR/.git/hooks"
  cp "$HERE"/git-hooks/pre-commit "$HERE"/git-hooks/commit-msg "$HERE"/git-hooks/pre-push "$PROJECT_DIR/.git/hooks/"
  chmod +x "$PROJECT_DIR/.git/hooks/pre-commit" "$PROJECT_DIR/.git/hooks/commit-msg" "$PROJECT_DIR/.git/hooks/pre-push"
  chown -R "$TARGET_USER:$TARGET_USER" "$PROJECT_DIR/.git/hooks"
  echo ">> Server-only overlay + guardian hooks installed into $PROJECT_DIR"
fi

# --- 5. systemd units --------------------------------------------------------
tmp="$(mktemp -d)"
cp "$HERE"/systemd/*.service "$HERE"/systemd/*.timer "$tmp/"
# Retarget user/home/project if different from the packaged defaults.
sed -i \
  -e "s#/home/ubuntu/NOVA#$PROJECT_DIR#g" \
  -e "s#^User=ubuntu#User=$TARGET_USER#g" \
  -e "s#^Group=ubuntu#Group=$TARGET_USER#g" \
  -e "s#HOME=/home/ubuntu#HOME=$TARGET_HOME#g" \
  -e "s#/home/ubuntu/.opencode#$TARGET_HOME/.opencode#g" \
  -e "s#/home/ubuntu/backups#$TARGET_HOME/backups#g" \
  "$tmp"/*.service "$tmp"/*.timer 2>/dev/null || true
cp "$tmp"/*.service "$tmp"/*.timer /etc/systemd/system/
rm -rf "$tmp"
systemctl daemon-reload
echo ">> systemd units installed"

# --- 5b. Privileged admin boundary -------------------------------------------
SUDOERS_FILE=/etc/sudoers.d/nova-factory
cat > "$SUDOERS_FILE" <<EOF
Defaults:$TARGET_USER !requiretty
$TARGET_USER ALL=(root) NOPASSWD: /usr/local/lib/nova/nova-admin.py *
EOF
chmod 0440 "$SUDOERS_FILE"
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$SUDOERS_FILE" >/dev/null || { rm -f "$SUDOERS_FILE"; echo "Invalid sudoers file" >&2; exit 1; }
fi
echo ">> sudo boundary installed: $SUDOERS_FILE"

# --- 6. Python dependency ----------------------------------------------------
if ! sudo -u "$TARGET_USER" python3 -c "import telegram" 2>/dev/null; then
  echo ">> Installing python-telegram-bot for $TARGET_USER"
  sudo -u "$TARGET_USER" python3 -m pip install --user --quiet "python-telegram-bot>=22" || \
    echo "!! pip install failed — install python-telegram-bot manually."
fi

# --- 7. Enable services ------------------------------------------------------
systemctl enable nova-bot.service nova-dev-agent.service nova-monitor.service nova-watchdog.timer nova-maintenance.timer nova-daily-digest.timer nova-api-health.timer nova-self-update.timer nova-orchestrator.timer nova-dispatcher.timer nova-emergency.timer >/dev/null 2>&1 || true
echo
echo "============================================================"
echo " NOVA factory installed."
echo "------------------------------------------------------------"
[[ "${NEED_ENV:-0}" == "1" ]] && echo " 1) Edit $ENV_FILE (bot token, repo, model)."
echo " 2) Authenticate git push:  sudo -u $TARGET_USER gh auth login"
echo " 3) Ensure 'opencode' is installed and authenticated for $TARGET_USER."
echo " 4) Set NOVA_OWNER_IDS in $ENV_FILE. Use /myid in Telegram to get your numeric user ID."
echo " 5) Validate config: sudo /usr/local/lib/nova/nova-admin.py config validate"
echo " 6) Run doctor:     sudo /usr/local/lib/nova/nova-admin.py doctor"
echo " 6b) Acceptance:    sudo /usr/local/lib/nova/nova-admin.py acceptance --json"
echo " 6c) Runtime cert:  sudo /usr/local/lib/nova/nova-admin.py certify --json"
echo " 6d) Orchestrator: sudo /usr/local/lib/nova/nova-admin.py orchestrator status
 6e) State audit:  sudo /usr/local/lib/nova/nova-admin.py state audit
 6f) Branch policy: sudo /usr/local/lib/nova/nova-admin.py branch-policy status"
echo " 7) Start it:      sudo systemctl start nova-monitor nova-bot nova-dev-agent"
echo " 8) In Telegram, send /register from an owner account to register the chat."
echo " 9) Update manually: sudo /usr/local/lib/nova/nova-admin.py update apply"
echo "============================================================"
