import { randomUUID, randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time) {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[time % 32] + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom() {
  const bytes = randomBytes(16);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % 32];
  return out;
}

/** Generate a ULID (the format WorkBuddy uses for request ids). */
export function ulid(time = Date.now()) {
  return encodeTime(time) + encodeRandom();
}

export function uuid() {
  return randomUUID();
}

export function traceId() {
  return randomBytes(16).toString('hex');
}
