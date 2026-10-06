"use strict";

const test = require("node:test");
const assert = require("node:assert");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { decompress, utf8Decode } = require("../src/inflate.js");

function samples() {
  const xml = Array.from({ length: 2000 }, (_, i) => `<ExporterParam ObjectID="${i}"><ParamValue>${i * 7}</ParamValue><Nom>Préréglage é ü</Nom></ExporterParam>`).join("\n");
  return [
    Buffer.from(""),
    Buffer.from("a"),
    Buffer.from(xml),
    crypto.randomBytes(70000), // incompressible -> blocs non compressés
    Buffer.alloc(100000, 65), // répétitions longues
  ];
}

test("gzip, zlib et deflate brut : identiques à zlib, tous niveaux", () => {
  for (const data of samples()) {
    for (const level of [0, 1, 6, 9]) {
      assert.deepStrictEqual(Buffer.from(decompress(new Uint8Array(zlib.gzipSync(data, { level })))), data);
      assert.deepStrictEqual(Buffer.from(decompress(new Uint8Array(zlib.deflateSync(data, { level })))), data);
    }
    // Codes fixes uniquement (Z_FIXED)
    assert.deepStrictEqual(Buffer.from(decompress(new Uint8Array(zlib.gzipSync(data, { strategy: zlib.constants.Z_FIXED })))), data);
  }
});

test("Fichier non compressé : renvoyé tel quel ; UTF-8 décodé", () => {
  const text = "<?xml version=\"1.0\"?><PresetName>Proxy vertical é</PresetName>";
  const bytes = new Uint8Array(Buffer.from(text));
  assert.strictEqual(utf8Decode(decompress(bytes)), text);
});

test("Gzip tronqué : erreur claire", () => {
  const gz = zlib.gzipSync(Buffer.from("x".repeat(5000) + crypto.randomBytes(3000).toString("hex")));
  assert.throws(() => decompress(new Uint8Array(gz.subarray(0, gz.length / 2))), /tronqu/);
});
