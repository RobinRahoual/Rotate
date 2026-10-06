"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const rotation = require("../src/mp4rotation.js");
const { createProxyQueue, extensionFromPreset, splitPath, waitForCompleteFile } = require("../src/proxies.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-proxy-"));
function video(name, size, rate = 25) {
  const file = path.join(tmp, name);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=1`, "-c:v", "libx264", file]);
  return file;
}
const finished = video("finished.mov", "108x192");
const wrongRate = video("wrong-rate.mov", "108x192", 30);
const horizontal = video("horizontal.mov", "192x108");

// Rush 16:9 tourné à -90° (affiché 180×320), comme après une rotation par le plugin.
async function rotatedRush(name) {
  const file = video(name, "320x180");
  const fd = fs.openSync(file, "r+");
  const io = {
    size: async () => fs.fstatSync(fd).size,
    read: async (p, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return new Uint8Array(b.buffer, b.byteOffset, l); },
    write: async (p, d) => { fs.writeSync(fd, d, 0, d.length, p); },
  };
  try { await rotation.setRotation(io, 270); } finally { fs.closeSync(fd); }
  return file;
}

const uxpFs = {
  async lstat(p) { return fs.statSync(p); },
  async mkdir(p) { fs.mkdirSync(p); },
  async readFile(p) { return fs.readFileSync(p, "utf-8"); },
};
async function withFile(file, flags, fn) {
  const fd = fs.openSync(file, flags);
  const io = {
    size: async () => fs.fstatSync(fd).size,
    read: async (p, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return new Uint8Array(b.buffer, b.byteOffset, l); },
  };
  try { return await fn(io); } finally { fs.closeSync(fd); }
}

test("extensionFromPreset / splitPath", () => {
  assert.strictEqual(extensionFromPreset("<ExporterFileType>1299148630</ExporterFileType>"), ".mov"); // 'MooV'
  assert.strictEqual(extensionFromPreset("<ExporterFileType>1211250228</ExporterFileType>"), ".mp4"); // 'H264'
  assert.strictEqual(extensionFromPreset("Apple ProRes 422 Proxy"), ".mov");
  assert.strictEqual(extensionFromPreset("H.264 match source"), ".mp4");
  assert.deepStrictEqual(splitPath("D:\\Rushs\\C0001.MP4"), { dir: "D:\\Rushs", sep: "\\", base: "C0001" });
  assert.deepStrictEqual(splitPath("/Volumes/SD/C0002.mp4"), { dir: "/Volumes/SD", sep: "/", base: "C0002" });
});

test("Proxy : attaché seulement quand Media Encoder a fini, suivi conservé après rechargement", async () => {
  const preset = path.join(tmp, "vertical.epr");
  fs.writeFileSync(preset, "<ExporterFileType>1299148630</ExporterFileType>");
  const rush = await rotatedRush("C0001.MP4");

  const attached = [];
  const clip = { async attachProxy(p, hiRes) { attached.push([p, hiRes]); return true; } };
  const encodes = [];
  const ppro = {
    EncoderManager: {
      EVENT_RENDER_COMPLETE: "complete",
      getManager: () => ({ async encodeProjectItem(c, out, p, wa, rm, start) { encodes.push({ c, out, p, wa, rm, start }); return true; } }),
    },
    EventManager: { addEventListener() {} },
    Project: { async getActiveProject() { return {}; } },
  };
  let stored = [];
  const deps = {
    ppro, fs: uxpFs, rotation, withFile,
    findClipsByPaths: async (_project, paths) => new Map(paths.map((p) => [p, { name: "C0001", path: p, clip }])),
    load: () => stored, save: (list) => { stored = JSON.parse(JSON.stringify(list)); },
    setInterval: () => 1, clearInterval: () => {},
  };

  // Rush horizontal : ignoré.
  const flat = video("FLAT.MP4", "320x180");
  const logs = [];
  const queue = createProxyQueue({ ...deps, log: (m) => logs.push(m) });
  assert.strictEqual(await queue.create([{ name: "FLAT", path: flat, clip }], preset), 0);
  assert.ok(logs.some((l) => l.includes("rush horizontal")));

  const n = await queue.create([{ name: "C0001", path: rush, clip }], preset);
  assert.strictEqual(n, 1);
  const out = encodes[0].out;
  assert.strictEqual(out, path.join(tmp, "Proxies", "C0001_Proxy_Vertical.mov"));
  assert.deepStrictEqual([encodes[0].p, encodes[0].wa, encodes[0].rm, encodes[0].start], [preset, 0, true, true]);
  assert.strictEqual(stored.length, 1);

  // Encodage en cours : fichier partiel (pas de moov) -> rien n'est attaché.
  fs.writeFileSync(out, fs.readFileSync(finished).subarray(0, 200));
  await queue.check(); await queue.check();
  assert.deepStrictEqual(attached, []);

  // Rechargement du plugin pendant l'encodage : la file est reprise depuis le stockage.
  const reloaded = createProxyQueue(deps);
  reloaded.resume();
  assert.strictEqual(reloaded.pendingCount(), 1);

  // Encodage terminé : attaché après deux vérifications (taille stable).
  fs.copyFileSync(finished, out);
  await reloaded.check();
  assert.deepStrictEqual(attached, []);
  await reloaded.check();
  assert.deepStrictEqual(attached, [[out, false]]);
  assert.strictEqual(reloaded.pendingCount(), 0);
  assert.deepStrictEqual(stored, []);

  // Deuxième proxy du même rush : nouveau nom, l'ancien fichier n'est pas écrasé.
  await reloaded.create([{ name: "C0001", path: rush, clip }], preset);
  assert.strictEqual(encodes[1].out, path.join(tmp, "Proxies", "C0001_Proxy_Vertical_1.mov"));
});

test("Proxy refusé s'il est horizontal ou n'a pas la cadence du rush", async () => {
  const preset = path.join(tmp, "v2.epr");
  fs.writeFileSync(preset, "QuickTime");
  const attached = [];
  const clip = { async attachProxy(p) { attached.push(p); return true; } };
  const encodes = [];
  let stored = [];
  const logs = [];
  const queue = createProxyQueue({
    ppro: {
      EncoderManager: { getManager: () => ({ async encodeProjectItem(c, out) { encodes.push(out); return true; } }) },
      EventManager: { addEventListener() {} },
      Project: { async getActiveProject() { return {}; } },
    },
    fs: uxpFs, rotation, withFile,
    findClipsByPaths: async (_p, paths) => new Map(paths.map((p) => [p, { clip }])),
    load: () => stored, save: (l) => { stored = l; }, log: (m, level) => logs.push(`[${level}] ${m}`),
    setInterval: () => 1, clearInterval: () => {},
  });
  const a = await rotatedRush("R1.MP4");
  const b = await rotatedRush("R2.MP4");
  await queue.create([{ name: "R1", path: a, clip }, { name: "R2", path: b, clip }], preset);
  fs.copyFileSync(horizontal, encodes[0]);
  fs.copyFileSync(wrongRate, encodes[1]);
  await queue.check(); await queue.check();
  assert.deepStrictEqual(attached, []);
  assert.strictEqual(queue.pendingCount(), 0);
  assert.ok(logs.some((l) => l.startsWith("[error] R1") && l.includes("horizontal")), logs.join("\n"));
  assert.ok(logs.some((l) => l.startsWith("[error] R2") && l.includes("cadence")), logs.join("\n"));
});

test("Encodage interrompu, rush introuvable : pas de boucle coûteuse, bilan exact", async () => {
  const preset = path.join(tmp, "v3.epr");
  fs.writeFileSync(preset, "QuickTime");
  let clock = 1000000;
  const done = [];
  let lookups = 0;
  const encodes = [];
  let stored = [];
  const queue = createProxyQueue({
    ppro: {
      EncoderManager: { getManager: () => ({ async encodeProjectItem(c, out) { encodes.push(out); return true; } }) },
      EventManager: { addEventListener() {} },
      Project: { async getActiveProject() { return {}; } },
    },
    fs: uxpFs, rotation, withFile,
    findClipsByPaths: async () => { lookups++; return new Map(); }, // rush absent du projet ouvert
    load: () => stored, save: (l) => { stored = l; }, onJobDone: (job, ok) => done.push([job.name, ok]),
    setInterval: () => 1, clearInterval: () => {}, now: () => clock,
  });
  const a = await rotatedRush("S1.MP4");
  const b = await rotatedRush("S2.MP4");
  await queue.create([{ name: "S1", path: a, clip: null }, { name: "S2", path: b, clip: null }], preset);
  // S1 : encodage figé (fichier partiel qui ne bouge plus). S2 : terminé, mais rush introuvable.
  fs.writeFileSync(encodes[0], fs.readFileSync(finished).subarray(0, 300));
  fs.copyFileSync(finished, encodes[1]);
  queue.stop();
  await queue.check(); // tailles notées
  for (let i = 0; i < 20; i++) { clock += 3000; await queue.check(); } // 1 minute de vérifications
  assert.ok(lookups <= 2, `${lookups} parcours du projet en 1 min`);
  clock += 16 * 60 * 1000; await queue.check();
  assert.deepStrictEqual(done, [["S1", false]]);
  clock += 31 * 60 * 1000; await queue.check();
  assert.deepStrictEqual(done, [["S1", false], ["S2", false]]);
  assert.strictEqual(queue.pendingCount(), 0);
});

test("waitForCompleteFile : attend la fin d'écriture", async () => {
  const out = path.join(tmp, "growing.mov");
  fs.writeFileSync(out, fs.readFileSync(finished).subarray(0, 100));
  setTimeout(() => fs.copyFileSync(finished, out), 120);
  const ok = await waitForCompleteFile({ fs: uxpFs, rotation, withFile }, out, 2000, 50);
  assert.strictEqual(ok, true);
  assert.strictEqual(await waitForCompleteFile({ fs: uxpFs, rotation, withFile }, path.join(tmp, "absent.mov"), 200, 50), false);
});

test("Proxy sans préréglage : message clair", async () => {
  const queue = createProxyQueue({ ppro: {}, fs: uxpFs });
  await assert.rejects(queue.create([], ""), /préréglage/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
