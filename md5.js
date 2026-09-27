/**
 * MD5 (RFC 1321) in plain JS. TTLock's OAuth endpoint wants the account
 * password as a lowercase MD5 hex digest, and WebCrypto has no MD5, so
 * the Worker cannot use node:crypto for it. NOT for anything security
 * relevant — it only reproduces TTLock's wire format.
 */
const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function md5Hex(input) {
  const bytes = new TextEncoder().encode(String(input));
  const len = bytes.length;
  const buf = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301; let b0 = 0xefcdab89; let c0 = 0x98badcfe; let d0 = 0x10325476;
  for (let off = 0; off < buf.length; off += 64) {
    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i++) {
      let F; let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; } else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + dv.getUint32(off + g * 4, true)) >>> 0;
      const s = S[(i >> 4) * 4 + (i % 4)];
      A = D; D = C; C = B;
      B = (B + ((F << s) | (F >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return Array.from(new Uint8Array(out.buffer), x => x.toString(16).padStart(2, '0')).join('');
}

module.exports = { md5Hex };
