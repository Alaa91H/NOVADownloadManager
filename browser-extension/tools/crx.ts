// Minimal, dependency-free CRX3 packer.
//
// A `.crx` is NOT a renamed zip: the CRX3 format prefixes the zip payload with
// a signed protobuf header (magic "Cr24", version 3, header length, header).
// We sign with RSA SHA-256 (PKCS#1 v1.5) using only node:crypto, so producing
// a real, installable crx needs a private key. When no key is available the
// caller falls back to shipping the plain `.zip`.

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CRX_MAGIC = Buffer.from('Cr24', 'latin1');
const CRX_VERSION = 3;
// Chromium signs over this context string ("CRX3 SignedData" + a NUL byte).
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1');

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

// Protobuf field tag = (fieldNumber << 3) | wireType. wireType 2 = length-delimited.
function lengthDelimitedField(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, encodeVarint(payload.length), payload]);
}

function uint32le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

/** Resolve a signing key from a file path, or null when none is configured. */
export function resolveCrxPrivateKey(): string | null {
  const keyPath = process.env.CRX_PRIVATE_KEY_PATH?.trim();
  if (keyPath) {
    try {
      return readFileSync(keyPath, 'utf8');
    } catch (error) {
      // Only log in debug, never expose the path content
      if (process.env.DEBUG) console.error(`CRX key read failed (path: ${keyPath}): ${(error as Error).message}`);
      return null;
    }
  }
  return null;
}

export function isCrxSigningAvailable(): boolean {
  return resolveCrxPrivateKey() !== null;
}

/** Build a CRX3 archive buffer from raw zip bytes and a PEM private key. */
export function createCrx(zip: Buffer, privateKeyPem: string): Buffer {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKeyDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;

  // crx_id = first 16 bytes of SHA-256(public key SPKI DER).
  const crxId = createHash('sha256').update(publicKeyDer).digest().subarray(0, 16);
  // SignedData { crx_id = field 1 }
  const signedHeaderData = lengthDelimitedField(1, crxId);

  const signedPayload = Buffer.concat([
    SIGNATURE_CONTEXT,
    uint32le(signedHeaderData.length),
    signedHeaderData,
    zip,
  ]);
  const signature = cryptoSign('sha256', signedPayload, privateKey);

  // AsymmetricKeyProof { public_key = 1, signature = 2 }
  const keyProof = Buffer.concat([
    lengthDelimitedField(1, publicKeyDer),
    lengthDelimitedField(2, signature),
  ]);
  // CrxFileHeader { sha256_with_rsa = 2 (repeated), signed_header_data = 10000 }
  const header = Buffer.concat([
    lengthDelimitedField(2, keyProof),
    lengthDelimitedField(10000, signedHeaderData),
  ]);

  return Buffer.concat([CRX_MAGIC, uint32le(CRX_VERSION), uint32le(header.length), header, zip]);
}

/** Strip the CRX3 header from a crx buffer, returning the embedded zip bytes. */
export function extractZipFromCrx(crx: Buffer): Buffer {
  if (crx.subarray(0, 4).toString('latin1') !== 'Cr24') return crx;
  const headerLength = crx.readUInt32LE(8);
  return crx.subarray(12 + headerLength);
}
