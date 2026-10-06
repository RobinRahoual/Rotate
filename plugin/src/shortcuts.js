/*
 * Raccourcis clavier du panneau Rotate (actifs quand le panneau a le focus :
 * Premiere ne permet pas encore aux plugins de déclarer des raccourcis globaux).
 * Une touche simple (lettre ou chiffre) par action, au choix de l'utilisateur.
 */

"use strict";

const ACTIONS = {
  rotateDefault: "Tourner (sens par défaut)",
  rotateReset: "Remettre à l'horizontale",
  undo: "Annuler la dernière opération",
  proxies: "Créer les proxys de la sélection",
};

const DEFAULTS = { rotateDefault: "V", rotateReset: "H", undo: "U", proxies: "P" };

/* Touche utilisable comme raccourci (lettre ou chiffre, sans Ctrl/Cmd/Alt), sinon null. */
function normalizeKey(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey) return null;
  const key = String(event.key || "");
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  // Clavier AZERTY : les chiffres sans Maj donnent & é " ' ( … ; on se rabat sur le code physique.
  const code = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(String(event.code || ""));
  return code ? code[1] || code[2] : null;
}

/* Complète une configuration enregistrée avec les valeurs par défaut. */
function withDefaults(saved) {
  const map = { ...DEFAULTS };
  if (saved && typeof saved === "object") {
    for (const action of Object.keys(ACTIONS)) {
      if (action in saved) map[action] = /^[A-Z0-9]$/.test(saved[action]) ? saved[action] : "";
    }
  }
  return map;
}

/* Attribue `key` à `action` ; la touche est retirée de l'action qui l'utilisait. "" = aucune touche. */
function assign(map, action, key) {
  const next = { ...map };
  if (key) {
    for (const other of Object.keys(next)) if (next[other] === key) next[other] = "";
  }
  next[action] = key || "";
  return next;
}

function actionFor(map, key) {
  if (!key) return null;
  return Object.keys(map).find((action) => map[action] === key) || null;
}

module.exports = { ACTIONS, DEFAULTS, normalizeKey, withDefaults, assign, actionFor };
