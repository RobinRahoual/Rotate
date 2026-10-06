"use strict";

const uxp = require("uxp");
const { entrypoints, storage: uxpStorage } = uxp;
const manifest = require("./manifest.json");
const ppro = require("premierepro");
const fs = require("fs");
const premiere = require("./src/premiere.js");
const rotation = require("./src/mp4rotation.js");
const settings = require("./src/settings.js");
const { createProxyQueue, waitForCompleteFile } = require("./src/proxies.js");
const presets = require("./src/presets.js");
const { checkCompatibility } = require("./src/compat.js");
const shortcutKeys = require("./src/shortcuts.js");
const cleanup = require("./src/cleanup.js");

const INSTAGRAM_URL = "https://www.instagram.com/robin.rahoual/";
const LONG_TASK_MS = 8000; // au-delà, signal de fin
const os = require("os");

const MAX_LOG_LINES = 300;

// localStorage peut être indisponible : les préférences restent alors en mémoire.
const memory = new Map();
const storage = (() => {
  try {
    return window.localStorage || null;
  } catch (e) {
    return null;
  }
})() || { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)) };

const $ = (id) => document.getElementById(id);

let busy = false;
let cancelRequested = false;
let defaultRotation = settings.getDefaultRotation(storage);

/* ---------- Thème (Premiere : light / dark / darkest) ---------- */

function applyTheme(theme) {
  const dark = String(theme || "dark").includes("dark");
  document.body.classList.remove("theme-light", "theme-dark");
  document.body.classList.add(dark ? "theme-dark" : "theme-light");
}

try {
  applyTheme(document.theme.getCurrent());
  document.theme.onUpdated.addListener(applyTheme);
} catch (e) {
  applyTheme("dark");
}

/* ---------- Journal ---------- */

function log(message, level = "info") {
  const container = $("log");
  const line = document.createElement("div");
  line.className = level;
  line.textContent = message;
  container.appendChild(line);
  while (container.childNodes.length > MAX_LOG_LINES) container.removeChild(container.firstChild);
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

/* ---------- Bloc d'état : en cours, où on en est, terminé ou problème ---------- */

function setDisabled(el, disabled) {
  if (disabled) el.setAttribute("disabled", "");
  else el.removeAttribute("disabled");
}

function show(el, visible) {
  if (visible) el.classList.remove("hidden");
  else el.classList.add("hidden");
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

const status = (() => {
  let title = "";
  let started = 0;
  let phaseLabel = "";
  let phaseStarted = 0;
  let ticker = null;
  let lastUpdate = 0;
  let frame = 0;
  const SPINNER = ["◐", "◓", "◑", "◒"];

  function setKind(kind) {
    $("status").className = `status ${kind}`;
  }

  // Toutes les 250 ms : icône animée et temps écoulé, pour voir que ça tourne.
  function tick() {
    frame = (frame + 1) % SPINNER.length;
    $("status-icon").textContent = SPINNER[frame];
    $("status-title").textContent = `${title} · ${formatDuration(Date.now() - started)}`;
  }

  function start(text) {
    title = text;
    started = Date.now();
    phaseLabel = "";
    setKind("running");
    show($("cancel"), true);
    show($("status-close"), false);
    show($("status-log"), false);
    show($("progress-bar"), true);
    $("progress-bar").setAttribute("value", "0");
    $("status-detail").textContent = "Démarrage…";
    if (ticker) clearInterval(ticker);
    ticker = setInterval(tick, 250);
    tick();
  }

  function phase(label) {
    phaseLabel = label;
    phaseStarted = Date.now();
    lastUpdate = 0;
    $("progress-bar").setAttribute("value", "0");
    $("status-detail").textContent = `${label}…`;
  }

  // Mise à jour limitée à ~10 fois par seconde pour ne pas charger l'interface.
  function progress(done, total, name) {
    const now = Date.now();
    if (done < total && now - lastUpdate < 100) return;
    lastUpdate = now;
    if (!total) {
      $("status-detail").textContent = done ? `${phaseLabel} · ${done} rush(s) trouvé(s)` : `${phaseLabel}…`;
      return;
    }
    $("progress-bar").setAttribute("value", String(Math.round((Math.min(done, total) / total) * 100)));
    let text = `${phaseLabel} · ${Math.min(done + (name ? 1 : 0), total)}/${total}`;
    if (name) text += ` · ${name}`;
    if (done >= 2 && done < total) {
      const remaining = ((now - phaseStarted) / done) * (total - done);
      if (remaining > 1500) text += ` · encore ~${formatDuration(remaining)}`;
    }
    $("status-detail").textContent = text;
  }

  /* kind : "ok" | "warn" | "error" | "idle" */
  function finish(kind, text, detail) {
    if (ticker) clearInterval(ticker);
    ticker = null;
    setKind(kind);
    $("status-icon").textContent = { ok: "✓", warn: "⚠", error: "✕", idle: "" }[kind] || "";
    $("status-title").textContent = text;
    $("status-detail").textContent = detail || "";
    show($("cancel"), false);
    show($("progress-bar"), false);
    show($("status-close"), kind !== "idle");
    show($("status-log"), kind === "warn" || kind === "error");
  }

  function reset() {
    finish("idle", "Prêt", "Sélectionne des rushs ou des chutiers dans le panneau Projet.");
  }

  return { start, phase, progress, finish, reset };
})();

const onProgress = (done, total, name) => status.progress(done, total, name);

const PHASES = {
  collect: "Analyse de la sélection",
  inspect: "Lecture des rushs",
  apply: "Rotation",
};

function setBusy(value) {
  busy = value;
  [$("rotate-default"), $("make-proxies"), ...document.querySelectorAll("[data-rotation]")].forEach((b) => setDisabled(b, value));
  renderUndo();
}

/*
 * Exécute une tâche longue avec le bloc d'état. La tâche renvoie
 * { kind, title, detail } pour l'affichage final ; une exception = échec.
 */
async function runTask(label, task) {
  if (busy) return null;
  cancelRequested = false;
  setBusy(true);
  status.start(label);
  const started = Date.now();
  try {
    const result = (await task()) || { kind: "ok", title: "Terminé" };
    status.finish(result.kind, result.title, result.detail);
    if (Date.now() - started > LONG_TASK_MS && result.kind !== "idle") signalEnd($("status"));
    return { ok: result.kind !== "error" && result.kind !== "warn", message: `${result.title}${result.detail ? ` - ${result.detail}` : ""}` };
  } catch (e) {
    const message = errorMessage(e);
    status.finish("error", "Échec", message);
    log(message, "error");
    if (Date.now() - started > LONG_TASK_MS) signalEnd($("status"));
    return { ok: false, message };
  } finally {
    setBusy(false);
  }
}

/* ---------- Signal de fin : panneau au premier plan, bilan qui clignote, son ---------- */

function flash(el) {
  let n = 0;
  const timer = setInterval(() => {
    if (n % 2 === 0) el.classList.add("flash");
    else el.classList.remove("flash");
    if (++n >= 6) {
      clearInterval(timer);
      el.classList.remove("flash");
    }
  }, 250);
}

function playEndSound() {
  try {
    const sound = $("done-sound");
    sound.currentTime = 0;
    const playing = sound.play();
    if (playing && playing.catch) playing.catch(() => {});
  } catch (e) {
    // lecture audio indisponible : le clignotement suffit
  }
}

function signalEnd(el) {
  showOwnPanel();
  flash(el);
  if (settings.getBool(storage, "endSound", true)) playEndSound();
}

/* ---------- Boîtes de dialogue ---------- */

async function showDialog(build, size) {
  const dialog = document.createElement("dialog");
  build(dialog);
  document.body.appendChild(dialog);
  try {
    return await dialog.uxpShowModal({ title: "Rotate", resize: "both", size });
  } catch (e) {
    return undefined; // fermée avec Échap
  } finally {
    dialog.remove();
  }
}

function showMessage(text) {
  return showDialog((dialog) => {
    dialog.innerHTML = `
      <div class="preview">
        <sp-body size="S"></sp-body>
        <footer><sp-button variant="cta" id="ok">OK</sp-button></footer>
      </div>`.trim();
    dialog.querySelector("sp-body").textContent = text;
    dialog.querySelector("#ok").addEventListener("click", () => dialog.close("ok"));
  }, { width: 340, height: 170 });
}

async function confirmDialog(text, okLabel, cancelLabel = "Annuler") {
  const answer = await showDialog((dialog) => {
    dialog.innerHTML = `
      <div class="preview">
        <sp-body size="S"></sp-body>
        <footer>
          <sp-button variant="secondary" id="no">Annuler</sp-button>
          <sp-button variant="cta" id="yes"></sp-button>
        </footer>
      </div>`.trim();
    dialog.querySelector("sp-body").textContent = text;
    dialog.querySelector("#yes").textContent = okLabel;
    dialog.querySelector("#no").textContent = cancelLabel;
    dialog.querySelector("#yes").addEventListener("click", () => dialog.close("yes"));
    dialog.querySelector("#no").addEventListener("click", () => dialog.close("no"));
  }, { width: 360, height: 180 });
  return answer === "yes";
}

/*
 * Aperçu avant validation : liste des rushs avec leur sens actuel, ceux à
 * tourner sont cochés. Renvoie les éléments cochés, ou null si abandon.
 */
/*
 * Fenêtre de liste à cocher. options : {
 *   intro, items: [{ label, value }] (tous cochés au départ),
 *   lines: [{ text, className }] (lignes non cochables), okLabel(checkedValues), cancelLabel, size
 * }. Renvoie les valeurs cochées, ou null si abandon.
 *
 * Au-delà de MAX_CHECKLIST_ITEMS éléments, seuls les premiers sont affichés
 * (cochables) et les autres sont inclus d'office : des centaines de cases
 * Spectrum ralentiraient fortement l'ouverture de la fenêtre.
 */
const MAX_CHECKLIST_ITEMS = 150;
const MAX_CHECKLIST_LINES = 50;
async function checklistDialog(options) {
  const answer = await showDialog((dialog) => {
    dialog.innerHTML = `
      <div class="preview">
        <sp-body size="S" id="intro"></sp-body>
        <sp-checkbox id="all" checked>Tout cocher</sp-checkbox>
        <div class="preview-list" id="list"></div>
        <footer>
          <sp-button variant="secondary" id="no"></sp-button>
          <sp-button variant="cta" id="yes"></sp-button>
        </footer>
      </div>`.trim();
    dialog.querySelector("#intro").textContent = options.intro;
    dialog.querySelector("#no").textContent = options.cancelLabel || "Annuler";

    const list = dialog.querySelector("#list");
    const boxes = [];
    const valueOf = new Map();
    const shown = options.items.slice(0, MAX_CHECKLIST_ITEMS);
    const hidden = options.items.slice(MAX_CHECKLIST_ITEMS).map((item) => item.value);
    for (const item of shown) {
      const box = document.createElement("sp-checkbox");
      box.setAttribute("checked", "");
      box.textContent = item.label;
      valueOf.set(box, item.value);
      list.appendChild(box);
      boxes.push(box);
    }
    const addLine = (text, className) => {
      const el = document.createElement("div");
      el.className = `line ${className || "muted"}`;
      el.textContent = text;
      list.appendChild(el);
    };
    if (hidden.length) addLine(`… et ${hidden.length} autre(s), inclus automatiquement`, "muted");
    const lines = options.lines || [];
    lines.slice(0, MAX_CHECKLIST_LINES).forEach((line) => addLine(line.text, line.className));
    if (lines.length > MAX_CHECKLIST_LINES) addLine(`… et ${lines.length - MAX_CHECKLIST_LINES} autre(s) ligne(s)`, "muted");

    const yes = dialog.querySelector("#yes");
    const isChecked = (b) => b.checked === true || (b.checked === undefined && b.hasAttribute("checked"));
    const checkedValues = () => boxes.filter(isChecked).map((b) => valueOf.get(b)).concat(hidden);
    const update = () => {
      const values = checkedValues();
      yes.textContent = values.length ? options.okLabel(values) : "Rien de coché";
      setDisabled(yes, values.length === 0);
    };
    boxes.forEach((b) => b.addEventListener("change", update));
    dialog.querySelector("#all").addEventListener("change", (e) => {
      boxes.forEach((b) => setChecked(b, e.target.checked));
      update();
    });
    update();
    yes.addEventListener("click", () => dialog.close(checkedValues()));
    dialog.querySelector("#no").addEventListener("click", () => dialog.close(null));
  }, options.size || { width: 440, height: 440 });
  return Array.isArray(answer) ? answer : null;
}

/*
 * Aperçu avant validation : liste des rushs avec leur sens actuel, ceux à
 * tourner sont cochés. Renvoie les éléments cochés, ou null si abandon.
 */
async function previewDialog(items, degrees) {
  const todo = items.filter((i) => i.status === "todo");
  const unchanged = items.filter((i) => i.status === "unchanged");
  const errors = items.filter((i) => i.status === "error");
  if (!todo.length) return items; // rien à tourner : pas besoin de demander

  const parts = [`${todo.length} rush(s) à tourner en ${settings.rotationLabel(degrees)}`];
  if (unchanged.length) parts.push(`${unchanged.length} déjà dans ce sens`);
  if (errors.length) parts.push(`${errors.length} illisible(s)`);
  const chosen = await checklistDialog({
    intro: parts.join(" · "),
    items: todo.map((item) => ({
      label: `${item.entry.name}   ${settings.rotationLabel(item.previous)} → ${settings.rotationLabel(degrees)}`,
      value: item,
    })),
    lines: [
      ...unchanged.map((item) => ({ text: `${item.entry.name}   déjà ${settings.rotationLabel(degrees)}`, className: "muted" })),
      ...errors.map((item) => ({ text: `${item.entry.name}   ${item.error}`, className: "error" })),
    ],
    okLabel: (values) => `Tourner ${values.length} rush(s)`,
  });
  return chosen ? [...chosen, ...unchanged] : null;
}

/* ---------- Historique / annulation ---------- */

function describeOperation(op) {
  const time = new Date(op.date);
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  return `${op.files.length} rush(s) → ${settings.rotationLabel(op.rotation)} (${hh}:${mm})`;
}

function renderUndo() {
  const last = settings.lastHistory(storage);
  const button = $("undo");
  setDisabled(button, busy || !last);
  button.textContent = last ? `Annuler : ${describeOperation(last)}` : "Annuler la dernière opération";
}

async function undoLast(fromMenu) {
  const last = settings.lastHistory(storage);
  if (!last) {
    if (fromMenu) await showMessage("Aucune opération à annuler.");
    return;
  }
  const question = `Annuler la dernière opération (${describeOperation(last)}) ? Ces rushs retrouveront leur sens d'avant.`;
  if (!(await confirmDialog(question, "Annuler l'opération", "Garder"))) return;
  const result = await runTask("Annulation en cours", async () => {
    status.phase("Remise du sens d'avant");
    const r = await premiere.undoOperation(last, { log, onProgress });
    settings.popHistory(storage);
    const parts = [`${r.restored} remis comme avant`];
    if (r.skipped) parts.push(`${r.skipped} laissé(s) tel quel (modifié depuis)`);
    if (r.failed) parts.push(`${r.failed} échec(s)`);
    log(`Annulation terminée : ${parts.join(", ")}.`, r.failed ? "warn" : "ok");
    return { kind: r.failed ? "warn" : "ok", title: r.failed ? "Annulation terminée avec des problèmes" : "Annulation terminée", detail: parts.join(" · ") };
  });
  renderUndo();
  if (fromMenu && result && !result.ok) await showMessage(result.message);
}

/* ---------- Rotation ---------- */

async function runRotation(degrees) {
  const started = Date.now();
  return runTask(`Rotation ${settings.rotationLabel(degrees)} en cours`, async () => {
    const usePreview = settings.getBool(storage, "preview", true);
    const result = await premiere.rotateSelection(degrees, {
      log,
      onProgress,
      onPhase: (p) => status.phase(PHASES[p] || p),
      isCancelled: () => cancelRequested,
      confirm: usePreview ? (items) => previewDialog(items, degrees) : null,
    });
    if (result.aborted) return { kind: "idle", title: "Rotation annulée", detail: "Aucun fichier modifié." };
    if (result.operation) settings.pushHistory(storage, result.operation);

    const t = result.timings;
    const elapsed = formatDuration(Date.now() - started);
    const parts = [`${result.done} tourné(s)`];
    if (result.unchanged) parts.push(`${result.unchanged} déjà à ${settings.rotationLabel(degrees)}`);
    if (result.failed) parts.push(`${result.failed} problème(s)`);
    const detail = parts.join(" · ");
    log(`${result.cancelled ? "Arrêté" : "Terminé"} en ${elapsed} : ${detail}.`, result.failed ? "warn" : "ok");
    log(`Détail : sélection ${t.collect} ms · fichiers ${t.files} ms · actualisation Premiere ${t.refresh} ms`, "info");

    // Proxys automatiques pour les rushs qui viennent d'être tournés.
    if (degrees !== 0 && result.operation && result.operation.files.length && settings.getBool(storage, "autoProxy", false)) {
      const paths = new Set(result.operation.files.map((f) => f.path));
      const queued = await startProxies(result.items.filter((i) => paths.has(i.entry.path)).map((i) => i.entry));
      if (queued < 0 && !result.failed) {
        return { kind: "warn", title: `Rotation terminée · ${elapsed}`, detail: `${detail} · proxys non lancés (voir le journal)` };
      }
    }
    if (degrees === 0 && result.done) {
      log("Si ces rushs avaient des proxys verticaux, désactive les proxys ou recrée-les.", "info");
    }

    if (result.cancelled) return { kind: "warn", title: `Arrêté après ${elapsed}`, detail };
    if (result.failed && !result.done) return { kind: "error", title: "Aucun rush n'a pu être tourné", detail };
    if (result.failed) return { kind: "warn", title: `Terminé avec ${result.failed} problème(s) · ${elapsed}`, detail };
    if (!result.done && !result.unchanged) return { kind: "warn", title: "Rien à tourner", detail: "Aucun rush MP4/MOV dans la sélection." };
    return { kind: "ok", title: `Terminé · ${elapsed}`, detail };
  });
}

/* Affiche le panneau Rotate (pour suivre une action lancée depuis le menu). */
function showOwnPanel() {
  try {
    const me = [...uxp.pluginManager.plugins].find((p) => p.id === manifest.id);
    if (me) {
      me.showPanel("rotatePanel");
      return true;
    }
  } catch (e) {
    // pas de pluginManager : on préviendra par une fenêtre en cas de souci
  }
  return false;
}

// Depuis le menu, on ouvre le panneau pour suivre l'avancement ; une fenêtre ne s'affiche
// en cas de problème que si le panneau n'a pas pu être ouvert.
async function runFromMenu(degrees) {
  if (busy) return showMessage("Une opération est déjà en cours.");
  const panelShown = showOwnPanel();
  const result = await runRotation(degrees);
  renderUndo();
  if (result && !result.ok && !panelShown) await showMessage(result.message);
}

/* ---------- Proxys ---------- */

const proxies = createProxyQueue({
  ppro,
  fs,
  rotation,
  withFile: premiere.withFile,
  findClipsByPaths: premiere.findClipsByPaths,
  load: () => settings.getJSON(storage, "pendingProxies", []),
  save: (list) => settings.setJSON(storage, "pendingProxies", list),
  log,
  onChange: () => renderProxyBanner(),
  onJobDone: (job, ok) => {
    if (ok) proxyBatch.done++;
    else proxyBatch.failed++;
    renderProxyBanner();
  },
  // Registre des proxys créés, pour pouvoir les retrouver au nettoyage.
  onQueued: (proxyPath) => {
    const known = settings.getJSON(storage, "createdProxies", []);
    known.push(proxyPath);
    settings.setJSON(storage, "createdProxies", known.slice(-2000));
  },
});

// Suivi des proxys en cours : X/Y prêts, puis bilan.
const proxyBatch = { total: 0, done: 0, failed: 0 };
let proxiesRunning = false;

function renderProxyBanner() {
  const pending = proxies.pendingCount();
  const banner = $("proxy-banner");
  if (!proxyBatch.total && !pending) {
    show(banner, false);
    return;
  }
  if (proxyBatch.total < proxyBatch.done + proxyBatch.failed + pending) {
    proxyBatch.total = proxyBatch.done + proxyBatch.failed + pending;
  }
  show(banner, true);
  const finished = proxyBatch.done + proxyBatch.failed;
  $("proxy-bar").setAttribute("value", String(Math.round((finished / proxyBatch.total) * 100)));
  if (pending) {
    proxiesRunning = true;
    banner.className = "status proxy";
    show($("proxy-bar"), true);
    $("proxy-banner-text").textContent = `◐ Proxys : ${finished}/${proxyBatch.total} prêts · Media Encoder travaille en arrière-plan`;
  } else {
    banner.className = `status ${proxyBatch.failed ? "warn" : "ok"}`;
    show($("proxy-bar"), false);
    $("proxy-banner-text").textContent = proxyBatch.failed
      ? `⚠ Proxys : ${proxyBatch.done} attaché(s), ${proxyBatch.failed} problème(s) (voir le journal)`
      : `✓ ${proxyBatch.done} proxy(s) vertical(aux) attaché(s) · active les proxys dans le moniteur`;
    // Fin du lot de proxys : on prévient (ils peuvent prendre de longues minutes).
    if (proxiesRunning) {
      proxiesRunning = false;
      signalEnd(banner);
    }
  }
}

function proxySize() {
  const value = settings.getString(storage, "proxySize");
  return presets.SIZES[value] ? value : presets.DEFAULT_SIZE;
}

function renderPreset() {
  const manual = settings.getString(storage, "proxyPresetMode") === "manual";
  const preset = settings.getString(storage, "proxyPreset");
  if (manual && preset) {
    $("preset-name").textContent = `manuel (${preset.split(/[\\/]/).pop()})`;
  } else if (preset && settings.getString(storage, "proxyPresetSize") === proxySize()) {
    $("preset-name").textContent = "automatique, prêt";
  } else {
    $("preset-name").textContent = "automatique (préparé au premier usage)";
  }
  if (manual) $("auto-preset").classList.remove("hidden");
  else $("auto-preset").classList.add("hidden");
  document.querySelectorAll("#proxy-size sp-radio").forEach((radio) => setChecked(radio, radio.getAttribute("value") === proxySize()));
}

let picking = false;
async function choosePreset() {
  if (picking) return; // évite la boucle de clics connue des sélecteurs de fichiers UXP
  picking = true;
  try {
    const file = await uxpStorage.localFileSystem.getFileForOpening({ types: ["epr"] });
    if (file && file.nativePath) {
      settings.setString(storage, "proxyPreset", file.nativePath);
      settings.setString(storage, "proxyPresetMode", "manual");
      renderPreset();
      log(`Préréglage de proxy manuel : ${file.name}`, "ok");
    }
  } catch (e) {
    log(`Sélection du préréglage impossible : ${errorMessage(e)}`, "error");
  } finally {
    setTimeout(() => (picking = false), 300);
  }
}

function backToAutoPreset() {
  settings.setString(storage, "proxyPresetMode", "auto");
  settings.setString(storage, "proxyPreset", "");
  renderPreset();
}

async function fileExists(path) {
  try {
    await fs.lstat(path);
    return true;
  } catch (e) {
    return false;
  }
}

function trimSep(path) {
  return String(path).replace(/[\\/]+$/, "");
}

/*
 * Renvoie le chemin du préréglage à utiliser. En mode automatique, le crée
 * (et le vérifie par un encodage test d'une seconde) la première fois ou
 * quand la taille choisie change.
 */
async function ensureProxyPreset() {
  const preset = settings.getString(storage, "proxyPreset");
  if (settings.getString(storage, "proxyPresetMode") === "manual" && preset) return preset;
  if (preset && settings.getString(storage, "proxyPresetSize") === proxySize() && (await fileExists(preset))) return preset;

  status.phase("Préparation du préréglage vertical (une seule fois, ~30 s)");
  const platform = os.platform();
  const sep = platform === "darwin" ? "/" : "\\";
  const { localFileSystem } = uxpStorage;
  const dataFolder = trimSep((await localFileSystem.getDataFolder()).nativePath);
  const pluginFolder = trimSep((await localFileSystem.getPluginFolder()).nativePath);
  const manager = ppro.EncoderManager.getManager();
  const fileDeps = { fs, rotation, withFile: premiere.withFile };
  const result = await presets.createVerticalPreset(
    {
      fs,
      platform,
      dataFolder,
      calibrationFile: `${pluginFolder}${sep}assets${sep}calibration.mp4`,
      rotation,
      withFile: premiere.withFile,
      log,
      encodeTest: (input, output, presetPath) =>
        manager.encodeFile(input, output, presetPath, ppro.TickTime.createWithSeconds(0), ppro.TickTime.createWithSeconds(1), 0, true, true),
      waitForFile: (path, timeout) => waitForCompleteFile(fileDeps, path, timeout),
    },
    proxySize()
  );
  settings.setString(storage, "proxyPreset", result.path);
  settings.setString(storage, "proxyPresetSize", result.size);
  settings.setString(storage, "proxyPresetMode", "auto");
  renderPreset();
  return result.path;
}

/* Lance les proxys ; renvoie le nombre mis en file, ou -1 si le préréglage n'a pas pu être préparé. */
async function startProxies(entries) {
  if (!entries.length) return 0;
  let preset;
  try {
    preset = await ensureProxyPreset();
  } catch (e) {
    log(`Proxys : ${errorMessage(e)}`, "error");
    return -1;
  }
  status.phase("Envoi à Media Encoder");
  // Nouveau lot : on repart de zéro si le précédent était terminé.
  if (!proxies.pendingCount()) Object.assign(proxyBatch, { total: 0, done: 0, failed: 0 });
  const queued = await proxies.create(entries, preset);
  if (queued) log(`${queued} proxy(s) envoyé(s) à Media Encoder.`, "ok");
  renderProxyBanner();
  return queued;
}

async function makeProxiesForSelection() {
  await runTask("Création des proxys", async () => {
    status.phase(PHASES.collect);
    const { clips } = await premiere.collectSelectedClips((n) => onProgress(n, 0, ""));
    // On ne fait des proxys verticaux que pour les rushs déjà tournés.
    status.phase(PHASES.inspect);
    const items = await premiere.inspectClips(clips, 0, onProgress);
    const rotated = items.filter((i) => i.status === "todo").map((i) => i.entry);
    const horizontal = items.filter((i) => i.status === "unchanged").length;
    if (horizontal) log(`${horizontal} rush(s) horizontaux ignorés (tourne-les d'abord).`, "info");
    if (!rotated.length) return { kind: "warn", title: "Aucun rush tourné dans la sélection", detail: "Tourne-les d'abord, puis crée les proxys." };
    const queued = await startProxies(rotated);
    if (queued < 0) return { kind: "error", title: "Proxys non lancés", detail: "Le préréglage n'a pas pu être préparé (voir le journal)." };
    if (!queued) return { kind: "warn", title: "Aucun proxy lancé", detail: "Voir le journal." };
    return { kind: "ok", title: `${queued} proxy(s) envoyé(s) à Media Encoder`, detail: "Ils seront attachés automatiquement dès qu'ils sont prêts." };
  });
}

/* ---------- Nettoyage des proxys ---------- */

async function cleanupProxies() {
  await runTask("Analyse des proxys", async () => {
    status.phase("Recherche des proxys du projet");
    const project = await ppro.Project.getActiveProject();
    if (!project) throw new Error("Aucun projet ouvert.");
    const media = await premiere.listProjectMedia(project);
    const known = settings.getJSON(storage, "createdProxies", []);
    const scan = await cleanup.scanProxies({ fs }, media, known);
    // Ne jamais proposer un proxy en cours d'encodage.
    const encoding = new Set(proxies.pendingPaths().map((p) => p.toLowerCase()));
    const unused = scan.unused.filter((f) => !encoding.has(f.path.toLowerCase()));
    const used = `${scan.inUse.length} proxy(s) utilisé(s) · ${cleanup.formatBytes(cleanup.totalBytes(scan.inUse))}`;
    log(`Proxys Rotate : ${used} · ${unused.length} inutilisé(s) · ${cleanup.formatBytes(cleanup.totalBytes(unused))}`, "info");
    if (!unused.length) return { kind: "ok", title: "Aucun proxy inutile", detail: used };

    const chosen = await checklistDialog({
      intro: `${unused.length} proxy(s) ne sont attachés à aucun clip de ce projet (${cleanup.formatBytes(cleanup.totalBytes(unused))}). S'ils servent dans un autre projet, il faudra les recréer.`,
      items: unused.map((f) => ({ label: `${f.path.split(/[\\/]/).pop()}   ${cleanup.formatBytes(f.bytes)}`, value: f })),
      okLabel: (values) => `Supprimer ${values.length} (${cleanup.formatBytes(cleanup.totalBytes(values))})`,
      cancelLabel: "Garder",
    });
    if (!chosen) return { kind: "idle", title: "Nettoyage annulé", detail: used };

    status.phase("Suppression");
    const result = await cleanup.deleteFiles({ fs }, chosen.map((f) => f.path));
    const deleted = new Set(result.deleted.map((p) => p.toLowerCase()));
    settings.setJSON(storage, "createdProxies", known.filter((p) => !deleted.has(p.toLowerCase())));
    const freed = cleanup.totalBytes(chosen.filter((f) => deleted.has(f.path.toLowerCase())));
    result.deleted.forEach((p) => log(`Supprimé : ${p}`, "ok"));
    result.failed.forEach((p) => log(`Impossible de supprimer : ${p}`, "error"));
    if (result.failed.length) {
      return { kind: "warn", title: `${cleanup.formatBytes(freed)} libérés`, detail: `${result.deleted.length} supprimé(s) · ${result.failed.length} impossible(s) à supprimer` };
    }
    return { kind: "ok", title: `${cleanup.formatBytes(freed)} libérés`, detail: `${result.deleted.length} proxy(s) inutile(s) supprimé(s) · ${used}` };
  });
}

/* ---------- Raccourcis clavier (panneau actif) ---------- */

let shortcuts = shortcutKeys.withDefaults(settings.getJSON(storage, "shortcuts", null));
let capturing = null; // action en attente d'une nouvelle touche

const SHORTCUT_ACTIONS = {
  rotateDefault: () => runRotation(defaultRotation).then(renderUndo),
  rotateReset: () => runRotation(0).then(renderUndo),
  undo: () => undoLast(false),
  proxies: () => makeProxiesForSelection(),
};

function renderShortcuts() {
  document.querySelectorAll("[data-shortcut]").forEach((button) => {
    const action = button.getAttribute("data-shortcut");
    button.textContent = capturing === action ? "Appuie sur une touche…" : shortcuts[action] || "—";
  });
}

function onKeyDown(event) {
  if (capturing) {
    event.preventDefault();
    if (event.key === "Escape") {
      capturing = null;
    } else if (event.key === "Backspace" || event.key === "Delete") {
      shortcuts = shortcutKeys.assign(shortcuts, capturing, "");
      capturing = null;
    } else {
      const key = shortcutKeys.normalizeKey(event);
      if (!key) return; // touche non utilisable : on attend une lettre ou un chiffre
      shortcuts = shortcutKeys.assign(shortcuts, capturing, key);
      capturing = null;
    }
    settings.setJSON(storage, "shortcuts", shortcuts);
    renderShortcuts();
    return;
  }
  if (event.key === "Escape" && busy) {
    cancelRequested = true;
    $("status-detail").textContent = "Arrêt après le rush en cours…";
    return;
  }
  const tag = String((event.target && event.target.tagName) || "").toLowerCase();
  if (busy || tag === "input" || tag === "textarea" || tag === "sp-textfield") return;
  const action = shortcutKeys.actionFor(shortcuts, shortcutKeys.normalizeKey(event));
  if (action) {
    event.preventDefault();
    SHORTCUT_ACTIONS[action]();
  }
}

/* ---------- Instagram ---------- */

async function openInstagram() {
  try {
    const error = await uxp.shell.openExternal(INSTAGRAM_URL, "Ouvrir le profil Instagram de @robin.rahoual");
    if (error) log(`Impossible d'ouvrir Instagram : ${error}`, "warn");
  } catch (e) {
    log(`Impossible d'ouvrir Instagram : ${errorMessage(e)}`, "warn");
  }
}

/* ---------- Sens par défaut et options ---------- */

function setChecked(el, value) {
  el.checked = value;
  if (value) el.setAttribute("checked", "");
  else el.removeAttribute("checked");
}

function renderDefault() {
  $("rotate-default").textContent = `Tourner en vertical  ${settings.rotationLabel(defaultRotation)}`;
  document.querySelectorAll("#default-choice sp-radio").forEach((radio) => {
    setChecked(radio, Number(radio.getAttribute("value")) === defaultRotation);
  });
}

/* ---------- Événements ---------- */
// Initialisation du panneau. Protégée : quoi qu'il arrive ici, les commandes du
// menu (déclarées juste après) restent disponibles.
function initPanel() {

  $("rotate-default").addEventListener("click", () => runRotation(defaultRotation).then(renderUndo));
  $("undo").addEventListener("click", () => undoLast(false));
  $("cancel").addEventListener("click", () => {
    cancelRequested = true;
    $("status-detail").textContent = "Arrêt après le rush en cours…";
  });
  $("clear-log").addEventListener("click", () => ($("log").textContent = ""));
  $("status-close").addEventListener("click", () => status.reset());
  $("status-log").addEventListener("click", () => {
    try {
      $("log").scrollIntoView();
    } catch (e) {
      // défilement non pris en charge : le journal reste en bas du panneau
    }
  });

  $("default-choice").addEventListener("change", (event) => {
    defaultRotation = settings.setDefaultRotation(storage, Number(event.target.value));
    renderDefault();
  });
  $("opt-preview").addEventListener("change", (e) => settings.setBool(storage, "preview", e.target.checked));
  $("opt-auto-proxy").addEventListener("change", (e) => settings.setBool(storage, "autoProxy", e.target.checked));
  $("choose-preset").addEventListener("click", choosePreset);
  $("auto-preset").addEventListener("click", backToAutoPreset);
  $("proxy-size").addEventListener("change", (event) => {
    settings.setString(storage, "proxySize", event.target.value);
    renderPreset();
  });
  $("make-proxies").addEventListener("click", makeProxiesForSelection);
  $("clean-proxies").addEventListener("click", cleanupProxies);
  $("opt-end-sound").addEventListener("change", (e) => settings.setBool(storage, "endSound", e.target.checked));
  $("test-signal").addEventListener("click", () => {
    status.finish("ok", "Test du signal de fin", "Le bilan clignote et le son est joué (si activé).");
    signalEnd($("status"));
  });
  $("instagram").addEventListener("click", openInstagram);
  document.querySelectorAll("[data-shortcut]").forEach((button) => {
    button.addEventListener("click", () => {
      capturing = capturing === button.getAttribute("data-shortcut") ? null : button.getAttribute("data-shortcut");
      renderShortcuts();
    });
  });
  document.addEventListener("keydown", onKeyDown);

  document.querySelectorAll("[data-rotation]").forEach((button) => {
    button.addEventListener("click", () => runRotation(Number(button.getAttribute("data-rotation"))).then(renderUndo));
  });

  setChecked($("opt-preview"), settings.getBool(storage, "preview", true));
  setChecked($("opt-auto-proxy"), settings.getBool(storage, "autoProxy", false));
  setChecked($("opt-end-sound"), settings.getBool(storage, "endSound", true));
  renderShortcuts();
  renderDefault();
  renderPreset();
  renderUndo();
  proxies.resume();
  renderProxyBanner();

  // Après une grosse mise à jour de Premiere : prévenir tout de suite si une fonction manque.
  (() => {
    const { missingRequired, missingOptional } = checkCompatibility(ppro);
    let version = "";
    try {
      version = uxp.host ? `${uxp.host.name} ${uxp.host.version}` : "";
    } catch (e) {
      version = "";
    }
    log(`Rotate ${manifest.version} · plugin par @robin.rahoual sur Instagram${version ? ` · ${version}` : ""}`, "info");
    if (missingRequired.length) {
      status.finish("error", "Plugin à mettre à jour", `Cette version de Premiere ne fournit plus : ${missingRequired.join(", ")}.`);
      log(`Fonctions Premiere manquantes : ${missingRequired.join(", ")}`, "error");
    } else if (missingOptional.length) {
      log(`Proxys indisponibles avec cette version de Premiere (manque : ${missingOptional.join(", ")}).`, "warn");
    }
  })();
}

try {
  initPanel();
} catch (e) {
  try {
    log(`Initialisation incomplète du panneau : ${errorMessage(e)}`, "error");
  } catch (ignored) {
    // panneau indisponible
  }
}

/* ---------- Entrées du menu Fenêtre > Plugins UXP > Rotate ---------- */

entrypoints.setup({
  panels: {
    rotatePanel: {
      show() {},
    },
  },
  commands: {
    rotateDefault: () => runFromMenu(defaultRotation),
    rotateReset: () => runFromMenu(0),
    rotateUndo: () => undoLast(true),
  },
});
