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
