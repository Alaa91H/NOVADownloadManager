from __future__ import annotations

import ast
import json
import pathlib
import re
import subprocess
import unittest
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]


class StaticPackageTests(unittest.TestCase):
    def test_no_crlf_pycache_or_pyc(self):
        for cache in ROOT.rglob("__pycache__"):
            shutil.rmtree(cache, ignore_errors=True)
        offenders = []
        for path in ROOT.rglob('*'):
            if '.git' in path.parts:
                continue
            if path.is_dir() and path.name == '__pycache__':
                offenders.append(str(path.relative_to(ROOT)))
            if path.is_file() and path.suffix == '.pyc':
                offenders.append(str(path.relative_to(ROOT)))
            if path.is_file() and path.stat().st_size < 2_000_000:
                data = path.read_bytes()
                if b'\r\n' in data or b'\r' in data:
                    offenders.append(str(path.relative_to(ROOT)))
        self.assertEqual([], offenders)

    def test_bash_and_python_syntax(self):
        errors = []
        for path in ROOT.rglob('*.sh'):
            cp = subprocess.run(['bash', '-n', str(path)], capture_output=True, text=True)
            if cp.returncode:
                errors.append(f'{path.relative_to(ROOT)}: {cp.stderr.strip()}')
        for path in ROOT.rglob('*.py'):
            try:
                ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
            except Exception as exc:
                errors.append(f'{path.relative_to(ROOT)}: {exc}')
        self.assertEqual([], errors)

    def test_env_example_security_defaults(self):
        text = (ROOT / 'config/nova.env.example').read_text(encoding='utf-8')
        self.assertIn('NOVA_ENABLE_EXEC=0', text)
        self.assertIsNotNone(re.search(r'^NOVA_OWNER_IDS=', text, re.M))
        self.assertIn('NOVA_SELF_UPDATE_ENABLED=1', text)
        self.assertIn('NOVA_UPDATE_STRATEGY=ff-only', text)
        self.assertIn('NOVA_AGENT_DISPATCH_MODE=github-actions', text)
        self.assertIn('NOVA_GITHUB_WORKER_AUTO_PROVISION=1', text)

    def test_admin_boundary_and_bot_audit_context(self):
        admin = (ROOT / 'lib/nova-admin.py').read_text(encoding='utf-8')
        bot = (ROOT / 'repo-overlay/nova-bot.py').read_text(encoding='utf-8')
        install = (ROOT / 'install.sh').read_text(encoding='utf-8')
        self.assertIn('NOVA privileged admin boundary', admin)
        self.assertIn('--actor', admin)
        self.assertIn('--correlation-id', admin)
        self.assertIn('CURRENT_ACTOR', bot)
        self.assertIn('CURRENT_CORRELATION_ID', bot)
        self.assertIn('/usr/local/lib/nova/nova-admin.py *', install)
        self.assertNotIn('NOPASSWD: ALL', install)

    def test_telegram_bot_has_no_shell_subprocess_surface(self):
        bot = (ROOT / 'repo-overlay/nova-bot.py').read_text(encoding='utf-8')
        self.assertNotIn('create_subprocess_shell', bot)
        self.assertNotIn('shell=True', bot)
        self.assertIn('admin_json(["system", "--format", "json"]', bot)

    def test_autonomous_orchestration_surface(self):
        admin = (ROOT / 'lib/nova-admin.py').read_text(encoding='utf-8')
        bot = (ROOT / 'repo-overlay/nova-bot.py').read_text(encoding='utf-8')
        agent = (ROOT / 'lib/agent.sh').read_text(encoding='utf-8')
        maintenance = (ROOT / 'lib/scripts/maintenance.sh').read_text(encoding='utf-8')
        self.assertIn('nova-lease.py', admin)
        self.assertIn('nova-job-queue.py', admin)
        self.assertIn('nova-github-actions-worker.py', admin)
        self.assertIn('nova-branch-policy.py', admin)
        self.assertIn('github-worker', admin)
        self.assertIn('branch-policy', admin)
        self.assertIn('release-train', admin)
        self.assertIn('CommandHandler("queue", cmd_queue)', bot)
        self.assertIn('CommandHandler("train", cmd_train)', bot)
        self.assertIn('acquire_task_lease', agent)
        self.assertIn('should-defer maintenance', maintenance)
        self.assertTrue((ROOT / 'systemd/nova-orchestrator.timer').exists())

    def test_orchestration_is_race_safe_and_deferred_work_runs(self):
        lease = (ROOT / 'lib/nova-lease.py').read_text(encoding='utf-8')
        queue = (ROOT / 'lib/nova-job-queue.py').read_text(encoding='utf-8')
        dispatcher = (ROOT / 'lib/nova-dispatcher.py').read_text(encoding='utf-8')
        orchestrator = (ROOT / 'lib/nova-orchestrator.py').read_text(encoding='utf-8')
        updater = (ROOT / 'lib/nova-updater.py').read_text(encoding='utf-8')
        self.assertIn('fcntl.flock', lease)
        self.assertIn('fcntl.flock', queue)
        self.assertIn('reap_stale', queue)
        self.assertIn('run_due_deferred', orchestrator)
        self.assertIn('remove-deferred', orchestrator)
        self.assertIn('record-deferred-attempt', lease)
        self.assertIn('acquire_cycle_lease', orchestrator)
        self.assertIn('nova-state.py', orchestrator)
        self.assertIn('backend_configured', dispatcher)
        self.assertIn('github_actions_dispatch', dispatcher)
        self.assertIn('shlex.split', dispatcher)
        self.assertIn('nova-orchestrator.timer', updater)
        self.assertIn('nova-state.py', updater)


    def test_github_actions_worker_autoprovisions_workflow(self):
        worker = (ROOT / 'lib/nova-github-actions-worker.py').read_text(encoding='utf-8')
        dispatcher = (ROOT / 'lib/nova-dispatcher.py').read_text(encoding='utf-8')
        self.assertIn('ensure_workflow', worker)
        self.assertIn('render_workflow', worker)
        self.assertIn('workflow_dispatch', worker)
        self.assertIn('"workflow", "run"', worker)
        self.assertIn('NOVA_GITHUB_WORKER_PROVISION_MODE', worker)
        self.assertIn('github-actions', dispatcher)
        self.assertIn('RETRYABLE_EXIT_CODES', dispatcher)



    def test_branch_policy_adoption_surface(self):
        env = (ROOT / 'config/nova.env.example').read_text(encoding='utf-8')
        admin = (ROOT / 'lib/nova-admin.py').read_text(encoding='utf-8')
        worker = (ROOT / 'lib/nova-github-actions-worker.py').read_text(encoding='utf-8')
        agent = (ROOT / 'lib/agent.sh').read_text(encoding='utf-8')
        self.assertTrue((ROOT / 'lib/nova-branch-policy.py').exists())
        self.assertIn('NOVA_STABLE_BRANCH=main', env)
        self.assertIn('NOVA_DEVELOP_BRANCH=develop', env)
        self.assertIn('NOVA_BRANCH_POLICY_ALLOW_DIRECT_MAIN=0', env)
        self.assertIn('NOVA_BRANCH_POLICY_ALLOW_DIRECT_DEVELOP=0', env)
        self.assertIn('branch-policy', admin)
        self.assertIn('guard-push', admin)
        self.assertIn('branch_policy', worker)
        self.assertIn('safe_target_branch', worker)
        self.assertIn('prepare_policy_branch_if_needed', agent)
        self.assertIn('open_policy_pr_if_needed', agent)

    def test_manifest_inventory_if_present(self):
        mf = ROOT / 'FACTORY_MANIFEST.json'
        self.assertTrue(mf.exists())
        data = json.loads(mf.read_text(encoding='utf-8'))
        self.assertEqual('nova-factory', data.get('name'))
        paths = {entry['path'] for entry in data.get('files', []) if isinstance(entry, dict) and 'path' in entry}
        required = {
            'lib/nova-release.py',
            'lib/nova-ci.py',
            'lib/nova-acceptance.py',
            'lib/nova-system.py',
            'lib/nova-runtime-certify.py',
            'lib/nova-lease.py',
            'lib/nova-job-queue.py',
            'lib/nova-dispatcher.py',
            'lib/nova-github-actions-worker.py',
            'lib/nova-branch-policy.py',
            'lib/nova-release-train.py',
            'lib/nova-emergency.py',
            'lib/nova-roadmap.py',
            'lib/nova-orchestrator.py',
            'lib/nova-state.py',
            'repo-overlay/nova-bot.py',
            'systemd/nova-bot.service',
        }
        self.assertTrue(required.issubset(paths), required - paths)


if __name__ == '__main__':
    unittest.main()
