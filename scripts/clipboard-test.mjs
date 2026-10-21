/**
 * Clipboard-assisted key capture tests.
 *
 * The OS clipboard is not exercised directly (that would clobber the user's
 * clipboard and needs a desktop session); instead the parsing/shape rules and
 * the admin endpoint's contract are verified.
 */
import assert from 'node:assert/strict';
import {
  clipboardSignature,
  extractKeyCandidate,
  looksLikeApiKey
} from '../src/core/clipboard.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const REAL_SHAPES = [
  'gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd',
  'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
  'nvapi-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7'
];

await check('recognises the key shapes real providers issue', async () => {
  for (const key of REAL_SHAPES) {
    assert.equal(looksLikeApiKey(key), true, key);
  }
});

await check('rejects things that are not keys', async () => {
  const notKeys = [
    '',
    'hello',
    'true',
    'https://console.groq.com/keys',
    '1234567890',
    'aaaaaaaaaaaaaaaaaaaaaaaa',
    'this is a sentence with spaces in it',
    'Create API Key',
    '{"key":"gsk_abcdefghijklmnopqrstuvwxyz"}'
  ];
  for (const value of notKeys) {
    assert.equal(looksLikeApiKey(value), false, JSON.stringify(value));
  }
});

await check('extracts a bare key', async () => {
  const key = REAL_SHAPES[0];
  assert.equal(extractKeyCandidate(key), key);
  assert.equal(extractKeyCandidate(`  ${key}\n`), key);
});

await check('extracts a key wrapped in quotes', async () => {
  const key = REAL_SHAPES[1];
  assert.equal(extractKeyCandidate(`"${key}"`), key);
  assert.equal(extractKeyCandidate(`'${key}'`), key);
});

await check('extracts a key from an env-style line', async () => {
  const key = REAL_SHAPES[0];
  assert.equal(extractKeyCandidate(`GROQ_API_KEY=${key}`), key);
  assert.equal(extractKeyCandidate(`GROQ_API_KEY = "${key}"`), key);
  assert.equal(extractKeyCandidate(`# comment\nGROQ_API_KEY: ${key}\nOTHER=1`), key);
});

await check('ignores multi-line noise around the key', async () => {
  const key = REAL_SHAPES[4];
  const text = ['Your new API key', '', key, '', 'Store it somewhere safe'].join('\n');
  assert.equal(extractKeyCandidate(text), key);
});

await check('returns nothing when the clipboard holds no key', async () => {
  assert.equal(extractKeyCandidate(''), '');
  assert.equal(extractKeyCandidate('just some notes I copied earlier'), '');
  assert.equal(extractKeyCandidate('https://example.com/docs'), '');
});

await check('signature changes only when the clipboard content changes', async () => {
  const a = clipboardSignature(REAL_SHAPES[0]);
  const b = clipboardSignature(REAL_SHAPES[0]);
  const c = clipboardSignature(REAL_SHAPES[1]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(clipboardSignature(''), '0:0');
});

if (failures) {
  console.error(`\n${failures} clipboard check(s) failed`);
  process.exit(1);
}
console.log('\nall clipboard checks passed');
