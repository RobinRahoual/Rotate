"use strict";

const test = require("node:test");
const assert = require("node:assert");
const settings = require("../src/settings.js");

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

test("Sans préférence enregistrée : -90° (270) par défaut", () => {
  assert.strictEqual(settings.getDefaultRotation(memoryStorage()), 270);
});

test("Le sens choisi est conservé", () => {
  const storage = memoryStorage();
  settings.setDefaultRotation(storage, 90);
  assert.strictEqual(settings.getDefaultRotation(storage), 90);
  settings.setDefaultRotation(storage, 180);
  assert.strictEqual(settings.getDefaultRotation(storage), 180);
});

test("Valeur invalide refusée / valeur corrompue ignorée", () => {
  const storage = memoryStorage();
  assert.throws(() => settings.setDefaultRotation(storage, 0));
  storage.setItem("rotate.defaultRotation", "n'importe quoi");
  assert.strictEqual(settings.getDefaultRotation(storage), 270);
});

test("Stockage indisponible : pas de plantage", () => {
  const broken = { getItem() { throw new Error("x"); }, setItem() { throw new Error("x"); } };
  assert.strictEqual(settings.getDefaultRotation(broken), 270);
  assert.strictEqual(settings.setDefaultRotation(broken, 90), 90);
});

test("Libellés", () => {
  assert.strictEqual(settings.rotationLabel(270), "↺ -90°");
  assert.strictEqual(settings.rotationLabel(90), "↻ +90°");
});

test("Historique : 10 opérations max, taille plafonnée, dernière opération toujours gardée", () => {
  const storage = memoryStorage();
  const op = (n, files) => ({ date: n, rotation: 270, files: Array.from({ length: files }, (_, i) => ({ path: `/r/${n}/${i}.MP4`, name: `${i}`, changes: [] })) });
  for (let n = 1; n <= 12; n++) settings.pushHistory(storage, op(n, 1));
  assert.strictEqual(JSON.parse(storage.getItem("rotate.history")).length, settings.MAX_HISTORY);
  assert.strictEqual(settings.lastHistory(storage).date, 12);
  // Une énorme opération fait sortir les anciennes, mais reste annulable.
  settings.pushHistory(storage, op(13, 20000));
  assert.ok(storage.getItem("rotate.history").length <= settings.MAX_HISTORY_CHARS || JSON.parse(storage.getItem("rotate.history")).length === 1);
  assert.strictEqual(settings.lastHistory(storage).date, 13);
  assert.strictEqual(settings.popHistory(storage).date, 13);
  settings.pushHistory(storage, op(15, 1));
  settings.pushHistory(storage, { date: 14, rotation: 0, files: [] }); // vide : ignorée
  assert.strictEqual(settings.lastHistory(storage).date, 15);
});
