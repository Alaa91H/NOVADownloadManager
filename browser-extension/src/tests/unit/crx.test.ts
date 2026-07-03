import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrx, extractZipFromCrx, resolveCrxPrivateKey } from '../../../tools/crx';

let privateKeyPem: string;
// A CRX3 packer treats the zip as opaque bytes, so any payload exercises the framing.
const fakeZip = Buffer.from('PK\x03\x04 this stands in for a real zip payload', 'latin1');

beforeAll(() => {
  privateKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
});

describe('createCrx', () => {
  it('produces a valid CRX3 envelope around the zip', () => {
    const crx = createCrx(fakeZip, privateKeyPem);
    expect(crx.subarray(0, 4).toString('latin1')).toBe('Cr24');
    expect(crx.readUInt32LE(4)).toBe(3); // CRX version
    const headerLength = crx.readUInt32LE(8);
    expect(headerLength).toBeGreaterThan(0);
    // The zip payload begins immediately after the 12-byte prefix + header.
    expect(crx.length).toBe(12 + headerLength + fakeZip.length);
  });

  it('round-trips: extractZipFromCrx recovers the original zip bytes', () => {
    const crx = createCrx(fakeZip, privateKeyPem);
    expect(extractZipFromCrx(crx).equals(fakeZip)).toBe(true);
  });

  it('is deterministic for the same key and input (PKCS#1 v1.5)', () => {
    expect(createCrx(fakeZip, privateKeyPem).equals(createCrx(fakeZip, privateKeyPem))).toBe(true);
  });

  it('produces different signatures for different payloads', () => {
    const a = createCrx(fakeZip, privateKeyPem);
    const b = createCrx(Buffer.concat([fakeZip, Buffer.from('x')]), privateKeyPem);
    expect(a.equals(b)).toBe(false);
  });
});

describe('extractZipFromCrx', () => {
  it('returns the input unchanged when it is not a crx', () => {
    expect(extractZipFromCrx(fakeZip).equals(fakeZip)).toBe(true);
  });
});

describe('resolveCrxPrivateKey', () => {
  const original = { ...process.env };

  afterEach(() => {
    delete process.env.CRX_PRIVATE_KEY;
    delete process.env.CRX_PRIVATE_KEY_PATH;
    Object.assign(process.env, original);
  });

  it('returns null when no signing key is configured', () => {
    delete process.env.CRX_PRIVATE_KEY;
    delete process.env.CRX_PRIVATE_KEY_PATH;
    expect(resolveCrxPrivateKey()).toBeNull();
  });

  it('reads an inline PEM from CRX_PRIVATE_KEY', () => {
    process.env.CRX_PRIVATE_KEY = privateKeyPem;
    expect(resolveCrxPrivateKey()).toContain('BEGIN');
  });

  it('decodes a base64-encoded PEM from CRX_PRIVATE_KEY', () => {
    process.env.CRX_PRIVATE_KEY = Buffer.from(privateKeyPem, 'utf8').toString('base64');
    expect(resolveCrxPrivateKey()).toContain('BEGIN PRIVATE KEY');
  });

  it('reads a PEM file from CRX_PRIVATE_KEY_PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crx-key-'));
    const keyPath = join(dir, 'key.pem');
    writeFileSync(keyPath, privateKeyPem);
    try {
      delete process.env.CRX_PRIVATE_KEY;
      process.env.CRX_PRIVATE_KEY_PATH = keyPath;
      expect(resolveCrxPrivateKey()).toContain('BEGIN');
      // and the resolved key actually signs a valid crx
      expect(createCrx(fakeZip, resolveCrxPrivateKey()!).subarray(0, 4).toString('latin1')).toBe('Cr24');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
