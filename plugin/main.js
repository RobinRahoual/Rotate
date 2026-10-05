"use strict";

const { rotateSelection } = require("./src/premiere.js");
const settings = require("./src/settings.js");

// localStorage peut être indisponible : les préférences restent alors en mémoire.
const memory = new Map();
const storage = (() => {
  try {
    return window.localStorage || null;
  } catch (e) {
    return null;
  }
})() || { getItem: (k) => (memory.has(k) ? memory.get(k) : null), setItem: (k, v) => memory.set(k, String(v)) };

let busy = false;
let defaultRotation = settings.getDefaultRotation(storage);

function log(message, level = "info") {
  const line = document.createElement("div");
  line.className = level;
  line.textContent = message;
  document.getElementById("log").appendChild(line);
}

async function onRotate(degrees) {
  if (busy) return;
  busy = true;
  document.getElementById("log").textContent = "";
  const started = Date.now();
  try {
    const { done, unchanged, failed } = await rotateSelection(degrees, log);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    log(`Terminé en ${seconds} s : ${done} modifié(s), ${unchanged} inchangé(s), ${failed} échec(s).`, failed ? "warn" : "ok");
  } catch (e) {
    log(e && e.message ? e.message : String(e), "error");
  } finally {
    busy = false;
  }
}

function renderDefault() {
  document.getElementById("rotate-default").textContent = `Tourner en vertical (${settings.rotationLabel(defaultRotation)})`;
  document.querySelectorAll("#default-choice sp-radio").forEach((radio) => {
    if (Number(radio.getAttribute("value")) === defaultRotation) radio.setAttribute("checked", "");
    else radio.removeAttribute("checked");
  });
}

document.getElementById("rotate-default").addEventListener("click", () => onRotate(defaultRotation));

document.getElementById("default-choice").addEventListener("change", (event) => {
  defaultRotation = settings.setDefaultRotation(storage, Number(event.target.value));
  renderDefault();
});

document.querySelectorAll("[data-rotation]").forEach((button) => {
  button.addEventListener("click", () => onRotate(Number(button.getAttribute("data-rotation"))));
});

renderDefault();
