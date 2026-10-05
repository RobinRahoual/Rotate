/*
 * Test de premiere.js avec un faux Premiere (module "premierepro") et une
 * imitation de l'API fs de UXP, pour vérifier tout le parcours :
 * sélection -> chutiers -> fichiers -> rotation -> rafraîchissement.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

// --- Imitation de l'API fs de UXP (promesses, ArrayBuffer) ---
const uxpFs = {
  async open(p, flag) { return fs.openSync(p, flag); },
  async close(fd) { fs.closeSync(fd); return 0; },
  async lstat(p) { return fs.lstatSync(p); },
  async read(fd, buffer, offset, length, position) {
    const bytesRead = fs.readSync(fd, new Uint8Array(buffer), offset, length, position);
    return { bytesRead, buffer };
  },
  async write(fd, buffer, offset, length, position) {
    const bytesWritten = fs.writeSync(fd, new Uint8Array(buffer), offset, length, position);
    return { bytesWritten, buffer };
  },
};

// --- Faux Premiere ---
const TYPE = { CLIP: 1, BIN: 2, ROOT: 3, FILE: 4 };
const refreshed = [];
function clip(name, mediaPath, opts = {}) {
  return {
    name, type: TYPE.CLIP,
    async isSequence() { return !!opts.sequence; },
    async isOffline() { return !!opts.offline; },
    async getMediaFilePath() { return mediaPath; },
    async refreshMedia() { refreshed.push(name); return true; },
    async changeMediaFilePath() { return true; },
  };
}
function bin(name, items) {
  return { name, type: TYPE.BIN, async getItems() { return items; } };
}
let selection = [];
const ppro = {
  Project: { async getActiveProject() { return { lockedAccess() {}, executeTransaction() {} }; } },
  ProjectUtils: { async getSelection() { return { async getItems() { return selection; } }; } },
  ProjectItem: { TYPE_CLIP: TYPE.CLIP, TYPE_BIN: TYPE.BIN, TYPE_ROOT: TYPE.ROOT, TYPE_FILE: TYPE.FILE },
  FolderItem: { cast: (i) => i },
  ClipProjectItem: { cast: (i) => i },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "premierepro") return ppro;
  if (request === "fs" && rest[0] && /premiere\.js$/.test(rest[0].filename)) return uxpFs;
  return originalLoad.call(this, request, ...rest);
};
const { rotateSelection } = require("../src/premiere.js");
const rotation = require("../src/mp4rotation.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-ppro-"));
function makeVideo(name) {
  const file = path.join(tmp, name);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:duration=1", "-c:v", "libx264", file]);
  return file;
}
async function rotationOf(file) {
  const fd = await uxpFs.open(file, "r");
  const io = {
    size: async () => fs.fstatSync(fd).size,
    read: async (p, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return new Uint8Array(b.buffer, b.byteOffset, l); },
  };
  try { return await rotation.getRotation(io); } finally { fs.closeSync(fd); }
}

test("Sélection mixte : clips, chutier imbriqué, doublon, séquence, hors ligne, MXF", async () => {
  const a = makeVideo("C0001.MP4");
  const b = makeVideo("C0002.MP4");
  const c = makeVideo("C0003.MP4");
  selection = [
    clip("C0001", a),
    bin("Rushs vertical", [clip("C0002", b), bin("Jour 2", [clip("C0003", c)]), clip("C0001 copie", a)]),
    clip("Séquence 01", "", { sequence: true }),
    clip("Absent", "/nope.mp4", { offline: true }),
    clip("Autre caméra", "/x/clip.mxf"),
  ];
  const logs = [];
  const res = await rotateSelection(90, (m, l) => logs.push(`[${l}] ${m}`));
  assert.deepStrictEqual(res, { done: 3, unchanged: 0, failed: 0 }, logs.join("\n"));
  for (const f of [a, b, c]) assert.strictEqual(await rotationOf(f), 90);
  assert.deepStrictEqual(refreshed.sort(), ["C0001", "C0001 copie", "C0002", "C0003"]);
  assert.ok(logs.some((l) => l.includes("Absent") && l.includes("hors ligne")));
  assert.ok(logs.some((l) => l.includes("Autre caméra") && l.includes("non pris en charge")));

  // Deuxième passage : rien ne change.
  const again = await rotateSelection(90, () => {});
  assert.deepStrictEqual(again, { done: 0, unchanged: 3, failed: 0 });

  // Retour à l'horizontale.
  await rotateSelection(0, () => {});
  for (const f of [a, b, c]) assert.strictEqual(await rotationOf(f), 0);
});

test("Sélection vide : message explicite", async () => {
  selection = [];
  await assert.rejects(rotateSelection(90, () => {}), /Sélectionne des rushs/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
