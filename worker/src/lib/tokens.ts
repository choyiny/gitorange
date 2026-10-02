import { sha256Hex, toHex } from '../git/bytes';

export function randomToken(prefix: string, bytes = 20): string {
  return prefix + toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export const hashToken = sha256Hex;
