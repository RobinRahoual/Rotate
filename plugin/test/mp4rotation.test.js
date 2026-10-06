/*
 * Tests du module mp4rotation avec de vrais fichiers générés par ffmpeg.
 * Lancer : node --test plugin/test/*.test.js   (nécessite ffmpeg et ffprobe dans le PATH)
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const rotation = require("../src/mp4rotation.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rotate-test-"));

function nodeIo(file) {
  const fd = fs.openSync(file, "r+");
  return {
    async size() { return fs.fstatSync(fd).size; },
    async read(position, length) {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, position);
      return new Uint8Array(buf.buffer, buf.byteOffset, length);
    },
    async write(position, bytes) { fs.writeSync(fd, bytes, 0, bytes.length, position); },
    close() { fs.closeSync(fd); },
  };
}

async function withIo(file, fn) {
  const io = nodeIo(file);
  try { return await fn(io); } finally { io.close(); }
}

function makeVideo(name, extraArgs = []) {
  const file = path.join(tmp, name);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=1",
    "-f", "lavfi", "-i", "sine=duration=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    ...extraArgs, file,
  ]);
  return file;
}

// Rotation affichée telle que vue par ffprobe (ffmpeg rotate=90 <=> displaymatrix -90).
function probeRotation(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream_side_data=rotation", "-of", "json", file,
  ]).toString();
  const sideData = (JSON.parse(out).streams[0].side_data_list || []);
  const r = sideData.length ? sideData[0].rotation : 0;
  return ((-r % 360) + 360) % 360;
}

function mediaHash(file, stream) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-map", stream, "-c", "copy", "-f", "hash", "-hash", "sha256", "-"]).toString().trim();
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

for (const [label, name, args] of [
  ["MP4 moov à la fin", "end.mp4", []],
  ["MP4 faststart (moov au début)", "start.mp4", ["-movflags", "+faststart"]],
  ["MOV", "clip.mov", []],
]) {
  test(`${label} : rotations 90/180/270/0 sans toucher aux données`, async () => {
    const file = makeVideo(name, args);
    const originalSize = fs.statSync(file).size;
    const originalVideo = mediaHash(file, "0:v");
    const originalAudio = mediaHash(file, "0:a");
    const originalFile = sha(file);

    assert.strictEqual(await withIo(file, rotation.getRotation), 0);

    for (const deg of [90, 180, 270, 0]) {
      const res = await withIo(file, (io) => rotation.setRotation(io, deg));
      assert.strictEqual(res.rotation, deg);
      assert.strictEqual(await withIo(file, rotation.getRotation), deg);
      assert.strictEqual(probeRotation(file), deg, `ffprobe doit voir ${deg}°`);
      assert.strictEqual(fs.statSync(file).size, originalSize, "taille inchangée");
      assert.strictEqual(mediaHash(file, "0:v"), originalVideo, "flux vidéo identique");
      assert.strictEqual(mediaHash(file, "0:a"), originalAudio, "flux audio identique");
    }
    // Retour à 0° = fichier identique à l'octet près à l'original.
    assert.strictEqual(sha(file), originalFile);
  });
}

test("90° : l'image décodée devient verticale (180x320)", async () => {
  const file = makeVideo("portrait.mp4");
  await withIo(file, (io) => rotation.setRotation(io, 90));
  const rotatedPng = path.join(tmp, "frame.png");
  execFileSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-frames:v", "1", rotatedPng]);
  const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", rotatedPng]).toString().trim();
  assert.strictEqual(out, "180,320");
});

test("Appliquer deux fois la même rotation ne change rien la 2e fois", async () => {
  const file = makeVideo("twice.mp4");
  const first = await withIo(file, (io) => rotation.setRotation(io, 90));
  const second = await withIo(file, (io) => rotation.setRotation(io, 90));
  assert.strictEqual(first.changed, true);
  assert.strictEqual(second.changed, false);
});

test("Fichier qui n'est pas un MP4 : erreur claire, fichier intact", async () => {
  const file = path.join(tmp, "fake.mp4");
  fs.writeFileSync(file, "ceci n'est pas une vidéo, juste du texte assez long");
  const before = sha(file);
  await assert.rejects(withIo(file, (io) => rotation.setRotation(io, 90)));
  assert.strictEqual(sha(file), before);
});

test("isSupportedPath", () => {
  assert.ok(rotation.isSupportedPath("C:\\Rushs\\C0001.MP4"));
  assert.ok(rotation.isSupportedPath("/Volumes/SD/clip.mov"));
  assert.ok(!rotation.isSupportedPath("/Volumes/SD/clip.mxf"));
});

test("Lecture minimale : quelques centaines d'octets lus, quelle que soit la durée du rush", async () => {
  const file = makeVideo("long.mp4");
  let bytesRead = 0;
  let reads = 0;
  const io = nodeIo(file);
  const counting = {
    size: io.size,
    read: async (p, l) => { reads++; bytesRead += l; return io.read(p, l); },
    write: io.write,
  };
  try {
    const plan = await rotation.planRotation(counting, 90);
    assert.strictEqual(plan.writes.length, 1);
    assert.strictEqual(plan.writes[0].bytes.length, 36);
  } finally { io.close(); }
  assert.ok(bytesRead < 2048, `${bytesRead} octets lus en ${reads} lectures`);
});

test("planRotation ne modifie jamais le fichier", async () => {
  const file = makeVideo("plan.mp4");
  const before = sha(file);
  await withIo(file, (io) => rotation.planRotation(io, 270));
  assert.strictEqual(sha(file), before);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
