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
// failOpen(path, flag) peut renvoyer une erreur à lever (simulation de verrou / lecture seule).
let failOpen = () => null;
const uxpFs = {
  async open(p, flag) {
    const err = failOpen(p, flag);
    if (err) throw new Error(err);
    return fs.openSync(p, flag);
  },
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
let pathCalls = 0;
const offline = [];
const relinked = [];
function clip(name, mediaPath) {
  return {
    name, type: TYPE.CLIP,
    createSetOfflineAction() { return { offline: name }; },
    async changeMediaFilePath(p) { relinked.push([name, p]); return true; },
    async getMediaFilePath() { pathCalls++; return mediaPath; },
    async refreshMedia() { refreshed.push(name); return true; },
    async hasProxy() { return false; },
  };
}
let binIds = 0;
function bin(name, items) {
  const id = `bin-${++binIds}`;
  return { name, type: TYPE.BIN, getId: () => id, async getItems() { return items; } };
}
let selection = [];
const ppro = {
  Project: {
    async getActiveProject() {
      return {
        lockedAccess(fn) { fn(); },
        executeTransaction(fn) { fn({ addAction(a) { offline.push(a.offline); } }); return true; },
        async getRootItem() { return { name: "root", type: TYPE.ROOT, async getItems() { return selection; } }; },
      };
    },
  },
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
const { rotateSelection, undoOperation } = require("../src/premiere.js");
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

test("Sélection mixte : clips, chutiers imbriqués, doublons, séquence, hors ligne, MXF", async () => {
  const a = makeVideo("C0001.MP4");
  const b = makeVideo("C0002.MP4");
  const c = makeVideo("C0003.MP4");
  const jour2 = bin("Jour 2", [clip("C0003", c)]);
  selection = [
    clip("C0001", a),
    bin("Rushs vertical", [clip("C0002", b), jour2, clip("C0001 copie", a)]),
    jour2, // chutier sélectionné en même temps que son parent
    clip("Séquence 01", ""),
    clip("Absent", path.join(tmp, "absent.mp4")),
    clip("Autre caméra", "/x/clip.mxf"),
  ];
  const logs = [];
  const progress = [];
  const res = await rotateSelection(90, {
    log: (m, l) => logs.push(`[${l}] ${m}`),
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.strictEqual(res.done, 3, logs.join("\n"));
  assert.strictEqual(res.failed, 1, logs.join("\n"));
  for (const f of [a, b, c]) assert.strictEqual(await rotationOf(f), 90);
  // Un seul rafraîchissement par fichier, et un seul appel API par clip pour la collecte.
  assert.deepStrictEqual(refreshed.sort(), ["C0001", "C0002", "C0003"]);
  assert.strictEqual(pathCalls, 7);
  assert.ok(logs.some((l) => l.includes("Absent") && l.includes("introuvable")), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes("Autre caméra") && l.includes("non pris en charge")));
  assert.ok(logs.some((l) => l.includes("1 élément(s) partagent un fichier")));
  assert.deepStrictEqual(progress[progress.length - 1], [3, 3]);
  assert.ok(res.timings.files >= 0 && res.timings.refresh >= 0);

  // Deuxième passage : aucun fichier réécrit, aucun rafraîchissement.
  refreshed.length = 0;
  const mtimes = [a, b, c].map((f) => fs.statSync(f).mtimeMs);
  const again = await rotateSelection(90);
  assert.strictEqual(again.done, 0);
  assert.strictEqual(again.unchanged, 3);
  assert.deepStrictEqual(refreshed, []);
  assert.deepStrictEqual([a, b, c].map((f) => fs.statSync(f).mtimeMs), mtimes);

  // Retour à l'horizontale.
  await rotateSelection(0);
  for (const f of [a, b, c]) assert.strictEqual(await rotationOf(f), 0);
});

test("Annulation : s'arrête proprement entre deux clips", async () => {
  const files = ["D1.MP4", "D2.MP4", "D3.MP4"].map(makeVideo);
  selection = files.map((f, i) => clip(`D${i + 1}`, f));
  let calls = 0;
  const res = await rotateSelection(270, { isCancelled: () => ++calls > 1 });
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(res.done, 1);
  assert.strictEqual(await rotationOf(files[0]), 270);
  assert.strictEqual(await rotationOf(files[1]), 0);
});

test("Aperçu : seuls les rushs cochés sont tournés ; abandon = rien ne change", async () => {
  const files = ["E1.MP4", "E2.MP4", "E3.MP4"].map(makeVideo);
  selection = files.map((f, i) => clip(`E${i + 1}`, f));

  const aborted = await rotateSelection(90, { confirm: async () => null });
  assert.strictEqual(aborted.aborted, true);
  for (const f of files) assert.strictEqual(await rotationOf(f), 0);

  let seen = null;
  const res = await rotateSelection(90, {
    confirm: async (items) => { seen = items; return items.filter((i) => i.entry.name !== "E2"); },
  });
  assert.deepStrictEqual(seen.map((i) => [i.entry.name, i.status, i.previous]), [["E1", "todo", 0], ["E2", "todo", 0], ["E3", "todo", 0]]);
  assert.strictEqual(res.done, 2);
  assert.deepStrictEqual(await Promise.all(files.map(rotationOf)), [90, 0, 90]);
});

test("Annuler la dernière opération : fichiers identiques à l'octet près", async () => {
  const files = ["F1.MP4", "F2.MP4"].map(makeVideo);
  const hashes = files.map((f) => fs.readFileSync(f).toString("base64"));
  selection = files.map((f, i) => clip(`F${i + 1}`, f));
  const res = await rotateSelection(270);
  assert.strictEqual(res.operation.files.length, 2);
  // L'opération doit survivre à un passage par le stockage (JSON).
  const op = JSON.parse(JSON.stringify(res.operation));
  refreshed.length = 0;
  const undo = await undoOperation(op);
  assert.deepStrictEqual(undo, { restored: 2, skipped: 0, failed: 0 });
  assert.deepStrictEqual(files.map((f) => fs.readFileSync(f).toString("base64")), hashes);
  assert.deepStrictEqual(refreshed.sort(), ["F1", "F2"]);
});

test("Annuler ne touche pas un fichier modifié depuis par une autre rotation", async () => {
  const file = makeVideo("G1.MP4");
  selection = [clip("G1", file)];
  const first = await rotateSelection(270);
  await rotateSelection(180); // autre opération sur le même fichier
  const undo = await undoOperation(JSON.parse(JSON.stringify(first.operation)));
  assert.deepStrictEqual(undo, { restored: 0, skipped: 1, failed: 0 });
  assert.strictEqual(await rotationOf(file), 180);
});

test("Fichier verrouillé par Premiere (Windows) : hors ligne, écriture, puis re-lié", async () => {
  const file = makeVideo("L1.MP4");
  selection = [clip("L1", file)];
  offline.length = 0; relinked.length = 0;
  let attempts = 0;
  failOpen = (p, flag) => (flag === "r+" && attempts++ === 0 ? "EBUSY: resource busy or locked" : null);
  const res = await rotateSelection(270);
  failOpen = () => null;
  assert.strictEqual(res.done, 1);
  assert.strictEqual(await rotationOf(file), 270);
  assert.deepStrictEqual(offline, ["L1"]);
  assert.deepStrictEqual(relinked, [["L1", file]]);
});

test("Carte SD verrouillée : message clair, clip jamais mis hors ligne", async () => {
  const file = makeVideo("RO.MP4");
  selection = [clip("RO", file)];
  offline.length = 0; relinked.length = 0;
  failOpen = (p, flag) => (flag === "r+" ? "EACCES: permission denied" : null);
  const logs = [];
  const res = await rotateSelection(270, { log: (m) => logs.push(m) });
  failOpen = () => null;
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(await rotationOf(file), 0);
  assert.deepStrictEqual(offline, []);
  assert.ok(logs.some((l) => l.includes("lecture seule")), logs.join("\n"));
});

test("Verrou persistant : le clip est re-lié même si l'écriture échoue", async () => {
  const file = makeVideo("L2.MP4");
  selection = [clip("L2", file)];
  offline.length = 0; relinked.length = 0;
  failOpen = (p, flag) => (flag === "r+" ? "EBUSY: resource busy or locked" : null);
  const res = await rotateSelection(270);
  failOpen = () => null;
  assert.strictEqual(res.failed, 1);
  assert.deepStrictEqual(offline, ["L2"]);
  assert.deepStrictEqual(relinked, [["L2", file]]);
});

test("Pause entre actualisations : proportionnelle et bornée", () => {
  const { refreshPause } = require("../src/premiere.js");
  assert.strictEqual(refreshPause(0), 30);
  assert.strictEqual(refreshPause(200), 100);
  assert.strictEqual(refreshPause(5000), 250);
});

test("Sélection vide : message explicite", async () => {
  selection = [];
  await assert.rejects(rotateSelection(90), /Sélectionne des rushs/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
