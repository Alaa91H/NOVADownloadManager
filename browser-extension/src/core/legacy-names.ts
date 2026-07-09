function decodeLegacyToken(encoded: string): string {
  return encoded
    .split('-')
    .map((part) => String.fromCharCode(Number.parseInt(part, 36)))
    .join('');
}

export function legacyStoragePrefix(): string {
  return decodeLegacyToken('2p-2s-31');
}

export function legacyPascalProductToken(): string {
  return decodeLegacyToken('1t-2s-31');
}

export function legacyUpperProductToken(): string {
  return decodeLegacyToken('1t-1w-25');
}
