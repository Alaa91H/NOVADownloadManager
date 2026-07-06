import { readFile } from 'node:fs/promises';
import { assert } from './checks-common.js';

type RequiredAction = {
  id: string;
  expected: string;
  locations: string[];
};

const requiredActions: RequiredAction[] = [
  {
    id: 'actions/checkout',
    expected: 'actions/checkout@v6.0.3',
    locations: ['../docs/extension/ci-templates/legacy-extension-ci.yml'],
  },
  {
    id: 'actions/upload-artifact',
    expected: 'actions/upload-artifact@v7.0.1',
    locations: ['../docs/extension/ci-templates/legacy-extension-ci.yml'],
  },
  {
    id: 'actions/download-artifact',
    expected: 'actions/download-artifact@v8.0.1',
    locations: ['../docs/extension/ci-templates/legacy-extension-ci.yml'],
  },
  {
    id: 'softprops/action-gh-release',
    expected: 'softprops/action-gh-release@v3.0.0',
    locations: ['../docs/extension/ci-templates/legacy-extension-ci.yml'],
  },
  {
    id: 'pnpm/action-setup',
    expected: 'pnpm/action-setup@v6.0.9',
    locations: ['../docs/extension/ci-templates/setup-extension-ci-action.yml'],
  },
  {
    id: 'Swatinem/rust-cache',
    expected: 'Swatinem/rust-cache@v2.9.1',
    locations: ['../docs/extension/ci-templates/setup-extension-ci-action.yml'],
  },
  {
    id: 'actions/setup-node',
    expected: 'actions/setup-node@v5',
    locations: ['../docs/extension/ci-templates/setup-extension-ci-action.yml'],
  },
];

const checkedFiles = Array.from(new Set(requiredActions.flatMap((action) => action.locations)));
const fileText = new Map<string, string>();
for (const file of checkedFiles) fileText.set(file, await readFile(file, 'utf8'));

const violations: string[] = [];

for (const action of requiredActions) {
  for (const location of action.locations) {
    const text = fileText.get(location) ?? '';
    if (!text.includes(action.expected)) {
      violations.push(`${location}: expected ${action.expected}.`);
    }

    const escaped = action.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usesPattern = new RegExp(`${escaped}@([^\\s#]+)`, 'g');
    let match: RegExpExecArray | null;
    while ((match = usesPattern.exec(text))) {
      const actual = `${action.id}@${match[1]}`;
      if (actual !== action.expected) {
        violations.push(`${location}: ${actual} must be pinned to ${action.expected}.`);
      }
    }
  }
}

const workflow = fileText.get('../docs/extension/ci-templates/legacy-extension-ci.yml') ?? '';
assert(workflow.includes('contents: write'), 'release job must keep explicit contents: write permission.');
assert(workflow.includes('NODE_OPTIONS: --no-deprecation'), 'workflow must suppress third-party runner deprecation noise.');
assert(workflow.includes('git config --global init.defaultBranch main'), 'workflow must configure Git default branch before checkout.');
assert(workflow.includes('overwrite_files: true'), 'softprops release step must explicitly overwrite release assets.');
assert(workflow.includes('fail_on_unmatched_files: true'), 'softprops release step must fail if release assets are missing.');
assert(!workflow.includes('telegram-build-success:'), 'workflow must not send Telegram notifications for ordinary build success.');
assert(workflow.includes('telegram-release:'), 'workflow must include Telegram tag release notification job.');
assert(workflow.includes('needs: [release, package-build]'), 'Telegram release notification must wait for release and package metadata.');
assert(workflow.includes("needs.release.result == 'success'"), 'Telegram release notification must run only after successful release publication.');
assert(workflow.includes("github.event_name == 'push'"), 'Telegram notification must be limited to pushed tag releases, not normal builds or manual dry-runs.');
assert(workflow.includes("github.ref_type == 'tag'"), 'Telegram notification must require a tag ref.');
assert(workflow.includes("startsWith(github.ref_name, 'v')"), 'Telegram notification must require v-prefixed release tags.');
assert(workflow.includes('python3 scripts/telegram-release-notify.py'), 'Telegram notification must use the checked-in Python script.');
assert(workflow.includes('node tools/prepare-release-notes.mjs'), 'release workflow must generate professional notes with downloads and changelog.');
assert(workflow.includes('body_path: ${{ steps.notes.outputs.body_path }}'), 'release body must come from generated notes.');
assert(workflow.includes('Build Chrome Edge Firefox packages once and run release gates'), 'release workflow must build browser packages once.');
assert(workflow.includes('Run Playwright smoke tests against the existing Chromium build'), 'E2E must reuse package-build artifacts instead of rebuilding.');

assert(workflow.includes('continue-on-error: true'), 'workflow must collect diagnosable gate failures instead of failing on the first check.');
assert(workflow.includes('Summarize quality gates without failing early'), 'quality gates must summarize failures instead of stopping at the first failed command.');
assert(workflow.includes('Summarize package and release gates without failing early'), 'package gates must summarize failures instead of stopping at the first failed command.');
assert(workflow.includes('Pipeline failed after collecting all available gates'), 'pipeline-result must be the authoritative final failure gate.');
assert(workflow.includes("row.outputs.failed === 'true'"), 'pipeline-result must fail on collected gate-output failures.');
assert(!workflow.includes('publish-release:'), 'release job id must remain release so dependent notification jobs are valid.');

const setupAction = fileText.get('../docs/extension/ci-templates/setup-extension-ci-action.yml') ?? '';
assert(setupAction.includes('version: 11.6.0'), 'pnpm action must install the project pnpm version directly.');
assert(!setupAction.includes('standalone:'), 'pnpm action must not use standalone mode because it reintroduces pnpm v10 layout noise.');

assert(violations.length === 0, `GitHub Actions policy failed:\n${violations.join('\n')}`);
console.log('GitHub Actions policy passed: official action versions are pinned and release gates are explicit.');
