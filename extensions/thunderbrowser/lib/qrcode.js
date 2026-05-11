// Minimal QR generator (numeric/byte mode, single-segment, fixed level L).
//
// This is a *small* implementation tailored to TB-0-8 payloads (~80-200 byte
// JSON blobs). It picks the smallest QR version that fits, encodes with error
// correction level L, and renders to an SVG string. It is NOT a general-
// purpose QR library — it doesn't do Kanji mode, ECI, structured append, or
// micro QR. Phase 1 swaps this for a vendored pinned-hash library when we
// start pushing more elaborate payloads through the pairing channel.
//
// Algorithm references:
//   ISO/IEC 18004:2015, sections 7.3 (encoding), 7.4 (error correction),
//   7.5 (matrix placement), 7.6 (masking), 7.7 (format/version info).
//
// Implementation cribbed from public-domain QR references and reduced to the
// features we actually use. No external dependencies.

// ── Error correction (Reed-Solomon) parameters ─────────────────────────────
// Versions 1-10, level L only — covers up to 230 byte-mode chars, plenty
// for a 6-digit code + JWK fingerprint payload.
const EC_BLOCKS_L = {
  1:  [1, 19, 7],   2:  [1, 34, 10],  3:  [1, 55, 15],
  4:  [1, 80, 20],  5:  [1, 108, 26], 6:  [2, 68, 18],
  7:  [2, 78, 20],  8:  [2, 97, 24],  9:  [2, 116, 30],
  10: [2, 68, 18],
};
// For our purposes (small payloads) we only need versions 2-5 typically; we
// keep 1-10 for headroom. Versions with multiple block groups (6+) use the
// simpler equal-block layout because we never exceed two groups at level L
// in the supported range.

const CHAR_COUNT_BITS_BYTE = { 1: 8, 10: 16 }; // 1-9: 8 bits, 10+: 16 bits

// Total data codewords per version at level L.
const DATA_CAPACITY_L = {
  1: 19, 2: 34, 3: 55, 4: 80, 5: 108,
  6: 136, 7: 156, 8: 194, 9: 232, 10: 274,
};

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const ccBits = v < 10 ? 8 : 16;
    const headerBits = 4 + ccBits;
    const dataBits = headerBits + byteLen * 8 + 4; // +4 terminator (best-effort)
    const cap = DATA_CAPACITY_L[v] * 8;
    if (dataBits <= cap) return v;
  }
  throw new Error('QR payload too large for v1-v10 level L');
}

// ── Galois field GF(256) ───────────────────────────────────────────────────
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
function gfMul(a, b) { return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]; }

function rsGenerator(degree) {
  let g = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const buf = data.concat(new Array(ecLen).fill(0));
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return buf.slice(data.length);
}

// ── Bit buffer ─────────────────────────────────────────────────────────────
class BitBuffer {
  constructor() { this.bits = []; }
  put(n, len) {
    for (let i = len - 1; i >= 0; i--) {
      this.bits.push(((n >>> i) & 1) === 1);
    }
  }
  toBytes() {
    const out = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let b = 0;
      for (let j = 0; j < 8 && i + j < this.bits.length; j++) {
        if (this.bits[i + j]) b |= 1 << (7 - j);
      }
      out.push(b);
    }
    return out;
  }
  get length() { return this.bits.length; }
}

// ── Matrix placement + masking ─────────────────────────────────────────────

function buildMatrix(version, dataBytes) {
  const size = 17 + version * 4;
  const matrix = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  function setFinder(r, c) {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const rr = r + i, cc = c + j;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const onEdge = (i === 0 || i === 6) ? (j >= 0 && j <= 6)
                    : (j === 0 || j === 6) ? (i >= 0 && i <= 6)
                    : false;
        const onCore = i >= 2 && i <= 4 && j >= 2 && j <= 4;
        matrix[rr][cc] = (onEdge || onCore) ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  }
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const bit = (i % 2 === 0) ? 1 : 0;
    if (matrix[6][i] === -1) { matrix[6][i] = bit; reserved[6][i] = 1; }
    if (matrix[i][6] === -1) { matrix[i][6] = bit; reserved[i][6] = 1; }
  }

  // Alignment patterns (versions ≥ 2).
  if (version >= 2) {
    const positions = alignmentPositions(version);
    for (const r of positions) {
      for (const c of positions) {
        if ((r === 6 && c === 6) ||
            (r === 6 && c === size - 7) ||
            (r === size - 7 && c === 6)) continue;
        placeAlignment(matrix, reserved, r, c);
      }
    }
  }

  // Dark module + format info reservation.
  matrix[size - 8][8] = 1; reserved[size - 8][8] = 1;
  for (let i = 0; i < 9; i++) {
    if (matrix[8][i] === -1) { reserved[8][i] = 1; }
    if (matrix[i][8] === -1) { reserved[i][8] = 1; }
  }
  for (let i = size - 8; i < size; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }

  // Place data.
  let bitIndex = 0;
  const totalBits = dataBytes.length * 8;
  function getBit(i) {
    return (dataBytes[i >> 3] >> (7 - (i & 7))) & 1;
  }
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[r][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = getBit(bitIndex++);
        }
        matrix[r][c] = bit;
      }
    }
    upward = !upward;
  }

  // Choose mask: try all 8, pick the lowest-penalty.
  let bestMask = 0, bestPenalty = Infinity, bestMatrix = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(matrix, reserved, mask);
    writeFormatInfo(candidate, mask);
    const p = maskPenalty(candidate);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }
  void bestMask;
  return bestMatrix;
}

function alignmentPositions(version) {
  // ISO/IEC 18004 Annex E — versions 2-10.
  const table = {
    2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  return table[version] || [];
}

function placeAlignment(matrix, reserved, r, c) {
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const rr = r + i, cc = c + j;
      const onEdge = Math.abs(i) === 2 || Math.abs(j) === 2;
      const center = i === 0 && j === 0;
      matrix[rr][cc] = (onEdge || center) ? 1 : 0;
      reserved[rr][cc] = 1;
    }
  }
}

function applyMask(matrix, reserved, mask) {
  const size = matrix.length;
  const out = matrix.map((row) => Int8Array.from(row));
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      let flip = false;
      switch (mask) {
        case 0: flip = (r + c) % 2 === 0; break;
        case 1: flip = r % 2 === 0; break;
        case 2: flip = c % 3 === 0; break;
        case 3: flip = (r + c) % 3 === 0; break;
        case 4: flip = (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; break;
        case 5: flip = ((r * c) % 2) + ((r * c) % 3) === 0; break;
        case 6: flip = (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; break;
        case 7: flip = (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; break;
      }
      if (flip) out[r][c] ^= 1;
    }
  }
  return out;
}

function writeFormatInfo(matrix, mask) {
  // Format info bits — level L = 0b01, mask in lower 3 bits.
  const data = (0b01 << 3) | mask;
  let bch = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((bch >> (i + 10)) & 1) {
      bch ^= 0b10100110111 << i;
    }
  }
  const fmt = ((data << 10) | bch) ^ 0b101010000010010;
  const size = matrix.length;
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >> i) & 1;
    // Top-left strip.
    if (i < 6) matrix[8][i] = bit;
    else if (i < 8) matrix[8][i + 1] = bit;
    else if (i === 8) matrix[7][8] = bit;
    else matrix[14 - i][8] = bit;
    // Top-right + bottom-left strip.
    if (i < 8) matrix[size - 1 - i][8] = bit;
    else matrix[8][size - 15 + i] = bit;
  }
  matrix[size - 8][8] = 1;
}

function maskPenalty(matrix) {
  // Simplified penalty — N1 (consecutive same-color in rows/cols only).
  // Good enough to differentiate the 8 mask candidates for our small payloads.
  const size = matrix.length;
  let penalty = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (matrix[r][c] === matrix[r][c - 1]) {
        run++;
      } else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (matrix[r][c] === matrix[r - 1][c]) {
        run++;
      } else {
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) penalty += 3 + (run - 5);
  }
  return penalty;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function encodeQr(text) {
  const utf8 = new TextEncoder().encode(text);
  const version = pickVersion(utf8.length);
  const dataCap = DATA_CAPACITY_L[version];
  const ecLen = EC_BLOCKS_L[version][2];
  const ccBits = version < 10 ? 8 : 16;

  const bb = new BitBuffer();
  bb.put(0b0100, 4);          // byte mode indicator
  bb.put(utf8.length, ccBits);
  for (let i = 0; i < utf8.length; i++) bb.put(utf8[i], 8);
  // Terminator + pad.
  const remain = dataCap * 8 - bb.length;
  bb.put(0, Math.min(4, Math.max(0, remain)));
  while (bb.length % 8 !== 0) bb.put(0, 1);
  let pad = 0xec;
  while (bb.toBytes().length < dataCap) {
    bb.put(pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  const data = bb.toBytes().slice(0, dataCap);
  const ec = rsEncode(data, ecLen);
  const finalBytes = data.concat(ec);

  const matrix = buildMatrix(version, finalBytes);
  return { matrix, size: matrix.length, version };
}

export function renderSvg(text, scale = 6, quietZone = 4) {
  const { matrix, size } = encodeQr(text);
  const dim = (size + quietZone * 2) * scale;
  const cells = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c] === 1) {
        const x = (c + quietZone) * scale;
        const y = (r + quietZone) * scale;
        cells.push(`<rect x="${x}" y="${y}" width="${scale}" height="${scale}"/>`);
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" ` +
    `viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<g fill="#000000">${cells.join('')}</g>` +
    `</svg>`
  );
}
