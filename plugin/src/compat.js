/*
 * Vérification de compatibilité au démarrage : si une mise à jour de Premiere
 * retire ou renomme une fonction dont le plugin a besoin, on le dit clairement
 * au lieu d'échouer au milieu d'une rotation.
 */

"use strict";

// Fonctions indispensables (rotation) et optionnelles (proxys).
const REQUIRED = [
  "Project.getActiveProject",
  "ProjectUtils.getSelection",
  "ProjectItem.TYPE_CLIP",
  "ProjectItem.TYPE_BIN",
  "ClipProjectItem.cast",
  "FolderItem.cast",
];
const OPTIONAL = ["EncoderManager.getManager", "TickTime.createWithSeconds", "EventManager.addEventListener"];

function has(root, path) {
  let node = root;
  for (const key of path.split(".")) {
    if (node === null || node === undefined) return false;
    try {
      node = node[key];
    } catch (e) {
      return false;
    }
  }
  return node !== undefined && node !== null;
}

/* Renvoie { missingRequired: [...], missingOptional: [...] }. */
function checkCompatibility(ppro) {
  return {
    missingRequired: REQUIRED.filter((p) => !has(ppro, p)),
    missingOptional: OPTIONAL.filter((p) => !has(ppro, p)),
  };
}

module.exports = { checkCompatibility, REQUIRED, OPTIONAL };
