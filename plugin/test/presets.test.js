"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const rotation = require("../src/mp4rotation.js");
const presets = require("../src/presets.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-presets-"));

function param(id, value, optional, enabled) {
  return `<ExporterParam ObjectID="1" ClassID="x" Version="1">
		<ParamIdentifier>${id}</ParamIdentifier>
		<IsOptionalParamEnabled>${enabled}</IsOptionalParamEnabled>
		<IsOptionalParam>${optional}</IsOptionalParam>
		<ParamValue>${value}</ParamValue>
	</ExporterParam>`;
}

// Modèle imitant un préréglage « Apple ProRes 422 Proxy » (taille identique à la source).
const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
	<PresetID>00000000-0000-0000-0000-000000000000</PresetID>
	<PresetName>Apple ProRes 422 Proxy</PresetName>
	${param("ADBEVideoWidth", 1920, true, true)}
	${param("ADBEVideoHeight", 1080, true, true)}
	${param("ADBEVideoFPS", 10160640000, true, true)}
	${param("ADBEVideoCodec", 1634755443, false, false)}
</PremiereData>`;

// Arborescence imitant C:\Program Files\Adobe sur Windows.
function makeInstall(templateBytes) {
  const base = path.join(tmp, `install-${Math.random().toString(36).slice(2)}`);
  const qt = path.join(base, "Adobe Media Encoder 2026", "MediaIO", "systempresets", "4D6F6F56_4D6F6F56");
  const h264 = path.join(base, "Adobe Media Encoder 2026", "MediaIO", "systempresets", "4E49434B_48323634");
  fs.mkdirSync(qt, { recursive: true });
  fs.mkdirSync(h264, { recursive: true });
  fs.writeFileSync(path.join(qt, "Apple ProRes 422 Proxy.epr"), templateBytes);
  fs.writeFileSync(path.join(qt, "Apple ProRes 422 HQ.epr"), "x");
  fs.writeFileSync(path.join(h264, "Match Source - High bitrate.epr"), "x");
  fs.mkdirSync(path.join(base, "Adobe Photoshop 2026"));
  return base;
}

// fs façon UXP, chemins Windows simulés vers le dossier temporaire.
function fakeFs(base) {
  const map = (p) => p.replace("C:\\Program Files\\Adobe", base).replace(/\\/g, "/");
  return {
    readdir: async (p) => fs.readdirSync(map(p)),
    readFile: async (p) => { const b = fs.readFileSync(map(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
    writeFile: async (p, data) => fs.writeFileSync(map(p), data),
    unlink: async (p) => fs.unlinkSync(map(p)),
    map,
  };
}

async function withFile(file, flags, fn) {
  const fd = fs.openSync(file, flags);
  const io = {
    size: async () => fs.fstatSync(fd).size,
    read: async (p, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, p); return new Uint8Array(b.buffer, b.byteOffset, l); },
  };
  try { return await fn(io); } finally { fs.closeSync(fd); }
}

/*
 * Faux Media Encoder : applique la taille seulement si la case vaut `customWhen`
 * (on ne connaît pas la convention réelle : le plugin doit trouver la bonne).
 */
function fakeEncoder(xfs, customWhen, fpsCustomWhen = null) {
  const calls = [];
  return {
    calls,
    encodeTest: async (input, output, preset) => {
      const xml = fs.readFileSync(xfs.map(preset), "utf8");
      const p = (id) => new RegExp(`<ParamIdentifier>${id}</ParamIdentifier>\\s*<IsOptionalParamEnabled>(\\w+)</IsOptionalParamEnabled>[\\s\\S]*?<ParamValue>(\\d+)</ParamValue>`).exec(xml);
      const [, wFlag, w] = p("ADBEVideoWidth");
      const [, , h] = p("ADBEVideoHeight");
      const [, fFlag] = p("ADBEVideoFPS");
      const size = wFlag === String(customWhen) ? `${w}x${h}` : "320x180";
      const rate = fpsCustomWhen !== null && fFlag === String(fpsCustomWhen) ? "30" : "25";
      calls.push({ size, rate });
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=${rate}:duration=0.2`, "-c:v", "libx264", xfs.map(output)]);
      return true;
    },
    waitForFile: async (p) => fs.existsSync(xfs.map(p)),
  };
}

function deps(base, encoder) {
  const xfs = fakeFs(base);
  fs.mkdirSync(path.join(base, "data"), { recursive: true });
  return {
    fs: xfs, platform: "win32", dataFolder: "C:\\Program Files\\Adobe\\data", calibrationFile: "calibration.mp4",
    rotation, withFile: (p, f, fn) => withFile(xfs.map(p), f, fn), ...encoder,
  };
}

test("Choix du modèle : ProRes 422 Proxy en priorité", async () => {
  const base = makeInstall(TEMPLATE);
  const found = await presets.findTemplates(fakeFs(base), "win32");
  assert.deepStrictEqual(found.map((t) => t.name), ["Apple ProRes 422 Proxy", "Match Source - High bitrate"]);
  assert.strictEqual(presets.scorePreset("x_4D6F6F56", "Apple ProRes 422 HQ.epr"), 0);
});

for (const customWhen of [false, true]) {
  test(`Préréglage créé et vérifié (convention de la case : ${customWhen})`, async () => {
    const base = makeInstall(zlib.gzipSync(TEMPLATE)); // modèle compressé en gzip
    const xfs = fakeFs(base);
    const enc = fakeEncoder(xfs, customWhen);
    const result = await presets.createVerticalPreset(deps(base, enc), "720x1280");
    assert.strictEqual(result.template, "Apple ProRes 422 Proxy");
    assert.strictEqual(enc.calls[enc.calls.length - 1].size, "720x1280");
    const xml = fs.readFileSync(xfs.map(result.path), "utf8");
    assert.match(xml, /<PresetName>Rotate - Proxy vertical 720x1280<\/PresetName>/);
    assert.doesNotMatch(xml, /00000000-0000-0000-0000-000000000000/);
    // Fichiers de test supprimés.
    assert.deepStrictEqual(fs.readdirSync(path.join(base, "data")).filter((f) => f.includes("test")), []);
  });
}

test("Cadence forcée par le modèle : la case de la cadence est corrigée", async () => {
  const base = makeInstall(TEMPLATE);
  const xfs = fakeFs(base);
  // Faux encodeur : taille personnalisée si case=false ; cadence 30 i/s tant que la case de cadence n'est pas « true ».
  const enc = fakeEncoder(xfs, false, null);
  const original = enc.encodeTest;
  enc.encodeTest = async (i, o, p) => {
    const xml = fs.readFileSync(xfs.map(p), "utf8");
    const fpsFlag = /<ParamIdentifier>ADBEVideoFPS<\/ParamIdentifier>\s*<IsOptionalParamEnabled>(\w+)/.exec(xml)[1];
    await original(i, o, p);
    if (fpsFlag !== "false") execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=720x1280:rate=30:duration=0.2", "-c:v", "libx264", xfs.map(o)]);
    return true;
  };
  const result = await presets.createVerticalPreset(deps(base, enc), "720x1280");
  assert.match(fs.readFileSync(xfs.map(result.path), "utf8"), /ADBEVideoFPS<\/ParamIdentifier>\s*<IsOptionalParamEnabled>false/);
});

test("Aucun Media Encoder installé : message clair", async () => {
  const base = path.join(tmp, "vide");
  fs.mkdirSync(base);
  await assert.rejects(presets.createVerticalPreset(deps(base, fakeEncoder(fakeFs(base), false)), "720x1280"), /Aucun préréglage/);
});

test("Le faux encodeur ne sait jamais réduire : échec explicite avec le détail des essais", async () => {
  const base = makeInstall(TEMPLATE);
  const enc = fakeEncoder(fakeFs(base), "jamais");
  await assert.rejects(presets.createVerticalPreset(deps(base, enc), "720x1280"), /320×180/);
});

test("Media Encoder ne produit rien : arrêt immédiat, pas 24 essais", async () => {
  const base = makeInstall(TEMPLATE);
  let calls = 0;
  const enc = { encodeTest: async () => { calls++; return true; }, waitForFile: async () => false };
  await assert.rejects(presets.createVerticalPreset(deps(base, enc), "720x1280"), /aucun fichier test/);
  assert.strictEqual(calls, 1);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
