"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cleanup = require("../src/cleanup.js");

const uxpFs = {
  readdir: async (p) => fs.readdirSync(p),
  lstat: async (p) => fs.statSync(p),
  unlink: async (p) => fs.unlinkSync(p),
};

test("Proxys utilisés / inutilisés, suppression des seuls fichiers choisis", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-clean-"));
  const day1 = path.join(tmp, "Jour1");
  const other = path.join(tmp, "Ailleurs", "Proxies");
  fs.mkdirSync(path.join(day1, "Proxies"), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const write = (p, n) => { fs.writeFileSync(p, Buffer.alloc(n)); return p; };
  const rush = write(path.join(day1, "C0001.MP4"), 10);
  const used = write(path.join(day1, "Proxies", "C0001_Proxy_Vertical.mov"), 3000);
  const old = write(path.join(day1, "Proxies", "C0001_Proxy_Vertical_1.mov"), 2000);
  const foreign = write(path.join(day1, "Proxies", "C0001_Proxy.mov"), 500); // proxy Premiere, pas à nous
  const known = write(path.join(other, "C0099_Proxy_Vertical.mp4"), 1000);

  const media = [{ path: rush, proxyPath: used }, { path: path.join(tmp, "absent", "X.MP4"), proxyPath: "" }];
  const res = await cleanup.scanProxies({ fs: uxpFs }, media, [known]);
  assert.deepStrictEqual(res.inUse.map((f) => f.path), [used]);
  assert.deepStrictEqual(res.unused.map((f) => f.path).sort(), [old, known].sort());
  assert.strictEqual(cleanup.totalBytes(res.unused), 3000);

  const del = await cleanup.deleteFiles({ fs: uxpFs }, [old]);
  assert.deepStrictEqual(del, { deleted: [old], failed: [] });
  assert.ok(!fs.existsSync(old) && fs.existsSync(used) && fs.existsSync(foreign) && fs.existsSync(known));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("formatBytes", () => {
  assert.strictEqual(cleanup.formatBytes(500), "1 Ko");
  assert.strictEqual(cleanup.formatBytes(250 * 1024 * 1024), "250 Mo");
  assert.strictEqual(cleanup.formatBytes(3.46 * 1024 ** 3), "3,5 Go");
});
