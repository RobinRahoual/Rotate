/*
 * Décompression gzip / zlib / deflate (RFC 1950, 1951, 1952) en JavaScript pur.
 *
 * Certains préréglages livrés avec Media Encoder (.epr) sont du XML compressé
 * en gzip, et UXP ne fournit pas de décompresseur. Implémentation volontairement
 * simple (décodage de Huffman canonique bit à bit, d'après « puff » de zlib) :
 * largement assez rapide pour des fichiers de quelques centaines de Ko.
 */

"use strict";

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(lengths.length);
  for (const len of lengths) count[len]++;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  count[0] = 0;
  return { count, symbol };
}

function inflateRaw(input) {
  let pos = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let outLen = 0;

  function bits(need) {
    let val = bitBuf;
    while (bitCnt < need) {
      if (pos >= input.length) throw new Error("Données compressées tronquées.");
      val |= input[pos++] << bitCnt;
      bitCnt += 8;
    }
    bitBuf = val >>> need;
    bitCnt -= need;
    return val & ((1 << need) - 1);
  }

  function ensure(extra) {
    if (outLen + extra <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + extra) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, outLen));
    out = bigger;
  }

  function decode(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error("Code de Huffman invalide.");
  }

  function codes(lencode, distcode) {
    for (;;) {
      let sym = decode(lencode);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error("Longueur invalide.");
        const len = LEN_BASE[sym] + bits(LEN_EXTRA[sym]);
        const dsym = decode(distcode);
        if (dsym >= 30) throw new Error("Distance invalide.");
        const dist = DIST_BASE[dsym] + bits(DIST_EXTRA[dsym]);
        if (dist > outLen) throw new Error("Distance trop grande.");
        ensure(len);
        for (let i = 0; i < len; i++) {
          out[outLen] = out[outLen - dist];
          outLen++;
        }
      }
    }
  }

  let fixedLen = null;
  let fixedDist = null;
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > input.length) throw new Error("Bloc non compressé tronqué.");
      const len = input[pos] | (input[pos + 1] << 8);
      const nlen = input[pos + 2] | (input[pos + 3] << 8);
      pos += 4;
      if (len !== (~nlen & 0xffff)) throw new Error("Bloc non compressé invalide.");
      if (pos + len > input.length) throw new Error("Bloc non compressé tronqué.");
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
    } else if (type === 1) {
      if (!fixedLen) {
        const lengths = new Uint8Array(288);
        lengths.fill(8, 0, 144);
        lengths.fill(9, 144, 256);
        lengths.fill(7, 256, 280);
        lengths.fill(8, 280, 288);
        fixedLen = huffman(lengths);
        fixedDist = huffman(new Uint8Array(30).fill(5));
      }
      codes(fixedLen, fixedDist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const lengths = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) lengths[CODE_LENGTH_ORDER[i]] = bits(3);
      const lencode = huffman(lengths);
      const all = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist; ) {
        const sym = decode(lencode);
        if (sym < 16) {
          all[i++] = sym;
          continue;
        }
        let value = 0;
        let repeat;
        if (sym === 16) {
          if (i === 0) throw new Error("Répétition sans valeur précédente.");
          value = all[i - 1];
          repeat = 3 + bits(2);
        } else if (sym === 17) {
          repeat = 3 + bits(3);
        } else {
          repeat = 11 + bits(7);
        }
        if (i + repeat > nlen + ndist) throw new Error("Trop de longueurs.");
        while (repeat--) all[i++] = value;
      }
      codes(huffman(all.subarray(0, nlen)), huffman(all.subarray(nlen)));
    } else {
      throw new Error("Type de bloc invalide.");
    }
  }
  return out.slice(0, outLen);
}

function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/* Décompresse du gzip (ou du zlib) ; renvoie les octets tels quels sinon. */
function decompress(bytes) {
  if (isGzip(bytes)) {
    if (bytes[2] !== 8) throw new Error("Compression gzip non prise en charge.");
    const flags = bytes[3];
    let pos = 10;
    if (flags & 4) pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8)); // FEXTRA
    if (flags & 8) while (bytes[pos++] !== 0); // FNAME
    if (flags & 16) while (bytes[pos++] !== 0); // FCOMMENT
    if (flags & 2) pos += 2; // FHCRC
    return inflateRaw(bytes.subarray(pos));
  }
  if (bytes.length > 2 && (bytes[0] & 0x0f) === 8 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    return inflateRaw(bytes.subarray(2)); // zlib
  }
  return bytes;
}

/* Décodage UTF-8 (TextDecoder n'est pas garanti dans UXP). */
function utf8Decode(bytes) {
  if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp;
    if (b < 0x80) cp = b;
    else if (b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    out += String.fromCodePoint(cp);
  }
  return out;
}

module.exports = { inflateRaw, decompress, isGzip, utf8Decode };
