/*
 * Préférences et historique du plugin, conservés d'une session Premiere à
 * l'autre (window.localStorage de UXP, propre à ce plugin). Toutes les
 * fonctions prennent l'objet de stockage en paramètre pour être testables.
 */

"use strict";

const KEYS = {
  defaultRotation: "rotate.defaultRotation",
  preview: "rotate.preview",
  proxyPreset: "rotate.proxyPreset",
  autoProxy: "rotate.autoProxy",
  history: "rotate.history",
  pendingProxies: "rotate.pendingProxies",
};

// Sens proposés comme rotation par défaut (degrés, sens horaire). 270 = -90°.
const DEFAULT_CHOICES = [90, 270, 180];
const FALLBACK_DEFAULT = 270;
const MAX_HISTORY = 10;

function read(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (e) {
    // Préférence non sauvegardée : elle reste active jusqu'à la fermeture du panneau.
  }
}

function readJSON(storage, key, fallback) {
  try {
    const raw = read(storage, key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

/* ---------- Sens par défaut ---------- */

function getDefaultRotation(storage) {
  const value = Number(read(storage, KEYS.defaultRotation));
  return DEFAULT_CHOICES.includes(value) ? value : FALLBACK_DEFAULT;
}

function setDefaultRotation(storage, degrees) {
  if (!DEFAULT_CHOICES.includes(degrees)) {
    throw new Error(`Sens par défaut invalide : ${degrees}°`);
  }
  write(storage, KEYS.defaultRotation, String(degrees));
  return degrees;
}

/* ---------- Options simples ---------- */

function getBool(storage, key, fallback) {
  const raw = read(storage, KEYS[key]);
  return raw === null ? fallback : raw === "1";
}

function setBool(storage, key, value) {
  write(storage, KEYS[key], value ? "1" : "0");
  return !!value;
}

function getString(storage, key) {
  return read(storage, KEYS[key]) || "";
}

function setString(storage, key, value) {
  write(storage, KEYS[key], String(value || ""));
}

function getJSON(storage, key, fallback) {
  return readJSON(storage, KEYS[key], fallback);
}

function setJSON(storage, key, value) {
  write(storage, KEYS[key], JSON.stringify(value));
}

/* ---------- Historique (pour « Annuler la dernière opération ») ---------- */

/*
 * Une opération : { date, rotation, files: [{ path, name, changes: [{ position, before, after }] }] }
 */
function pushHistory(storage, operation) {
  if (!operation.files.length) return;
  const history = readJSON(storage, KEYS.history, []);
  history.push(operation);
  while (history.length > MAX_HISTORY) history.shift();
  write(storage, KEYS.history, JSON.stringify(history));
}

function lastHistory(storage) {
  const history = readJSON(storage, KEYS.history, []);
  return history.length ? history[history.length - 1] : null;
}

function popHistory(storage) {
  const history = readJSON(storage, KEYS.history, []);
  const last = history.pop() || null;
  write(storage, KEYS.history, JSON.stringify(history));
  return last;
}

/* Libellé court d'une rotation, ex. 270 -> "↺ -90°". */
function rotationLabel(degrees) {
  switch (degrees) {
    case 90:
      return "↻ +90°";
    case 270:
      return "↺ -90°";
    case 180:
      return "180°";
    case null:
    case undefined:
      return "?";
    default:
      return "0°";
  }
}

module.exports = {
  DEFAULT_CHOICES,
  FALLBACK_DEFAULT,
  MAX_HISTORY,
  getDefaultRotation,
  setDefaultRotation,
  getBool,
  setBool,
  getString,
  setString,
  getJSON,
  setJSON,
  pushHistory,
  lastHistory,
  popHistory,
  rotationLabel,
};
