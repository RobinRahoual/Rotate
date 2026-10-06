"use strict";

const { entrypoints, storage: uxpStorage } = require("uxp");
const ppro = require("premierepro");
const fs = require("fs");
const premiere = require("./src/premiere.js");
const rotation = require("./src/mp4rotation.js");
const settings = require("./src/settings.js");
const { createProxyQueue, waitForCompleteFile } = require("./src/proxies.js");
const presets = require("./src/presets.js");
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

function setSummary(text) {
  $("summary").textContent = text;
}

function errorMessage(e) {
  return e && e.message ? e.message : String(e);
}

/* ---------- Progression ---------- */

function setDisabled(el, disabled) {
  if (disabled) el.setAttribute("disabled", "");
  else el.removeAttribute("disabled");
}

function setBusy(value) {
  busy = value;
  if (value) $("progress").classList.remove("hidden");
  else $("progress").classList.add("hidden");
  [$("rotate-default"), $("make-proxies"), ...document.querySelectorAll("[data-rotation]")].forEach((b) => setDisabled(b, value));
  renderUndo();
}

// Mise à jour de la barre limitée à ~10 fois par seconde pour ne pas surcharger l'interface.
let lastProgressUpdate = 0;
function onProgress(done, total, name) {
  const now = Date.now();
  if (done < total && now - lastProgressUpdate < 100) return;
  lastProgressUpdate = now;
  $("progress-bar").setAttribute("value", String(total ? Math.round((done / total) * 100) : 0));
  $("progress-label").textContent = name ? `${done + 1}/${total} · ${name}` : `${done}/${total}`;
}

/* Exécute une tâche longue avec la barre de progression et le bouton Arrêter. */
async function runTask(label, task) {
  if (busy) return null;
  cancelRequested = false;
  setBusy(true);
  onProgress(0, 0, "");
  setSummary(label);
  try {
    return await task();
  } catch (e) {
    const message = errorMessage(e);
    setSummary(message);
    log(message, "error");
    return { ok: false, message };
  } finally {
    setBusy(false);
  }
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
async function previewDialog(items, degrees) {
  const todo = items.filter((i) => i.status === "todo");
  const unchanged = items.filter((i) => i.status === "unchanged");
  const errors = items.filter((i) => i.status === "error");
  if (!todo.length) return items; // rien à tourner : pas besoin de demander

  const answer = await showDialog((dialog) => {
    dialog.innerHTML = `
      <div class="preview">
        <sp-body size="S" id="intro"></sp-body>
        <sp-checkbox id="all" checked>Tout cocher</sp-checkbox>
        <div class="preview-list" id="list"></div>
        <footer>
          <sp-button variant="secondary" id="no">Annuler</sp-button>
          <sp-button variant="cta" id="yes"></sp-button>
        </footer>
      </div>`.trim();
    const parts = [`${todo.length} rush(s) à tourner en ${settings.rotationLabel(degrees)}`];
    if (unchanged.length) parts.push(`${unchanged.length} déjà dans ce sens`);
    if (errors.length) parts.push(`${errors.length} illisible(s)`);
    dialog.querySelector("#intro").textContent = parts.join(" · ");

    const list = dialog.querySelector("#list");
    const boxes = [];
    const itemOf = new Map();
    for (const item of todo) {
      const box = document.createElement("sp-checkbox");
      box.setAttribute("checked", "");
      box.textContent = `${item.entry.name}   ${settings.rotationLabel(item.previous)} → ${settings.rotationLabel(degrees)}`;
      itemOf.set(box, item);
      list.appendChild(box);
      boxes.push(box);
    }
    for (const item of unchanged) {
      const line = document.createElement("div");
      line.className = "line muted";
      line.textContent = `${item.entry.name}   déjà ${settings.rotationLabel(degrees)}`;
      list.appendChild(line);
    }
    for (const item of errors) {
      const line = document.createElement("div");
      line.className = "line error";
      line.textContent = `${item.entry.name}   ${item.error}`;
      list.appendChild(line);
    }

    const yes = dialog.querySelector("#yes");
    const isChecked = (b) => b.checked === true || (b.checked === undefined && b.hasAttribute("checked"));
    const update = () => {
      const n = boxes.filter(isChecked).length;
      yes.textContent = n ? `Tourner ${n} rush(s)` : "Rien de coché";
      setDisabled(yes, n === 0);
    };
    boxes.forEach((b) => b.addEventListener("change", update));
    dialog.querySelector("#all").addEventListener("change", (e) => {
      boxes.forEach((b) => {
        b.checked = e.target.checked;
        if (e.target.checked) b.setAttribute("checked", "");
        else b.removeAttribute("checked");
      });
      update();
    });
    update();
    yes.addEventListener("click", () => dialog.close(boxes.filter(isChecked).map((b) => itemOf.get(b))));
    dialog.querySelector("#no").addEventListener("click", () => dialog.close(null));
  }, { width: 440, height: 440 });

  return Array.isArray(answer) ? [...answer, ...unchanged] : null;
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
  const result = await runTask("Annulation en cours…", async () => {
    const r = await premiere.undoOperation(last, { log, onProgress });
    settings.popHistory(storage);
    const parts = [`${r.restored} remis comme avant`];
    if (r.skipped) parts.push(`${r.skipped} laissé(s) tel quel (modifié depuis)`);
    if (r.failed) parts.push(`${r.failed} échec(s)`);
    const message = `Annulation terminée : ${parts.join(", ")}.`;
    setSummary(message);
    log(message, r.failed ? "warn" : "ok");
    return { ok: !r.failed, message };
  });
  renderUndo();
  if (fromMenu && result && !result.ok) await showMessage(result.message);
}

/* ---------- Rotation ---------- */

function formatSummary(degrees, r, elapsed) {
  const parts = [`${r.done} tourné(s)`];
  if (r.unchanged) parts.push(`${r.unchanged} déjà à ${settings.rotationLabel(degrees)}`);
  if (r.failed) parts.push(`${r.failed} échec(s)`);
  const seconds = (elapsed / 1000).toFixed(1);
  return `${r.cancelled ? "Arrêté" : "Terminé"} en ${seconds} s : ${parts.join(", ")}.`;
}

async function runRotation(degrees) {
  const started = Date.now();
  return runTask("Analyse de la sélection…", async () => {
    const usePreview = settings.getBool(storage, "preview", true);
    const result = await premiere.rotateSelection(degrees, {
      log,
      onProgress,
      isCancelled: () => cancelRequested,
      confirm: usePreview ? (items) => previewDialog(items, degrees) : null,
    });
    if (result.aborted) {
      setSummary("Rotation annulée, aucun fichier modifié.");
      return { ok: true, message: "" };
    }
    if (result.operation) settings.pushHistory(storage, result.operation);

    const t = result.timings;
    const summary = formatSummary(degrees, result, Date.now() - started);
    setSummary(summary);
    log(summary, result.failed ? "warn" : "ok");
    log(`Détail : sélection ${t.collect} ms · fichiers ${t.files} ms · actualisation Premiere ${t.refresh} ms`, "info");

    // Proxys automatiques pour les rushs qui viennent d'être tournés.
    if (degrees !== 0 && result.operation && result.operation.files.length && settings.getBool(storage, "autoProxy", false)) {
      const paths = new Set(result.operation.files.map((f) => f.path));
      await startProxies(result.items.filter((i) => paths.has(i.entry.path)).map((i) => i.entry));
    }
    if (degrees === 0 && result.done) {
      log("Si ces rushs avaient des proxys verticaux, désactive les proxys ou recrée-les.", "info");
    }
    return { ok: !result.failed, message: summary };
  });
}

// Depuis le menu, on reste silencieux si tout s'est bien passé : on ne prévient qu'en cas de souci.
async function runFromMenu(degrees) {
  if (busy) return showMessage("Une opération est déjà en cours.");
  const result = await runRotation(degrees);
  renderUndo();
  if (result && !result.ok) await showMessage(result.message);
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
  onChange: (count) => {
    $("proxy-status").textContent = count
      ? `${count} proxy(s) en cours dans Media Encoder, attachés automatiquement à la fin.`
      : "";
  },
});

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

  setSummary("Préparation du préréglage vertical (une seule fois, environ 30 s)…");
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

async function startProxies(entries) {
  if (!entries.length) return 0;
  let preset;
  try {
    preset = await ensureProxyPreset();
  } catch (e) {
    log(`Proxys : ${errorMessage(e)}`, "error");
    return 0;
  }
  const queued = await proxies.create(entries, preset);
  if (queued) log(`${queued} proxy(s) envoyé(s) à Media Encoder.`, "ok");
  return queued;
}

async function makeProxiesForSelection() {
  await runTask("Recherche des rushs tournés…", async () => {
    const { clips } = await premiere.collectSelectedClips();
    // On ne fait des proxys verticaux que pour les rushs déjà tournés.
    const items = await premiere.inspectClips(clips, 0);
    const rotated = items.filter((i) => i.status === "todo").map((i) => i.entry);
    const horizontal = items.filter((i) => i.status === "unchanged").length;
    if (horizontal) log(`${horizontal} rush(s) horizontaux ignorés (tourne-les d'abord).`, "info");
    if (!rotated.length) {
      setSummary("Aucun rush tourné dans la sélection.");
      return { ok: true, message: "" };
    }
    const queued = await startProxies(rotated);
    setSummary(queued ? `${queued} proxy(s) en cours dans Media Encoder.` : "Aucun proxy lancé.");
    return { ok: queued > 0, message: "" };
  });
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

$("rotate-default").addEventListener("click", () => runRotation(defaultRotation).then(renderUndo));
$("undo").addEventListener("click", () => undoLast(false));
$("cancel").addEventListener("click", () => {
  cancelRequested = true;
  $("progress-label").textContent = "Arrêt après le clip en cours…";
});
$("clear-log").addEventListener("click", () => ($("log").textContent = ""));

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

document.querySelectorAll("[data-rotation]").forEach((button) => {
  button.addEventListener("click", () => runRotation(Number(button.getAttribute("data-rotation"))).then(renderUndo));
});

setChecked($("opt-preview"), settings.getBool(storage, "preview", true));
setChecked($("opt-auto-proxy"), settings.getBool(storage, "autoProxy", false));
renderDefault();
renderPreset();
renderUndo();
proxies.resume();

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
