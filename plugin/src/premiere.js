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
const { rotationLabel } = require("./settings.js");

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
async function collectSelectedClips(onFound = () => {}) {
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
      onFound(clips.length);
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

/* Retrouve les clips du projet qui pointent vers `paths` (pour l'annulation et les proxys). */
async function findClipsByPaths(project, paths) {
  const wanted = new Set(paths);
  const found = new Map();
  async function visit(items) {
    const clipItems = [];
    const bins = [];
    for (const item of items) {
      if (item.type === ppro.ProjectItem.TYPE_BIN || item.type === ppro.ProjectItem.TYPE_ROOT) bins.push(item);
      else if (item.type === ppro.ProjectItem.TYPE_CLIP) clipItems.push(item);
    }
    await mapLimit(clipItems, COLLECT_CONCURRENCY, async (item) => {
      const clip = ppro.ClipProjectItem.cast(item);
      let path = "";
      try {
        path = clip ? await clip.getMediaFilePath() : "";
      } catch (e) {
        path = "";
      }
      if (wanted.has(path) && !found.has(path)) found.set(path, { name: item.name, path, clip });
    });
    for (const bin of bins) {
      if (found.size === wanted.size) return;
      await visit(await ppro.FolderItem.cast(bin).getItems());
    }
  }
  await visit([await project.getRootItem()]);
  return found;
}

/* Met le clip hors ligne (libère le fichier côté Premiere, utile sous Windows). */
function setOffline(project, clip) {
  project.lockedAccess(() => {
    const action = clip.createSetOfflineAction();
    project.executeTransaction((compound) => compound.addAction(action), "Rotate : mise hors ligne");
  });
}

/*
 * Écrit dans le fichier avec `writeFn(io)`. Si Premiere verrouille le fichier
 * (Windows), on met le clip hors ligne, on écrit, puis on le re-lie.
 * Retourne true si le clip a déjà été re-lié (donc relu) par Premiere.
 */
async function writeFile(project, entry, writeFn) {
  try {
    await withFile(entry.path, "r+", writeFn);
    return false;
  } catch (e) {
    if (!isLockedFileError(e)) throw e;
  }
  setOffline(project, entry.clip);
  await withFile(entry.path, "r+", writeFn);
  const relinked = await entry.clip.changeMediaFilePath(entry.path, true);
  if (!relinked) throw new Error("fichier modifié mais impossible de le re-lier : clic droit > Lier le média");
  return true;
}

async function refreshMedia(entry) {
  try {
    return await entry.clip.refreshMedia();
  } catch (e) {
    return false;
  }
}

function describeError(e) {
  return isMissingFileError(e) ? "fichier introuvable (média hors ligne ?)" : errorMessage(e);
}

/*
 * Étape 1 (lecture seule) : pour chaque clip, lit la rotation actuelle et
 * prépare les écritures. Retourne [{ entry, status, previous, plan, error }]
 * avec status = "todo" | "unchanged" | "error".
 */
async function inspectClips(clips, degrees, onProgress = () => {}) {
  let done = 0;
  return mapLimit(clips, 4, async (entry) => {
    onProgress(done++, clips.length, entry.name);
    try {
      const plan = await withFile(entry.path, "r", (io) => rotation.planRotation(io, degrees));
      return { entry, status: plan.writes.length ? "todo" : "unchanged", previous: plan.previous, plan };
    } catch (e) {
      return { entry, status: "error", previous: null, plan: null, error: describeError(e) };
    }
  });
}

/*
 * Étape 2 : écrit les rotations préparées puis actualise chaque clip dans Premiere.
 * Retourne { done, failed, cancelled, timings, operation } ; `operation` est
 * l'entrée d'historique permettant d'annuler.
 */
async function applyRotations(project, items, degrees, options = {}) {
  const log = options.log || (() => {});
  const onProgress = options.onProgress || (() => {});
  const isCancelled = options.isCancelled || (() => false);
  const result = { done: 0, failed: 0, cancelled: false, timings: { files: 0, refresh: 0 } };
  const operation = { date: Date.now(), rotation: degrees, files: [] };
  const todo = items.filter((i) => i.status === "todo");

  for (let i = 0; i < todo.length; i++) {
    const { entry } = todo[i];
    if (isCancelled()) {
      result.cancelled = true;
      break;
    }
    onProgress(i, todo.length, entry.name);
    try {
      let t = Date.now();
      // Le fichier a pu changer depuis l'aperçu : on revérifie juste avant d'écrire.
      const fresh = await withFile(entry.path, "r", (io) => rotation.planRotation(io, degrees));
      if (!fresh.writes.length) continue;
      const relinked = await writeFile(project, entry, (io) => rotation.applyPlan(io, fresh));
      result.timings.files += Date.now() - t;
      operation.files.push({
        path: entry.path,
        name: entry.name,
        changes: fresh.writes.map((w) => ({ position: w.position, before: w.before, after: rotation.toHex(w.bytes) })),
      });

      let refreshed = relinked;
      if (!refreshed) {
        t = Date.now();
        refreshed = await refreshMedia(entry);
        result.timings.refresh += Date.now() - t;
      }
      result.done++;
      if (refreshed) {
        log(`${entry.name} : ${rotationLabel(fresh.previous)} → ${rotationLabel(degrees)}`, "ok");
      } else {
        log(`${entry.name} : fichier tourné, mais Premiere ne l'a pas actualisé (clic droit > Actualiser le média)`, "warn");
      }
      if (i < todo.length - 1) await pause(REFRESH_PAUSE_MS);
    } catch (e) {
      result.failed++;
      log(`${entry.name} : échec - ${describeError(e)}`, "error");
    }
  }
  onProgress(todo.length, todo.length, "");
  result.operation = operation;
  return result;
}

/*
 * Enchaîne collecte + inspection + (confirmation) + écriture.
 *
 * options :
 *   log(message, level)             messages (level : info | ok | warn | error)
 *   onProgress(done, total, name)   avancement
 *   isCancelled()                   true pour arrêter proprement entre deux clips
 *   confirm(items)                  aperçu : renvoie les éléments à traiter, ou null pour abandonner
 *   onPhase(phase)                  étape en cours : "collect" | "inspect" | "apply"
 *
 * Retourne { done, unchanged, failed, cancelled, aborted, timings, operation, items }.
 */
async function rotateSelection(degrees, options = {}) {
  const log = options.log || (() => {});
  const onPhase = options.onPhase || (() => {});
  const onProgress = options.onProgress || (() => {});
  let t = Date.now();
  onPhase("collect");
  const { project, clips, skipped, duplicates } = await collectSelectedClips((n) => onProgress(n, 0, ""));
  const timings = { collect: Date.now() - t, files: 0, refresh: 0 };

  skipped.forEach((s) => log(`${s.name} : ignoré (${s.reason})`, "warn"));
  if (duplicates) log(`${duplicates} élément(s) partagent un fichier déjà traité (sous-clips, doublons).`, "info");
  const empty = { done: 0, unchanged: 0, failed: 0, cancelled: false, aborted: false, timings, operation: null, items: [] };
  if (!clips.length) {
    log("Aucun rush MP4/MOV à traiter dans la sélection.", "warn");
    return empty;
  }

  t = Date.now();
  onPhase("inspect");
  let items = await inspectClips(clips, degrees, onProgress);
  timings.collect += Date.now() - t;
  const errors = items.filter((i) => i.status === "error");
  errors.forEach((i) => log(`${i.entry.name} : échec - ${i.error}`, "error"));

  if (options.confirm) {
    const chosen = await options.confirm(items);
    if (!chosen) return { ...empty, aborted: true, items };
    items = chosen;
  }

  onPhase("apply");
  const applied = await applyRotations(project, items, degrees, options);
  timings.files = applied.timings.files;
  timings.refresh = applied.timings.refresh;
  return {
    done: applied.done,
    unchanged: items.filter((i) => i.status === "unchanged").length,
    failed: applied.failed + errors.length,
    cancelled: applied.cancelled,
    aborted: false,
    timings,
    operation: applied.operation,
    items,
  };
}

/*
 * Annule une opération de l'historique : remet les octets d'origine dans
 * chaque fichier (s'il n'a pas été modifié depuis) et actualise les clips.
 */
async function undoOperation(operation, options = {}) {
  const log = options.log || (() => {});
  const onProgress = options.onProgress || (() => {});
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Aucun projet ouvert.");
  const clipsByPath = await findClipsByPaths(project, operation.files.map((f) => f.path));
  const result = { restored: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < operation.files.length; i++) {
    const file = operation.files[i];
    onProgress(i, operation.files.length, file.name);
    const entry = clipsByPath.get(file.path) || { name: file.name, path: file.path, clip: null };
    try {
      const status = await withFile(file.path, "r", async (io) => {
        // Vérification en lecture seule avant d'ouvrir en écriture.
        for (const c of file.changes) {
          const current = rotation.toHex(await io.read(c.position, c.before.length / 2));
          if (current !== c.after && current !== c.before) return "modified";
        }
        return "ok";
      });
      if (status === "modified") {
        result.skipped++;
        log(`${file.name} : modifié depuis, laissé tel quel`, "warn");
        continue;
      }
      let outcome = "restored";
      const write = (io) => rotation.restoreBytes(io, file.changes).then((r) => (outcome = r));
      const relinked = entry.clip ? await writeFile(project, entry, write) : (await withFile(file.path, "r+", write), false);
      if (outcome !== "restored") {
        result.skipped++;
        continue;
      }
      if (entry.clip && !relinked) await refreshMedia(entry);
      result.restored++;
      log(`${file.name} : rotation d'avant remise`, "ok");
      if (entry.clip && (await safeHasProxy(entry.clip))) {
        log(`${file.name} : son proxy est vertical, pense à le recréer ou à désactiver les proxys`, "warn");
      }
      if (i < operation.files.length - 1) await pause(REFRESH_PAUSE_MS);
    } catch (e) {
      result.failed++;
      log(`${file.name} : échec - ${describeError(e)}`, "error");
    }
  }
  onProgress(operation.files.length, operation.files.length, "");
  return result;
}

async function safeHasProxy(clip) {
  try {
    return await clip.hasProxy();
  } catch (e) {
    return false;
  }
}

module.exports = {
  rotateSelection,
  collectSelectedClips,
  inspectClips,
  applyRotations,
  undoOperation,
  findClipsByPaths,
  withFile,
  mapLimit,
  pause,
};
