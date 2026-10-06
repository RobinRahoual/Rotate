/*
 * Proxys verticaux : les rushs tournés sont envoyés à Adobe Media Encoder avec
 * un préréglage vertical (ex. ProRes 422 Proxy 1080×1920), puis chaque proxy
 * est attaché à son clip dès que Media Encoder a fini de l'écrire.
 *
 * Pourquoi : la lecture d'un rush 4K portant une rotation demande beaucoup à
 * Premiere. Un proxy dont les images sont *réellement* verticales se lit sans
 * aucune rotation, et l'export continue d'utiliser le rush original.
 *
 * Les encodages en attente sont mémorisés : si le panneau est fermé ou
 * Premiere relancé, ils sont repris et attachés au retour.
 */

"use strict";

const PROXY_FOLDER = "Proxies";
const POLL_MS = 3000;
const GIVE_UP_MS = 12 * 60 * 60 * 1000; // 12 h

function splitPath(path) {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const sep = path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
  const dir = i >= 0 ? path.slice(0, i) : "";
  const file = i >= 0 ? path.slice(i + 1) : path;
  const dot = file.lastIndexOf(".");
  return { dir, sep, base: dot > 0 ? file.slice(0, dot) : file };
}

/* Extension du fichier produit par un préréglage Media Encoder (.epr). */
function extensionFromPreset(eprText) {
  const match = /<ExporterFileType[^>]*>\s*(\d+)\s*</.exec(eprText || "");
  if (match) {
    const n = Number(match[1]) >>> 0;
    const code = String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    if (code === "MooV") return ".mov";
    if (code === "H264" || code === "HEVC" || code === "H265") return ".mp4";
    if (code === "MXFf" || code === "MXF ") return ".mxf";
  }
  if (/QuickTime|ProRes|DNxHR|DNxHD|GoPro CineForm/i.test(eprText || "")) return ".mov";
  if (/H\.?264|H\.?265|HEVC/i.test(eprText || "")) return ".mp4";
  return ".mov";
}

/*
 * deps : {
 *   ppro, fs (API fs UXP), rotation (mp4rotation.js), withFile, findClipsByPaths,
 *   load() / save(list)      persistance des encodages en attente
 *   log(message, level), onChange(pendingCount)
 *   setInterval, clearInterval, now()
 * }
 */
function createProxyQueue(deps) {
  const log = deps.log || (() => {});
  const onChange = deps.onChange || (() => {});
  const now = deps.now || (() => Date.now());
  const clipCache = new Map(); // chemin du rush -> ClipProjectItem
  let pending = (deps.load && deps.load()) || [];
  let timer = null;
  let checking = false;
  let listening = false;

  function save() {
    if (deps.save) deps.save(pending);
    onChange(pending.length);
  }

  async function exists(path) {
    try {
      await deps.fs.lstat(path);
      return true;
    } catch (e) {
      return false;
    }
  }

  async function uniqueProxyPath(sourcePath, ext) {
    const { dir, sep, base } = splitPath(sourcePath);
    const folder = dir ? `${dir}${sep}${PROXY_FOLDER}` : PROXY_FOLDER;
    if (!(await exists(folder))) {
      try {
        await deps.fs.mkdir(folder);
      } catch (e) {
        if (!(await exists(folder))) throw new Error(`impossible de créer le dossier ${folder}`);
      }
    }
    for (let n = 0; n < 1000; n++) {
      const candidate = `${folder}${sep}${base}_Proxy_Vertical${n ? `_${n}` : ""}${ext}`;
      if (!(await exists(candidate)) && !pending.some((p) => p.proxyPath === candidate)) return candidate;
    }
    throw new Error("trop de proxys existants pour ce rush");
  }

  function listenToEncoder() {
    if (listening) return;
    listening = true;
    try {
      const manager = deps.ppro.EncoderManager.getManager();
      const trigger = () => check();
      for (const name of ["EVENT_RENDER_COMPLETE", "EVENT_RENDER_ERROR", "EVENT_RENDER_CANCEL"]) {
        const eventName = deps.ppro.EncoderManager[name];
        if (eventName) deps.ppro.EventManager.addEventListener(manager, eventName, trigger);
      }
    } catch (e) {
      // Pas d'événements : la vérification régulière suffit.
    }
  }

  function startPolling() {
    listenToEncoder();
    if (!timer && pending.length) timer = (deps.setInterval || setInterval)(check, POLL_MS);
  }

  function stopPolling() {
    if (timer) (deps.clearInterval || clearInterval)(timer);
    timer = null;
  }

  async function resolveClip(job) {
    if (clipCache.has(job.path)) return clipCache.get(job.path);
    const project = await deps.ppro.Project.getActiveProject();
    if (!project) return null;
    const found = await deps.findClipsByPaths(project, [job.path]);
    const entry = found.get(job.path);
    if (entry) clipCache.set(job.path, entry.clip);
    return entry ? entry.clip : null;
  }

  /* Vérifie les encodages en attente et attache les proxys terminés. */
  async function check() {
    if (checking) return;
    checking = true;
    try {
      for (const job of pending.slice()) {
        let size = null;
        try {
          size = (await deps.fs.lstat(job.proxyPath)).size;
        } catch (e) {
          size = null;
        }
        if (size === null) {
          if (now() - job.queuedAt > GIVE_UP_MS) {
            pending = pending.filter((p) => p !== job);
            log(`${job.name} : proxy jamais produit par Media Encoder, abandonné`, "warn");
            save();
          }
          continue;
        }
        // Fichier complet ET taille stable entre deux vérifications.
        const complete = await deps.withFile(job.proxyPath, "r", (io) => deps.rotation.isComplete(io)).catch(() => false);
        const stable = job.lastSize === size;
        job.lastSize = size;
        if (!complete || !stable) continue;

        const clip = await resolveClip(job);
        if (!clip) continue; // projet fermé ou clip introuvable pour l'instant : on réessaiera
        let attached = false;
        try {
          attached = await clip.attachProxy(job.proxyPath, false);
        } catch (e) {
          attached = false;
        }
        pending = pending.filter((p) => p !== job);
        if (attached) log(`${job.name} : proxy vertical attaché`, "ok");
        else log(`${job.name} : proxy prêt mais impossible de l'attacher (clic droit > Proxy > Attacher les proxys)`, "warn");
        save();
      }
    } finally {
      checking = false;
      if (!pending.length) stopPolling();
    }
  }

  /*
   * Envoie les rushs à Media Encoder. entries : [{ name, path, clip }].
   * Retourne le nombre d'encodages mis en file.
   */
  async function create(entries, presetPath) {
    if (!presetPath) throw new Error("Choisis d'abord un préréglage de proxy vertical (.epr).");
    let presetText = "";
    try {
      presetText = await deps.fs.readFile(presetPath, { encoding: "utf-8" });
    } catch (e) {
      throw new Error(`Préréglage introuvable : ${presetPath}`);
    }
    const ext = extensionFromPreset(presetText);
    const manager = deps.ppro.EncoderManager.getManager();
    let queued = 0;
    for (const entry of entries) {
      if (pending.some((p) => p.path === entry.path)) {
        log(`${entry.name} : proxy déjà en cours`, "info");
        continue;
      }
      try {
        const proxyPath = await uniqueProxyPath(entry.path, ext);
        // 0 = tout le clip ; supprimé de la file AME une fois terminé ; démarrage immédiat.
        const ok = await manager.encodeProjectItem(entry.clip, proxyPath, presetPath, 0, true, true);
        if (!ok) throw new Error("Media Encoder a refusé l'encodage");
        clipCache.set(entry.path, entry.clip);
        pending.push({ path: entry.path, name: entry.name, proxyPath, queuedAt: now(), lastSize: null });
        queued++;
      } catch (e) {
        log(`${entry.name} : proxy non lancé - ${e && e.message ? e.message : e}`, "error");
      }
    }
    save();
    startPolling();
    return queued;
  }

  /* Reprend les encodages mémorisés (au chargement du plugin). */
  function resume() {
    if (pending.length) {
      log(`${pending.length} proxy(s) en attente de Media Encoder : reprise du suivi`, "info");
      startPolling();
    }
    onChange(pending.length);
  }

  return {
    create,
    check,
    resume,
    pendingCount: () => pending.length,
    stop: stopPolling,
  };
}

module.exports = { createProxyQueue, extensionFromPreset, splitPath, PROXY_FOLDER };
