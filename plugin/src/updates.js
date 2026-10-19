/*
 * Vérification des mises à jour : au démarrage, le plugin regarde sur GitHub
 * si une version plus récente a été publiée (au plus une fois toutes les
 * 6 heures, pour rester discret et respecter les limites de GitHub).
 *
 * Un plugin UXP ne peut pas s'installer lui-même : on propose de télécharger
 * le pack d'installation et d'ouvrir la page de la version.
 */

"use strict";

const REPO = "RobinRahoual/Rotate";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const KEY_LAST_CHECK = "rotate.update.lastCheck";
const KEY_LATEST = "rotate.update.latest";
const KEY_DISMISSED = "rotate.update.dismissed";

/* Compare deux versions « 1.2.3 » (un « v » devant est accepté). Renvoie -1, 0 ou 1. */
function compareVersions(a, b) {
  const parse = (v) => String(v || "").replace(/^v/i, "").split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

function safeGet(storage, key) {
  try {
    return storage.getItem(key);
  } catch (e) {
    return null;
  }
}

function safeSet(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (e) {
    // stockage indisponible : on revérifiera au prochain démarrage
  }
}

/* Informations utiles d'une release GitHub. */
function parseRelease(release) {
  if (!release || !release.tag_name) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const pick = (re) => (assets.find((a) => re.test(a.name || "")) || {}).browser_download_url || "";
  return {
    version: String(release.tag_name).replace(/^v/i, ""),
    pageUrl: release.html_url || RELEASES_URL,
    // Le pack (scripts de secours inclus) d'abord, sinon le .ccx seul.
    downloadUrl: pick(/-installation\.zip$/i) || pick(/\.ccx$/i) || release.html_url || RELEASES_URL,
  };
}

/*
 * Vérifie si une version plus récente existe.
 * deps : { fetch, storage, currentVersion, now(), force }
 * Renvoie { version, pageUrl, downloadUrl } si une mise à jour est disponible
 * (et pas ignorée par l'utilisateur), sinon null. Ne lève jamais d'erreur :
 * pas de réseau = pas de bandeau.
 */
async function checkForUpdate(deps) {
  const now = deps.now ? deps.now() : Date.now();
  const last = Number(safeGet(deps.storage, KEY_LAST_CHECK)) || 0;
  let latest = null;

  if (!deps.force && last && now - last < CHECK_EVERY_MS) {
    // Vérifié récemment : on réutilise le dernier résultat sans interroger GitHub.
    try {
      latest = JSON.parse(safeGet(deps.storage, KEY_LATEST) || "null");
    } catch (e) {
      latest = null;
    }
  } else {
    try {
      const response = await deps.fetch(API_URL, { headers: { Accept: "application/vnd.github+json" } });
      if (!response || !response.ok) return null;
      latest = parseRelease(await response.json());
      safeSet(deps.storage, KEY_LAST_CHECK, String(now));
      safeSet(deps.storage, KEY_LATEST, JSON.stringify(latest));
    } catch (e) {
      return null;
    }
  }

  if (!latest || compareVersions(latest.version, deps.currentVersion) <= 0) return null;
  if (!deps.force && safeGet(deps.storage, KEY_DISMISSED) === latest.version) return null;
  return latest;
}

/* « Plus tard » : ne plus afficher le bandeau pour cette version précise. */
function dismissUpdate(storage, version) {
  safeSet(storage, KEY_DISMISSED, version);
}

module.exports = { REPO, API_URL, RELEASES_URL, CHECK_EVERY_MS, compareVersions, parseRelease, checkForUpdate, dismissUpdate };
