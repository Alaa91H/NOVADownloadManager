import { readJsonFile, assert } from './checks-common.js';

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const forbiddenRanges = new Set(['latest', '*', 'x', 'X']);
const blockedPackages = new Set([
  // Known compromised historical versions; keep this list small and explicit.
  'eslint-config-prettier@10.1.6',
  'eslint-config-prettier@10.1.7',
  'eslint-config-prettier@9.1.1',
  'eslint-config-prettier@8.10.1',
]);

const packageJson = await readJsonFile<PackageJson>('package.json');
const groups = {
  dependencies: packageJson.dependencies ?? {},
  devDependencies: packageJson.devDependencies ?? {},
  optionalDependencies: packageJson.optionalDependencies ?? {},
};

for (const [groupName, group] of Object.entries(groups)) {
  for (const [name, range] of Object.entries(group)) {
    assert(!forbiddenRanges.has(range.trim()), `${groupName}.${name} must not use the floating '${range}' range.`);
    assert(!range.includes('latest'), `${groupName}.${name} must not include a latest dist-tag.`);
    assert(!/^github:|^git\+|^https?:/i.test(range), `${groupName}.${name} must resolve from the npm registry, not remote code.`);
    const exact = range.replace(/^[~^]/, '');
    assert(!blockedPackages.has(`${name}@${exact}`), `${name}@${exact} is blocked by dependency policy.`);
  }
}

console.log('Dependency policy check passed: no floating latest ranges or blocked packages.');
