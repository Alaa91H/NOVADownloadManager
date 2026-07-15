---
name: nova-self-maintenance
description: Comprehensive self-maintenance procedure for the NOVA platform ??? analyzes and repairs the bot, agent, tools, and infrastructure. Covers bug fixes, error handling, performance, security, and capability improvement.
license: MIT
compatibility: opencode
metadata:
  audience: maintainers
  workflow: daily-maintenance
---

## NOVA Platform Self-Maintenance

This skill defines the complete daily maintenance procedure for the NOVA platform. Follow it step by step.

### Phase 1: Analysis (Read-Only)

Audit these components in order. For each, read the code and identify issues:

#### 1.1 Telegram Bot (nova-bot.py)
- **Streaming infrastructure**: Check `stream_opencode()`, `handle_agent_message()`, `ACTIVE_SESSIONS`. Look for: race conditions, unclosed processes, memory leaks in session state, missing error handling.
- **Command handlers**: Check every `cmd_*` function. Look for: missing auth checks, unhandled exceptions, missing input validation, dead code.
- **Git workflow**: Check the commit/push logic in `handle_agent_message()`. Look for: double commits, missing stash pop, unhandled push failures.
- **Session management**: Check `ACTIVE_SESSIONS` cleanup. Look for: orphaned sessions, process leaks.
- **Error handling**: Check all try/except blocks. Look for: bare except, swallowed errors, missing user feedback on failure.
- **Permissions**: Check `role_required`, `has_role`, `@restricted`. Look for: missing checks, privilege escalation.
- **Formatting**: Check message formatting, markdown escaping. Look for: broken markdown, truncated messages, encoding issues.

#### 1.2 Development Controller (agent.sh)
- **Bot-only mode**: Check `main_loop()`. Look for: unnecessary work, incorrect state transitions.
- **Queue processing**: Check `process_telegram_queue()`. Look for: missing error handling, queue corruption.
- **State management**: Check `write_state()`, `.agent-state.json`. Look for: stale state, race conditions.
- **Git operations**: Check `sync_repo()`, `commit_and_push()`. Look for: unhandled failures, missing cleanup.

#### 1.3 System Infrastructure
- **systemd services**: Check all .service files. Look for: missing restart policies, incorrect dependencies, security settings.
- **Timers**: Check all .timer files. Look for: incorrect schedules, missing persistent flag.
- **Admin boundary**: Check nova-admin.py. Look for: command injection, missing validation, privilege escalation.
- **Watchdog**: Check nova-watchdog.py. Look for: false positives, missing recovery actions.

#### 1.4 opencode Configuration
- **opencode.json**: Check permissions, agent config, model settings.
- **Custom agents**: Check .opencode/agents/*.md files. Look for: incorrect permissions, missing fields.
- **Skills**: Check .opencode/skills/*/SKILL.md. Look for: outdated procedures, missing steps.

### Phase 2: Repair (Full Authority)

Fix issues found in Phase 1, in priority order:

#### Priority Order
1. **P0 ??? Critical**: Anything that causes crashes, data loss, security breaches, or service downtime.
2. **P1 ??? High**: Bugs that cause incorrect behavior, poor error handling, or missing safety checks.
3. **P2 ??? Medium**: Performance issues, code quality problems, missing features.
4. **P3 ??? Low**: Documentation, formatting, minor improvements.

#### Repair Rules
- Fix one issue at a time. Verify each fix before moving to the next.
- After editing nova-bot.py: `python3 -c 'import py_compile; py_compile.compile("nova-bot.py", doraise=True)'`
- After editing systemd services: `sudo systemctl daemon-reload`
- After editing the bot: `sudo systemctl restart nova-bot.service`
- After editing the agent: `sudo systemctl restart nova-dev-agent.service`
- Never break a working service. If a fix is risky, leave it and document the issue.
- Never run build/test/lint commands on this server.

#### Self-Improvement Actions
After fixing bugs, look for opportunities to improve:
- **Add error handling** where missing.
- **Improve error messages** to be more helpful for users.
- **Add new bot commands** that would be useful.
- **Optimize the streaming update frequency** for better UX.
- **Improve session cleanup** to prevent memory leaks.
- **Add health checks** for critical components.
- **Improve documentation** in AGENTS.md or CONSTITUTION.md.

### Phase 3: Verification

After all repairs:
1. Run `python3 -c 'import py_compile; py_compile.compile("nova-bot.py", doraise=True)'` ??? must pass.
2. Run `sudo systemctl is-active nova-bot.service nova-dev-agent.service` ??? both must be active.
3. Run `sudo journalctl -u nova-bot.service --since '5 min ago' --no-pager -n 20` ??? check for errors.
4. Read back any changed files to verify correctness.

### Phase 4: Report

Produce a summary report:
- **??????????????????**: List each fix with file:line and description.
- **??????????????????**: List each improvement.
- **?????????????? ????????????????**: List issues that were too risky to fix.
- **????????????????**: Suggestions for future work.
