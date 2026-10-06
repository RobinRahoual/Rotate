"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const rotation = require("../src/mp4rotation.js");
const { createProxyQueue, extensionFromPreset, splitPath } = require("../src/proxies.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-proxy-"));
const finished = path.join(tmp, "finished.mov");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=108x192:duration=1", "-c:v", "libx264", finished]);

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
  const rush = path.join(tmp, "C0001.MP4");
  fs.writeFileSync(rush, "x");

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

  const queue = createProxyQueue(deps);
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

test("Proxy sans préréglage : message clair", async () => {
  const queue = createProxyQueue({ ppro: {}, fs: uxpFs });
  await assert.rejects(queue.create([], ""), /préréglage/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
