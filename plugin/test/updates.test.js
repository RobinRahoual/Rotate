"use strict";

const test = require("node:test");
const assert = require("node:assert");
const updates = require("../src/updates.js");

function memoryStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

const RELEASE = {
  tag_name: "v0.9.0",
  html_url: "https://github.com/RobinRahoual/Rotate/releases/tag/v0.9.0",
  assets: [
    { name: "Rotate-0.9.0.ccx", browser_download_url: "https://example/Rotate-0.9.0.ccx" },
    { name: "Rotate-0.9.0-installation.zip", browser_download_url: "https://example/Rotate-0.9.0-installation.zip" },
  ],
};

function fakeFetch(release, calls) {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => release };
  };
}

test("compareVersions", () => {
  assert.strictEqual(updates.compareVersions("0.9.0", "0.8.0"), 1);
  assert.strictEqual(updates.compareVersions("v0.8.0", "0.8.0"), 0);
  assert.strictEqual(updates.compareVersions("0.8.10", "0.8.9"), 1);
  assert.strictEqual(updates.compareVersions("1.0.0", "0.99.99"), 1);
  assert.strictEqual(updates.compareVersions("0.7.2", "0.8.0"), -1);
});

test("Nouvelle version détectée, pack d'installation proposé en priorité", async () => {
  const calls = [];
  const res = await updates.checkForUpdate({ fetch: fakeFetch(RELEASE, calls), storage: memoryStorage(), currentVersion: "0.8.0" });
  assert.deepStrictEqual(res, {
    version: "0.9.0",
    pageUrl: RELEASE.html_url,
    downloadUrl: "https://example/Rotate-0.9.0-installation.zip",
  });
  assert.deepStrictEqual(calls, [updates.API_URL]);
});

test("Déjà à jour, ou version plus ancienne publiée : rien", async () => {
  const calls = [];
  assert.strictEqual(await updates.checkForUpdate({ fetch: fakeFetch(RELEASE, calls), storage: memoryStorage(), currentVersion: "0.9.0" }), null);
  assert.strictEqual(await updates.checkForUpdate({ fetch: fakeFetch(RELEASE, calls), storage: memoryStorage(), currentVersion: "1.0.0" }), null);
});

test("Une seule requête GitHub toutes les 6 h ; « Vérifier maintenant » force", async () => {
  const storage = memoryStorage();
  const calls = [];
  let clock = 1000;
  const deps = { fetch: fakeFetch(RELEASE, calls), storage, currentVersion: "0.8.0", now: () => clock };
  await updates.checkForUpdate(deps);
  clock += 60 * 60 * 1000;
  const cached = await updates.checkForUpdate(deps);
  assert.strictEqual(cached.version, "0.9.0"); // résultat mémorisé, sans requête
  assert.strictEqual(calls.length, 1);
  clock += updates.CHECK_EVERY_MS;
  await updates.checkForUpdate(deps);
  assert.strictEqual(calls.length, 2);
  await updates.checkForUpdate({ ...deps, force: true });
  assert.strictEqual(calls.length, 3);
});

test("« Plus tard » masque cette version, pas la suivante", async () => {
  const storage = memoryStorage();
  const calls = [];
  const deps = { fetch: fakeFetch(RELEASE, calls), storage, currentVersion: "0.8.0", force: true };
  updates.dismissUpdate(storage, "0.9.0");
  assert.strictEqual(await updates.checkForUpdate({ ...deps, force: false }), null);
  assert.strictEqual((await updates.checkForUpdate(deps)).version, "0.9.0"); // vérification manuelle : affichée quand même
  const next = { ...RELEASE, tag_name: "v0.10.0" };
  assert.strictEqual((await updates.checkForUpdate({ ...deps, fetch: fakeFetch(next, calls), force: false, now: () => Date.now() + 1e9 })).version, "0.10.0");
});

test("Pas de réseau, dépôt privé, réponse invalide : aucune erreur, pas de bandeau", async () => {
  const storage = memoryStorage();
  const failing = async () => { throw new Error("offline"); };
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const garbage = async () => ({ ok: true, json: async () => ({ message: "?" }) });
  for (const fetch of [failing, notFound, garbage]) {
    assert.strictEqual(await updates.checkForUpdate({ fetch, storage, currentVersion: "0.8.0", force: true }), null);
  }
});
