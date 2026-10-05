/*
 * Intégration Premiere Pro : récupère les rushs sélectionnés dans le panneau
 * Projet (y compris le contenu des chutiers sélectionnés), modifie la rotation
 * de leur fichier source puis demande à Premiere de relire le média.
 */

"use strict";

const ppro = require("premierepro");
const fs = require("fs");
const rotation = require("./mp4rotation.js");

/* Adaptateur fichier (API fs de UXP) attendu par mp4rotation.js. */
async function openFile(path) {
  const fd = await fs.open(path, "r+");
  return {
    async size() {
      return (await fs.lstat(path)).size;
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

async function withFile(path, callback) {
  const io = await openFile(path);
  try {
    return await callback(io);
  } finally {
    await io.close();
  }
}

/* Parcourt récursivement les éléments sélectionnés et renvoie les clips (sans doublon de fichier). */
async function collectSelectedClips() {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("Aucun projet ouvert.");
  const selection = await ppro.ProjectUtils.getSelection(project);
  const selected = selection ? await selection.getItems() : [];
  if (!selected.length) throw new Error("Sélectionne des rushs ou un chutier dans le panneau Projet.");

  const clips = [];
  const skipped = [];
  const seenPaths = new Set();

  async function visit(item) {
    if (item.type === ppro.ProjectItem.TYPE_BIN || item.type === ppro.ProjectItem.TYPE_ROOT) {
      const folder = ppro.FolderItem.cast(item);
      for (const child of await folder.getItems()) await visit(child);
      return;
    }
    if (item.type !== ppro.ProjectItem.TYPE_CLIP) return;

    const clip = ppro.ClipProjectItem.cast(item);
    if (!clip || (await clip.isSequence())) return;
    if (await clip.isOffline()) {
      skipped.push({ name: item.name, reason: "média hors ligne" });
      return;
    }
    const path = await clip.getMediaFilePath();
    if (!path) return;
    if (!rotation.isSupportedPath(path)) {
      skipped.push({ name: item.name, reason: "format non pris en charge (MP4/MOV uniquement)" });
      return;
    }
    // Plusieurs éléments du projet (sous-clips, doublons) peuvent pointer vers le même fichier.
    if (seenPaths.has(path)) {
      clips.push({ name: item.name, path, clip, duplicate: true });
      return;
    }
    seenPaths.add(path);
    clips.push({ name: item.name, path, clip, duplicate: false });
  }

  for (const item of selected) await visit(item);
  return { project, clips, skipped };
}

/* Met le clip hors ligne (libère le fichier côté Premiere, utile sous Windows). */
function setOffline(project, clip) {
  project.lockedAccess(() => {
    const action = clip.createSetOfflineAction();
    project.executeTransaction((compound) => compound.addAction(action), "Rotate : mise hors ligne");
  });
}

async function refreshInPremiere(entry) {
  let ok = false;
  try {
    ok = await entry.clip.refreshMedia();
  } catch (e) {
    ok = false;
  }
  if (!ok) {
    // Re-lier le clip au même fichier force Premiere à relire l'en-tête.
    ok = await entry.clip.changeMediaFilePath(entry.path, true);
  }
  return ok;
}

/*
 * Applique la rotation `degrees` (0, 90, 180, 270 - sens horaire) à tous les
 * rushs sélectionnés. `log(message, level)` reçoit la progression.
 */
async function rotateSelection(degrees, log) {
  const { project, clips, skipped } = await collectSelectedClips();
  skipped.forEach((s) => log(`${s.name} : ignoré (${s.reason})`, "warn"));
  if (!clips.length) {
    log("Aucun rush MP4/MOV à traiter dans la sélection.", "warn");
    return { done: 0, unchanged: 0, failed: 0 };
  }

  const results = new Map(); // path -> "done" | "unchanged" | "failed"
  let done = 0;
  let unchanged = 0;
  let failed = 0;

  for (const entry of clips) {
    if (entry.duplicate) {
      // Le fichier a déjà été traité : on rafraîchit juste cet élément du projet.
      if (results.get(entry.path) === "done") await refreshInPremiere(entry);
      continue;
    }
    try {
      let result;
      try {
        result = await withFile(entry.path, (io) => rotation.setRotation(io, degrees));
      } catch (openError) {
        // Fichier verrouillé par Premiere : on le met hors ligne, on écrit, puis on le re-lie.
        if (!/EBUSY|EPERM|EACCES|lock|busy|denied/i.test(String(openError && openError.message))) throw openError;
        setOffline(project, entry.clip);
        result = await withFile(entry.path, (io) => rotation.setRotation(io, degrees));
        await entry.clip.changeMediaFilePath(entry.path, true);
      }

      if (!result.changed) {
        unchanged++;
        results.set(entry.path, "unchanged");
        log(`${entry.name} : déjà à ${degrees}°`, "info");
        continue;
      }
      const refreshed = await refreshInPremiere(entry);
      done++;
      results.set(entry.path, "done");
      log(
        `${entry.name} : ${result.previous ?? "?"}° → ${degrees}°` +
          (refreshed ? "" : " (fichier modifié, mais Premiere n'a pas rafraîchi : clic droit > Actualiser le média)"),
        refreshed ? "ok" : "warn"
      );
    } catch (e) {
      failed++;
      results.set(entry.path, "failed");
      log(`${entry.name} : échec - ${e && e.message ? e.message : e}`, "error");
    }
  }
  return { done, unchanged, failed };
}

module.exports = { rotateSelection, collectSelectedClips };
