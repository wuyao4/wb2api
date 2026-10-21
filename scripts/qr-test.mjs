/**
 * QR encoder verification.
 *
 * The encoder is checked by an independent decoder (written as a reader, not by
 * reusing encoder helpers): mask removal, format-word read, codeword
 * extraction, block de-interleaving, Reed–Solomon syndrome verification and
 * payload parsing. A self-consistent but wrong encoder fails this.
 *
 * Also asserts the rendered SVG is self-contained, so the Raccoon login QR
 * never leaks a pending login code to a third-party image service.
 */
import { encodeQr, qrSvg } from '../src/core/qr.js';

/* ------------------------------------------------------------- GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function init() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

const BLOCKS = [
  null,
  [10, 1, 16, 0, 0],
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44]
];

const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

/** All Reed–Solomon syndromes must be zero for an intact block. */
function syndromesZero(block, ecCount) {
  for (let i = 0; i < ecCount; i += 1) {
    let value = 0;
    const x = EXP[i];
    for (const byte of block) value = gfMul(value, x) ^ byte;
    if (value !== 0) return false;
  }
  return true;
}

function functionMask(size, version) {
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) reserved[r][c] = true;
  };

  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) mark(r0 + r, c0 + c);
    }
  }
  for (let i = 0; i < size; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  for (const row of ALIGN[version]) {
    for (const col of ALIGN[version]) {
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) mark(row + r, col + c);
      }
    }
  }
  for (let i = 0; i < 9; i += 1) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  return reserved;
}

function readFormat(matrix) {
  const size = matrix.length;
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) bits |= matrix[8][i] << i;
  bits |= matrix[8][7] << 6;
  bits |= matrix[8][8] << 7;
  bits |= matrix[7][8] << 8;
  for (let i = 9; i < 15; i += 1) bits |= matrix[14 - i][8] << i;
  const unmasked = bits ^ 0x5412;
  return { ecLevel: (unmasked >>> 13) & 0x03, mask: (unmasked >>> 10) & 0x07 };
}

const MASK_FN = {
  0: (r, c) => (r + c) % 2 === 0,
  1: (r) => r % 2 === 0,
  2: (r, c) => c % 3 === 0,
  3: (r, c) => (r + c) % 3 === 0,
  4: (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  5: (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  6: (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  7: (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
};

function readCodewords(matrix, mask) {
  const size = matrix.length;
  const reserved = functionMask(size, (size - 17) / 4);
  const maskFn = MASK_FN[mask];
  const bits = [];

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c += 1) {
        const col = right - c;
        if (reserved[row][col]) continue;
        bits.push(maskFn(row, col) ? matrix[row][col] ^ 1 : matrix[row][col]);
      }
    }
    upward = !upward;
  }

  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return codewords;
}

function deinterleave(codewords, version) {
  const [ecPerBlock, blocks1, data1, blocks2, data2] = BLOCKS[version];
  const blockCount = blocks1 + blocks2;
  const dataLengths = [...new Array(blocks1).fill(data1), ...new Array(blocks2).fill(data2)];
  const maxData = Math.max(...dataLengths);

  const dataBlocks = dataLengths.map(() => []);
  const ecBlocks = dataLengths.map(() => []);
  let index = 0;

  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      if (i < dataLengths[b]) {
        dataBlocks[b].push(codewords[index]);
        index += 1;
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (let b = 0; b < blockCount; b += 1) {
      ecBlocks[b].push(codewords[index]);
      index += 1;
    }
  }

  return dataBlocks.map((data, b) => ({
    data,
    valid: syndromesZero([...data, ...ecBlocks[b]], ecPerBlock)
  }));
}

function decodeQr(matrix) {
  const size = matrix.length;
  if ((size - 17) % 4 !== 0) throw new Error(`invalid size ${size}`);
  const version = (size - 17) / 4;

  const { ecLevel, mask } = readFormat(matrix);
  const codewords = readCodewords(matrix, mask);
  const blocks = deinterleave(codewords, version);
  const bytes = blocks.flatMap((block) => block.data);

  let bitPos = 0;
  const readBits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = bytes[Math.floor(bitPos / 8)];
      const bit = (byte >>> (7 - (bitPos % 8))) & 1;
      value = (value << 1) | bit;
      bitPos += 1;
    }
    return value;
  };

  const mode = readBits(4);
  if (mode !== 0b0100) throw new Error(`unexpected mode ${mode.toString(2)}`);
  const length = readBits(version < 10 ? 8 : 16);
  const payload = [];
  for (let i = 0; i < length; i += 1) payload.push(readBits(8));

  return {
    text: Buffer.from(payload).toString('utf8'),
    version,
    mask,
    ecLevel,
    blocksValid: blocks.every((block) => block.valid)
  };
}

/* --------------------------------------------------------------- checks */

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}

const RACCOON_PAYLOAD =
  'https://xiaohuanxiong.com/login/mp?code=c03cdc9423ae57d3ffd63e90b1974b48' +
  '&appname=%E5%95%86%E6%B1%A4%E5%B0%8F%E6%B5%A3%E7%86%8A%E5%AE%98%E7%BD%91';

check('round-trips the real Raccoon login payload', () => {
  const decoded = decodeQr(encodeQr(RACCOON_PAYLOAD));
  if (decoded.text !== RACCOON_PAYLOAD) throw new Error('payload mismatch');
  if (!decoded.blocksValid) throw new Error('RS syndromes non-zero');
});

check('round-trips payloads across versions 1–9', () => {
  const cases = [
    'a',
    'https://example.com/x',
    'hello world',
    'x'.repeat(47),
    'x'.repeat(90),
    RACCOON_PAYLOAD,
    'x'.repeat(167)
  ];
  const versions = new Set();
  for (const text of cases) {
    const decoded = decodeQr(encodeQr(text));
    if (decoded.text !== text) throw new Error(`mismatch for length ${text.length}`);
    if (!decoded.blocksValid) throw new Error(`bad RS for length ${text.length}`);
    versions.add(decoded.version);
  }
  if (versions.size < 4) throw new Error(`expected several versions, got ${[...versions]}`);
});

check('round-trips UTF-8 payloads', () => {
  const text = '中文内容测试 🎉 ' + 'x'.repeat(20);
  const decoded = decodeQr(encodeQr(text));
  if (decoded.text !== text) throw new Error('utf8 mismatch');
});

check('declares EC level M and mask 0', () => {
  const decoded = decodeQr(encodeQr('https://example.com/ec'));
  if (decoded.ecLevel !== 0) throw new Error(`expected EC level M (0), got ${decoded.ecLevel}`);
  if (decoded.mask !== 0) throw new Error(`expected mask 0, got ${decoded.mask}`);
});

check('corruption is detected by the Reed–Solomon check', () => {
  const matrix = encodeQr('https://example.com/integrity');
  matrix[12][12] ^= 1;
  const decoded = decodeQr(matrix);
  if (decoded.blocksValid) throw new Error('corrupted symbol reported as valid');
});

check('finder patterns sit in three corners', () => {
  const m = encodeQr(RACCOON_PAYLOAD);
  const n = m.length;
  const isFinder = (r, c) =>
    m[r][c] === 1 && m[r][c + 6] === 1 && m[r + 6][c] === 1 && m[r + 3][c + 3] === 1;
  if (!isFinder(0, 0)) throw new Error('top-left finder missing');
  if (!isFinder(0, n - 7)) throw new Error('top-right finder missing');
  if (!isFinder(n - 7, 0)) throw new Error('bottom-left finder missing');
});

check('timing patterns alternate along row and column 6', () => {
  const m = encodeQr(RACCOON_PAYLOAD);
  const n = m.length;
  for (let i = 8; i < n - 8; i += 1) {
    const expected = i % 2 === 0 ? 1 : 0;
    if (m[6][i] !== expected) throw new Error(`row timing mismatch at ${i}`);
    if (m[i][6] !== expected) throw new Error(`column timing mismatch at ${i}`);
  }
});

check('the dark module is set', () => {
  const m = encodeQr(RACCOON_PAYLOAD);
  if (m[m.length - 8][8] !== 1) throw new Error('dark module missing');
});

check('every module is resolved', () => {
  for (const row of encodeQr(RACCOON_PAYLOAD)) {
    for (const cell of row) {
      if (cell !== 0 && cell !== 1) throw new Error('unresolved module');
    }
  }
});

check('svg is self-contained (no third-party image service)', () => {
  const svg = qrSvg(RACCOON_PAYLOAD, { size: 240 });
  if (!svg.startsWith('<svg')) throw new Error('not svg');
  if (!svg.includes('width="240"') || !svg.includes('height="240"')) throw new Error('bad size');
  if (/https?:\/\/(?!www\.w3\.org)/.test(svg)) throw new Error('external reference in svg');
  if (!svg.includes('<path')) throw new Error('no modules drawn');
});

check('oversized payloads are rejected rather than silently truncated', () => {
  let threw = false;
  try {
    encodeQr('x'.repeat(400));
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('expected an error for an oversized payload');
});

if (failures) {
  console.error(`\n${failures} qr check(s) failed`);
  process.exit(1);
}
console.log('\nall qr checks passed');
