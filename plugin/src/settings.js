/*
 * Préférences du plugin, conservées d'une session Premiere à l'autre
 * (window.localStorage de UXP, propre à ce plugin).
 */

"use strict";

const KEY_DEFAULT_ROTATION = "rotate.defaultRotation";

// Sens proposés comme rotation par défaut (degrés, sens horaire). 270 = -90°.
const DEFAULT_CHOICES = [90, 270, 180];
const FALLBACK_DEFAULT = 270;

function getDefaultRotation(storage) {
  try {
    const value = Number(storage.getItem(KEY_DEFAULT_ROTATION));
    return DEFAULT_CHOICES.includes(value) ? value : FALLBACK_DEFAULT;
  } catch (e) {
    return FALLBACK_DEFAULT;
  }
}

function setDefaultRotation(storage, degrees) {
  if (!DEFAULT_CHOICES.includes(degrees)) {
    throw new Error(`Sens par défaut invalide : ${degrees}°`);
  }
  try {
    storage.setItem(KEY_DEFAULT_ROTATION, String(degrees));
  } catch (e) {
    // Préférence non sauvegardée : elle reste active jusqu'à la fermeture du panneau.
  }
  return degrees;
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
    default:
      return "0°";
  }
}

module.exports = { DEFAULT_CHOICES, FALLBACK_DEFAULT, getDefaultRotation, setDefaultRotation, rotationLabel };
