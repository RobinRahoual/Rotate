"use strict";

const { entrypoints } = require("uxp");
const { rotateSelection } = require("./src/premiere.js");
const settings = require("./src/settings.js");

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

/* ---------- Progression ---------- */

function setBusy(value) {
  busy = value;
  if (value) $("progress").classList.remove("hidden");
  else $("progress").classList.add("hidden");
  const buttons = [$("rotate-default"), ...document.querySelectorAll("[data-rotation]")];
  buttons.forEach((b) => (value ? b.setAttribute("disabled", "") : b.removeAttribute("disabled")));
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

function formatSummary(degrees, r, elapsed) {
  const parts = [`${r.done} tourné(s)`];
  if (r.unchanged) parts.push(`${r.unchanged} déjà à ${degrees}°`);
  if (r.failed) parts.push(`${r.failed} échec(s)`);
  const seconds = (elapsed / 1000).toFixed(1);
  return `${r.cancelled ? "Annulé" : "Terminé"} en ${seconds} s : ${parts.join(", ")}.`;
}

/* ---------- Action principale ---------- */

async function runRotation(degrees) {
  if (busy) return null;
  cancelRequested = false;
  setBusy(true);
  onProgress(0, 0, "");
  setSummary("Analyse de la sélection…");
  const started = Date.now();
  try {
    const result = await rotateSelection(degrees, {
      log,
      onProgress,
      isCancelled: () => cancelRequested,
    });
    const t = result.timings;
    const summary = formatSummary(degrees, result, Date.now() - started);
    setSummary(summary);
    log(summary, result.failed ? "warn" : "ok");
    log(`Détail : sélection ${t.collect} ms · fichiers ${t.files} ms · actualisation Premiere ${t.refresh} ms`, "info");
    return { ok: !result.failed, message: summary };
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    setSummary(message);
    log(message, "error");
    return { ok: false, message };
  } finally {
    setBusy(false);
  }
}

/* Petite boîte de dialogue, utilisée quand l'action est lancée depuis le menu. */
async function showMessage(text) {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <sp-body size="S"></sp-body>
    <footer><sp-button variant="cta" id="ok">OK</sp-button></footer>`.trim();
  dialog.querySelector("sp-body").textContent = text;
  dialog.querySelector("#ok").addEventListener("click", () => dialog.close());
  document.body.appendChild(dialog);
  try {
    await dialog.uxpShowModal({ title: "Rotate", resize: "none", size: { width: 320, height: 160 } });
  } finally {
    dialog.remove();
  }
}

// Depuis le menu, on reste silencieux si tout s'est bien passé : on ne prévient qu'en cas de souci.
async function runFromMenu(degrees) {
  if (busy) return showMessage("Une rotation est déjà en cours.");
  const result = await runRotation(degrees);
  if (result && !result.ok) await showMessage(result.message);
}

/* ---------- Sens par défaut ---------- */

function renderDefault() {
  $("rotate-default").textContent = `Tourner en vertical  ${settings.rotationLabel(defaultRotation)}`;
  document.querySelectorAll("#default-choice sp-radio").forEach((radio) => {
    if (Number(radio.getAttribute("value")) === defaultRotation) radio.setAttribute("checked", "");
    else radio.removeAttribute("checked");
  });
}

/* ---------- Événements ---------- */

$("rotate-default").addEventListener("click", () => runRotation(defaultRotation));
$("cancel").addEventListener("click", () => {
  cancelRequested = true;
  $("progress-label").textContent = "Annulation après le clip en cours…";
});
$("clear-log").addEventListener("click", () => ($("log").textContent = ""));

$("default-choice").addEventListener("change", (event) => {
  defaultRotation = settings.setDefaultRotation(storage, Number(event.target.value));
  renderDefault();
});

document.querySelectorAll("[data-rotation]").forEach((button) => {
  button.addEventListener("click", () => runRotation(Number(button.getAttribute("data-rotation"))));
});

renderDefault();

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
  },
});
