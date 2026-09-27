import { readFileSync } from 'node:fs';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function requireContains(path: string, needle: string): void {
  const content = read(path);
  if (!content.includes(needle)) {
    throw new Error(`${path} must contain ${needle}`);
  }
}

requireContains('src/profiles/aggressive-permission-enforcer.ts', 'browser.permissions.onRemoved.addListener');
requireContains('src/profiles/aggressive-permission-enforcer.ts', 'disableAggressiveCapture(settings)');
requireContains('src/background/main.ts', 'registerAggressivePermissionRevocationWatcher()');
requireContains('src/background/main.ts', "enforceAggressivePermissions('background.boot')");
requireContains('src/background/lifecycle.ts', "enforceAggressivePermissions('lifecycle.auto-connect')");
requireContains('src/background/message-router.ts', "enforceAggressivePermissions('runtime.GET_SETTINGS')");
requireContains('src/background/message-router.ts', 'permissionIntegrity: aggressiveIntegrity');
console.log('Aggressive permission policy check passed.');
