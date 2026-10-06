/*
 * Nettoyage des proxys créés par Rotate : repère les fichiers de proxys
 * verticaux (dossiers « Proxies » à côté des rushs) et distingue ceux qui sont
 * attachés à un clip du projet ouvert de ceux qui ne servent plus.
 */

"use strict";

const { splitPath, PROXY_FOLDER } = require("./proxies.js");

const PROXY_FILE = /_Proxy_Vertical(?:_\d+)?\.(?:mov|mp4|mxf)$/i;

function normalize(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1).replace(".", ",")} Go`;
}

/*
 * deps : { fs }
 * media : [{ path, proxyPath }] — tous les clips du projet (proxyPath vide si aucun)
 * known : chemins de proxys créés par le plugin (registre), éventuellement ailleurs
 * Retourne { inUse: [{ path, bytes }], unused: [{ path, bytes }] }.
 */
async function scanProxies(deps, media, known = []) {
  const attached = new Set(media.filter((m) => m.proxyPath).map((m) => normalize(m.proxyPath)));

  // Dossiers « Proxies » à côté des rushs du projet et des proxys connus.
  const folders = new Map();
  for (const m of media) {
    if (!m.path) continue;
    const { dir, sep } = splitPath(m.path);
    if (dir) folders.set(normalize(`${dir}${sep}${PROXY_FOLDER}`), `${dir}${sep}${PROXY_FOLDER}`);
  }
  for (const p of known) {
    const { dir } = splitPath(p);
    if (dir) folders.set(normalize(dir), dir);
  }

  const files = new Map();
  for (const folder of folders.values()) {
    let names = [];
    try {
      names = await deps.fs.readdir(folder);
    } catch (e) {
      continue; // dossier absent
    }
    const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
    for (const name of names) {
      if (!PROXY_FILE.test(name)) continue;
      const path = `${folder}${sep}${name}`;
      files.set(normalize(path), path);
    }
  }

  const inUse = [];
  const unused = [];
  for (const [key, path] of files) {
    let bytes = 0;
    try {
      bytes = (await deps.fs.lstat(path)).size;
    } catch (e) {
      continue;
    }
    (attached.has(key) ? inUse : unused).push({ path, bytes });
  }
  const byPath = (a, b) => a.path.localeCompare(b.path);
  return { inUse: inUse.sort(byPath), unused: unused.sort(byPath) };
}

function totalBytes(list) {
  return list.reduce((n, f) => n + f.bytes, 0);
}

/* Supprime les fichiers ; renvoie { deleted: [...chemins], failed: [...chemins] }. */
async function deleteFiles(deps, paths) {
  const deleted = [];
  const failed = [];
  for (const path of paths) {
    try {
      await deps.fs.unlink(path);
      deleted.push(path);
    } catch (e) {
      failed.push(path);
    }
  }
  return { deleted, failed };
}

module.exports = { scanProxies, deleteFiles, formatBytes, totalBytes, PROXY_FILE };
