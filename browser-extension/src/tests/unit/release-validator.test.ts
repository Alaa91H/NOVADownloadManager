import { describe, expect, it } from 'vitest';
import { validateManifest, validateSourceCode, validateDiagnosticsOutput, runReleaseValidation } from '../../security/release-validator';

describe('validateManifest', () => {
  it('passes a store build with no wide permissions', () => {
    const manifest = { permissions: ['storage', 'activeTab'], manifest_version: 3 };
    const issues = validateManifest(manifest, true);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('fails a store build with <all_urls> as mandatory permission', () => {
    const manifest = { permissions: ['storage', '<all_urls>'] };
    const issues = validateManifest(manifest, true);
    expect(issues.some((i) => i.rule === 'no-mandatory-all-urls')).toBe(true);
  });

  it('fails a store build with wide host_permissions', () => {
    const manifest = { permissions: ['storage'], host_permissions: ['<all_urls>'] };
    const issues = validateManifest(manifest, true);
    expect(issues.some((i) => i.rule === 'no-wide-host-permissions')).toBe(true);
  });

  it('allows <all_urls> in non-store build', () => {
    const manifest = { permissions: ['storage', '<all_urls>'] };
    const issues = validateManifest(manifest, false);
    expect(issues.filter((i) => i.rule === 'no-mandatory-all-urls')).toHaveLength(0);
  });

  it('fails when CSP contains unsafe-eval', () => {
    const manifest = { permissions: ['storage'], content_security_policy: "script-src 'self' 'unsafe-eval'" };
    const issues = validateManifest(manifest, true);
    expect(issues.some((i) => i.rule === 'no-unsafe-eval-csp')).toBe(true);
  });

  it('fails when CSP contains unsafe-inline', () => {
    const manifest = { permissions: ['storage'], content_security_policy: "script-src 'self' 'unsafe-inline'" };
    const issues = validateManifest(manifest, true);
    expect(issues.some((i) => i.rule === 'no-unsafe-inline-csp')).toBe(true);
  });
});

describe('validateSourceCode', () => {
  it('passes clean code', () => {
    const code = 'function greet() { return "hello"; }';
    expect(validateSourceCode(code, 'greet.js')).toHaveLength(0);
  });

  it('detects eval()', () => {
    const code = 'const result = eval("2+2");';
    const issues = validateSourceCode(code, 'main.js');
    expect(issues.some((i) => i.rule === 'no-eval')).toBe(true);
  });

  it('detects new Function()', () => {
    const code = 'const fn = new Function("return 1");';
    const issues = validateSourceCode(code, 'main.js');
    expect(issues.some((i) => i.rule === 'no-function-constructor')).toBe(true);
  });

  it('detects dangerouslySetInnerHTML', () => {
    const code = 'return <div dangerouslySetInnerHTML={{ __html: html }} />;';
    const issues = validateSourceCode(code, 'Component.tsx');
    expect(issues.some((i) => i.rule === 'no-dangerous-inner-html')).toBe(true);
  });

  it('detects remote script URLs', () => {
    const code = '<script src="https://cdn.evil.com/malware.js"></script>';
    const issues = validateSourceCode(code, 'popup.html');
    expect(issues.some((i) => i.rule === 'no-remote-script')).toBe(true);
  });

  it('allows loopback script references', () => {
    const code = 'fetch("http://127.0.0.1:3199/v1/ping")';
    const issues = validateSourceCode(code, 'transport.js');
    expect(issues.some((i) => i.rule === 'no-remote-script')).toBe(false);
  });
});

describe('validateDiagnosticsOutput', () => {
  it('passes clean diagnostics with redacted secrets', () => {
    const diag = { status: 'connected', pairToken: '[REDACTED]', version: '1.0.0' };
    expect(validateDiagnosticsOutput(diag)).toHaveLength(0);
  });

  it('fails when pairToken is not redacted', () => {
    const diag = { status: 'connected', pairToken: 'real-secret-token-xyz', version: '1.0.0' };
    const issues = validateDiagnosticsOutput(diag);
    expect(issues.some((i) => i.rule === 'no-secret-in-diagnostics')).toBe(true);
  });

  it('fails when Bearer token is present', () => {
    const diag = { headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' } };
    const issues = validateDiagnosticsOutput(diag);
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('runReleaseValidation', () => {
  it('passes a clean release', () => {
    const report = runReleaseValidation({
      manifest: { permissions: ['storage', 'activeTab'], manifest_version: 3 },
      isStoreBuild: true,
      sourceFiles: [{ filename: 'main.js', code: 'console.log("ok");' }],
      diagnosticsSample: { status: 'ok', pairToken: '[REDACTED]' },
    });
    expect(report.passed).toBe(true);
  });

  it('fails when any check fails', () => {
    const report = runReleaseValidation({
      manifest: { permissions: ['storage', '<all_urls>'] },
      isStoreBuild: true,
    });
    expect(report.passed).toBe(false);
  });
});
