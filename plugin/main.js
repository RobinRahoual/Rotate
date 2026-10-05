"use strict";

const { rotateSelection } = require("./src/premiere.js");

let busy = false;

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

document.querySelectorAll("[data-rotation]").forEach((button) => {
  button.addEventListener("click", () => onRotate(Number(button.getAttribute("data-rotation"))));
});
