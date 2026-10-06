/*
 * Intégration Premiere Pro : récupère les rushs sélectionnés dans le panneau
 * Projet (y compris le contenu des chutiers sélectionnés), modifie la rotation
 * de leur fichier source puis demande à Premiere de relire le média.
 *
 * Pour ménager Premiere :
 *   - on fait le minimum d'appels à l'API (1 seul par clip pour la collecte) ;
 *   - un fichier déjà dans le bon sens n'est ni ouvert en écriture ni actualisé ;
 *   - chaque fichier n'est actualisé qu'une fois, même s'il apparaît plusieurs
 *     fois dans le projet ;
 *   - les actualisations sont faites une par une, avec une courte pause entre
 *     chaque, pour laisser Premiere respirer (lecture, interface).
 */

"use strict";

const ppro = require("premierepro");
const fs = require("fs");
const rotation = require("./mp4rotation.js");

// Nombre d'appels simultanés à Premiere pendant la collecte des chemins.
const COLLECT_CONCURRENCY = 8;
// Pause entre deux actualisations de média (ms).
const REFRESH_PAUSE_MS = 30;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Adaptateur fichier (API fs de UXP) attendu par mp4rotation.js. */
async function openFile(path, flags) {
  const fd = await fs.open(path, flags);
  let size = null;
  return {
    async size() {
      if (size === null) size = (await fs.lstat(path)).size;
      return size;
    },
    async read(position, length) {
      const buffer = new ArrayBuffer(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await fs.read(fd, buffer, done, length - done, position + done);
        if (!bytesRead) throw new Error("Fin de fichier inattendue.");
        done += bytesRead;
      }
      return new Uint8Array(buffer);
    },
    async write(position, bytes) {
      let done = 0;
      while (done < bytes.length) {
        const { bytesWritten } = await fs.write(fd, bytes.buffer, bytes.byteOffset + done, bytes.length - done, position + done);
        if (!bytesWritten) throw new Error("Écriture impossible.");
        done += bytesWritten;
      }
    },
    async close() {
      await fs.close(fd);
    },
  };
}

async function withFile(path, flags, callback) {
  const io = await openFile(path, flags);
  try {
    return await callback(io);
  } finally {
    await io.close();
  }
}

/* Exécute fn sur chaque élément, au plus `limit` à la fois, en gardant l'ordre. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

function isMissingFileError(e) {
  return /ENOENT|not found|no such file|introuvable/i.test(errorMessage(e));
}

function isLockedFileError(e) {
  return /EBUSY|EPERM|EACCES|lock|busy|denied|sharing/i.test(errorMessage(e));
}

/*
 * Parcourt la sélection (et les chutiers, récursivement).
 * Retourne { project, clips: [{ name, path, clip }], skipped: [{ name, reason }], duplicates }.
 * Un seul élément est gardé par fichier source.
 */
async function collectSelectedClips() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Aucun projet ouvert.");
  const selection = await ppro.ProjectUtils.getSelection(project);
  const selected = selection ? await selection.getItems() : [];
  if (!selected.length) throw new Error("Sélectionne des rushs ou un chutier dans le panneau Projet.");

  const clips = [];
  const skipped = [];
  const seenPaths = new Set();
  const visitedBins = new Set();
  let duplicates = 0;

  async function visit(items) {
    const clipItems = [];
    const bins = [];
    for (const item of items) {
      if (item.type === ppro.ProjectItem.TYPE_BIN || item.type === ppro.ProjectItem.TYPE_ROOT) bins.push(item);
      else if (item.type === ppro.ProjectItem.TYPE_CLIP) clipItems.push(item);
    }

    const resolved = await mapLimit(clipItems, COLLECT_CONCURRENCY, async (item) => {
      const clip = ppro.ClipProjectItem.cast(item);
      let path = "";
      try {
        path = clip ? await clip.getMediaFilePath() : "";
      } catch (e) {
        path = "";
      }
      return { name: item.name, path, clip };
    });

    for (const entry of resolved) {
      if (!entry.path) continue; // séquences, multicam, éléments sans fichier
      if (!rotation.isSupportedPath(entry.path)) {
        skipped.push({ name: entry.name, reason: "format non pris en charge (MP4/MOV uniquement)" });
        continue;
      }
      // Plusieurs éléments du projet (sous-clips, doublons) peuvent pointer vers le même fichier.
      if (seenPaths.has(entry.path)) {
        duplicates++;
        continue;
      }
      seenPaths.add(entry.path);
      clips.push(entry);
    }

    for (const bin of bins) {
      // Un chutier peut être sélectionné en même temps que son parent.
      const id = typeof bin.getId === "function" ? bin.getId() : null;
      if (id) {
        if (visitedBins.has(id)) continue;
        visitedBins.add(id);
      }
      await visit(await ppro.FolderItem.cast(bin).getItems());
    }
  }

  await visit(selected);
  return { project, clips, skipped, duplicates };
}

/* Met le clip hors ligne (libère le fichier côté Premiere, utile sous Windows). */
function setOffline(project, clip) {
  project.lockedAccess(() => {
    const action = clip.createSetOfflineAction();
    project.executeTransaction((compound) => compound.addAction(action), "Rotate : mise hors ligne");
  });
}

/*
 * Écrit la nouvelle rotation dans le fichier.
 * Retourne { previous, changed, relinked } ; `relinked` indique que le clip a
 * déjà été re-lié (et donc relu) par Premiere.
 */
async function writeRotation(project, entry, degrees) {
  // 1. Lecture seule : on ne touche pas au fichier s'il est déjà dans le bon sens.
  const plan = await withFile(entry.path, "r", (io) => rotation.planRotation(io, degrees));
  if (!plan.writes.length) return { previous: plan.previous, changed: false, relinked: false };

  // 2. Écriture des quelques octets de la matrice.
  try {
    await withFile(entry.path, "r+", (io) => rotation.applyPlan(io, plan));
    return { previous: plan.previous, changed: true, relinked: false };
  } catch (e) {
    if (!isLockedFileError(e)) throw e;
  }
  // 3. Fichier verrouillé par Premiere : on le met hors ligne, on écrit, puis on le re-lie.
  setOffline(project, entry.clip);
  await withFile(entry.path, "r+", (io) => rotation.applyPlan(io, plan));
  const relinked = await entry.clip.changeMediaFilePath(entry.path, true);
  if (!relinked) throw new Error("fichier modifié mais impossible de le re-lier : clic droit > Lier le média");
  return { previous: plan.previous, changed: true, relinked: true };
}

async function refreshMedia(entry) {
  try {
    return await entry.clip.refreshMedia();
  } catch (e) {
    return false;
  }
}

/*
 * Applique la rotation `degrees` (0, 90, 180, 270 - sens horaire) à tous les
 * rushs sélectionnés.
 *
 * options :
 *   log(message, level)             messages (level : info | ok | warn | error)
 *   onProgress(done, total, name)   avancement
 *   isCancelled()                   true pour arrêter proprement entre deux clips
 *
 * Retourne { done, unchanged, failed, cancelled, timings: { collect, files, refresh } } (ms).
 */
async function rotateSelection(degrees, options = {}) {
  const log = options.log || (() => {});
  const onProgress = options.onProgress || (() => {});
  const isCancelled = options.isCancelled || (() => false);
  const timings = { collect: 0, files: 0, refresh: 0 };
  const result = { done: 0, unchanged: 0, failed: 0, cancelled: false, timings };

  let t = Date.now();
  const { project, clips, skipped, duplicates } = await collectSelectedClips();
  timings.collect = Date.now() - t;

  skipped.forEach((s) => log(`${s.name} : ignoré (${s.reason})`, "warn"));
  if (duplicates) log(`${duplicates} élément(s) partagent un fichier déjà traité (sous-clips, doublons).`, "info");
  if (!clips.length) {
    log("Aucun rush MP4/MOV à traiter dans la sélection.", "warn");
    return result;
  }

  for (let i = 0; i < clips.length; i++) {
    const entry = clips[i];
    if (isCancelled()) {
      result.cancelled = true;
      break;
    }
    onProgress(i, clips.length, entry.name);
    try {
      t = Date.now();
      const written = await writeRotation(project, entry, degrees);
      timings.files += Date.now() - t;

      if (!written.changed) {
        result.unchanged++;
        continue;
      }

      let refreshed = written.relinked;
      if (!refreshed) {
        t = Date.now();
        refreshed = await refreshMedia(entry);
        timings.refresh += Date.now() - t;
      }
      result.done++;
      if (refreshed) {
        log(`${entry.name} : ${written.previous ?? "?"}° → ${degrees}°`, "ok");
      } else {
        log(`${entry.name} : fichier tourné, mais Premiere ne l'a pas actualisé (clic droit > Actualiser le média)`, "warn");
      }
      if (i < clips.length - 1) await pause(REFRESH_PAUSE_MS);
    } catch (e) {
      result.failed++;
      const reason = isMissingFileError(e) ? "fichier introuvable (média hors ligne ?)" : errorMessage(e);
      log(`${entry.name} : échec - ${reason}`, "error");
    }
  }
  onProgress(result.cancelled ? result.done + result.unchanged + result.failed : clips.length, clips.length, "");
  return result;
}

module.exports = { rotateSelection, collectSelectedClips, mapLimit };
