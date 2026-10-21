/**
 * Minimal QR encoder → SVG.
 *
 * Raccoon's login flow hands the user a payload to scan; rendering it locally
 * keeps the code (and therefore the pending login) off any third-party QR
 * service. Byte mode, error correction level M, versions 1–10 — enough for the
 * ~110-character URLs these flows produce.
 *
 * Only the pieces needed for that payload are implemented: numeric/alnum modes
 * are not used, and the mask is fixed at 0 (still a valid, scannable symbol).
 */

const EC_LEVEL_M = 0; // format-bits value for level M
const EC_CODEWORDS_PER_BLOCK = [
  // index = version, value = [ecCodewordsPerBlock, blocksGroup1, dataCodewordsGroup1, blocksGroup2, dataCodewordsGroup2]
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

const ALIGNMENT_POSITIONS = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

/** Byte-mode capacity in characters for each version at level M. */
function dataCapacity(version) {
  const [, blocks1, data1, blocks2, data2] = EC_CODEWORDS_PER_BLOCK[version];
  return blocks1 * data1 + blocks2 * data2;
}

function pickVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    // 4 bits mode + char count + data must fit; count bits are 8 for v1-9.
    const countBits = version < 10 ? 8 : 16;
    const needed = Math.ceil((4 + countBits + byteLength * 8) / 8);
    if (needed <= dataCapacity(version)) return version;
  }
  return null;
}

/* ------------------------------------------------------------------ GF(256) */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(function initTables() {
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

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
  }
  return result;
}

/* ---------------------------------------------------------------- bit buffer */

function buildCodewords(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  // Pad bytes alternate 0xEC / 0x11.
  while (codewords.length < dataCapacity(version)) {
    codewords.push(codewords.length % 2 === dataCapacity(version) % 2 ? 0xec : 0x11);
  }
  return codewords;
}

function interleave(codewords, version) {
  const [, blocks1, data1, blocks2, data2] = EC_CODEWORDS_PER_BLOCK[version];
  const ecPerBlock = EC_CODEWORDS_PER_BLOCK[version][0];
  const blocks = [];
  let offset = 0;

  for (let i = 0; i < blocks1; i += 1) {
    const data = codewords.slice(offset, offset + data1);
    offset += data1;
    blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
  }
  for (let i = 0; i < blocks2; i += 1) {
    const data = codewords.slice(offset, offset + data2);
    offset += data2;
    blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
  }

  const out = [];
  const maxData = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) out.push(block.ec[i]);
  }
  return out;
}

/* --------------------------------------------------------------- matrix */

function createMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFinder(matrix, row, col) {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= matrix.length || cc >= matrix.length) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix[rr][cc] = inRing || inCore ? 1 : 0;
    }
  }
}

function placeAlignment(matrix, version) {
  const positions = ALIGNMENT_POSITIONS[version];
  for (const row of positions) {
    for (const col of positions) {
      // Skip the three finder corners.
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= matrix.length - 9) ||
        (row >= matrix.length - 9 && col <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          matrix[row + r][col + c] = on ? 1 : 0;
        }
      }
    }
  }
}

function placeTiming(matrix) {
  for (let i = 8; i < matrix.length - 8; i += 1) {
    const value = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] === null) matrix[6][i] = value;
    if (matrix[i][6] === null) matrix[i][6] = value;
  }
}

function reserveFormat(matrix) {
  const size = matrix.length;
  for (let i = 0; i < 9; i += 1) {
    if (matrix[8][i] === null) matrix[8][i] = 0;
    if (matrix[i][8] === null) matrix[i][8] = 0;
  }
  for (let i = 0; i < 8; i += 1) {
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = 0;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = 0;
  }
  matrix[size - 8][8] = 1; // dark module
}

function writeFormat(matrix, mask) {
  const size = matrix.length;
  const data = (EC_LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const bit = (index) => (bits >>> index) & 1;
  for (let i = 0; i <= 5; i += 1) matrix[8][i] = bit(i);
  matrix[8][7] = bit(6);
  matrix[8][8] = bit(7);
  matrix[7][8] = bit(8);
  for (let i = 9; i < 15; i += 1) matrix[14 - i][8] = bit(i);

  for (let i = 0; i < 8; i += 1) matrix[size - 1 - i][8] = bit(i);
  for (let i = 8; i < 15; i += 1) matrix[8][size - 15 + i] = bit(i);

  // The dark module is written last: the second format copy above covers the
  // same cell (row size-8, column 8) with bit 7, and the spec requires the dark
  // module to win.
  matrix[size - 8][8] = 1;
}

function placeData(matrix, codewords) {
  const size = matrix.length;
  const bits = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }

  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c += 1) {
        const col = right - c;
        if (matrix[row][col] !== null) continue;
        matrix[row][col] = index < bits.length ? bits[index] : 0;
        index += 1;
      }
    }
    upward = !upward;
  }
}

function applyMask(matrix, mask) {
  const size = matrix.length;
  const reserved = matrix.map((row) => row.map(() => false));

  // Recompute which modules are function patterns by re-placing them.
  const probe = createMatrix(size);
  placeFinder(probe, 0, 0);
  placeFinder(probe, 0, size - 7);
  placeFinder(probe, size - 7, 0);
  placeAlignment(probe, inferVersion(size));
  placeTiming(probe);
  reserveFormat(probe);
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) reserved[r][c] = probe[r][c] !== null;
  }

  const maskFn = {
    0: (r, c) => (r + c) % 2 === 0,
    1: (r) => r % 2 === 0,
    2: (r, c) => c % 3 === 0,
    3: (r, c) => (r + c) % 3 === 0,
    4: (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    5: (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    6: (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    7: (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }[mask];

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!reserved[r][c] && maskFn(r, c)) matrix[r][c] ^= 1;
    }
  }
}

function inferVersion(size) {
  return Math.round((size - 17) / 4);
}

/** Encode `text` and return a boolean matrix (true = dark). */
export function encodeQr(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = pickVersion(bytes.length);
  if (!version) throw new Error('QR payload too large');

  const size = version * 4 + 17;
  const matrix = createMatrix(size);

  placeFinder(matrix, 0, 0);
  placeFinder(matrix, 0, size - 7);
  placeFinder(matrix, size - 7, 0);
  placeAlignment(matrix, version);
  placeTiming(matrix);
  reserveFormat(matrix);

  const codewords = interleave(buildCodewords(bytes, version), version);
  placeData(matrix, codewords);
  applyMask(matrix, 0);
  writeFormat(matrix, 0);

  return matrix;
}

/** Render a QR payload as a standalone SVG string. */
export function qrSvg(text, { size = 240, margin = 4 } = {}) {
  const matrix = encodeQr(text);
  const count = matrix.length;
  const total = count + margin * 2;

  let path = '';
  for (let r = 0; r < count; r += 1) {
    for (let c = 0; c < count; c += 1) {
      if (!matrix[r][c]) continue;
      path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="登录二维码">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path d="${path}" fill="#000000"/></svg>`
  );
}
