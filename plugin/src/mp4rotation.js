/*
 * Lecture / écriture de la rotation d'affichage d'un fichier MP4 / MOV.
 *
 * Principe : dans un MP4 (ISO BMFF) ou un MOV (QuickTime), chaque piste possède
 * un en-tête "tkhd" qui contient une matrice d'affichage de 36 octets. C'est
 * exactement ce qu'utilisent les smartphones pour indiquer qu'une vidéo est
 * verticale. Modifier cette matrice :
 *   - ne touche à AUCUNE image (aucun ré-encodage, aucune perte),
 *   - ne change pas la taille du fichier (même nombre d'octets),
 *   - est instantané, même sur un rush 4K de plusieurs Go,
 *   - est réversible à 100 % (rotation 0 = matrice d'origine).
 *
 * Pour rester léger (cartes SD, disques réseau), on ne lit que les en-têtes des
 * boîtes utiles (quelques dizaines d'octets à chaque fois) au lieu de charger
 * tout l'index "moov" du fichier.
 *
 * Ce module ne dépend ni de Premiere ni de Node : il travaille sur un objet
 * "io" qui expose read/write/size. On peut donc le tester en dehors de Premiere.
 *
 *   io.size()                -> Promise<number>      taille du fichier
 *   io.read(position, len)   -> Promise<Uint8Array>  lit len octets
 *   io.write(position, data) -> Promise<void>        écrit data (Uint8Array)
 */

"use strict";

const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".m4v"];

const ROTATIONS = [0, 90, 180, 270];

// Garde-fou contre les fichiers corrompus (boucle infinie sur des boîtes vides).
const MAX_BOXES_PER_LEVEL = 10000;

function isSupportedPath(path) {
  const lower = String(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/* Lit l'en-tête de la boîte qui commence à `pos` (sans dépasser `end`). */
async function readBoxHeader(io, pos, end) {
  if (pos + 8 > end) return null;
  const header = await io.read(pos, Math.min(16, end - pos));
  const view = viewOf(header);
  let size = view.getUint32(0);
  const type = fourcc(header, 4);
  let headerSize = 8;
  if (size === 1) {
    if (header.length < 16) throw new Error(`Structure MP4 invalide (boîte "${type}" tronquée).`);
    size = view.getUint32(8) * 0x100000000 + view.getUint32(12);
    headerSize = 16;
  } else if (size === 0) {
    size = end - pos;
  }
  if (size < headerSize || pos + size > end) {
    throw new Error(`Structure MP4 invalide (boîte "${type}" corrompue).`);
  }
  return { type, start: pos, headerSize, end: pos + size };
}

/* Cherche les boîtes de type `types` entre start et end (un seul niveau). */
async function findBoxes(io, start, end, types, firstOnly) {
  const found = [];
  let pos = start;
  for (let n = 0; n < MAX_BOXES_PER_LEVEL; n++) {
    const box = await readBoxHeader(io, pos, end);
    if (!box) break;
    if (types.includes(box.type)) {
      found.push(box);
      if (firstOnly) break;
    }
    pos = box.end;
  }
  return found;
}

async function findChild(io, parent, type) {
  const [box] = await findBoxes(io, parent.start + parent.headerSize, parent.end, [type], true);
  return box || null;
}

/*
 * Retourne la liste des pistes vidéo avec la position absolue (dans le fichier)
 * de leur matrice, ainsi que leur largeur/hauteur stockées dans le tkhd.
 */
async function findVideoTracks(io) {
  const fileSize = await io.size();
  const [moov] = await findBoxes(io, 0, fileSize, ["moov"], true);
  if (!moov) {
    throw new Error("Aucune boîte \"moov\" trouvée : ce fichier n'est pas un MP4/MOV lisible.");
  }

  const tracks = [];
  for (const trak of await findBoxes(io, moov.start + moov.headerSize, moov.end, ["trak"], false)) {
    const children = await findBoxes(io, trak.start + trak.headerSize, trak.end, ["tkhd", "mdia"], false);
    const tkhd = children.find((b) => b.type === "tkhd");
    const mdia = children.find((b) => b.type === "mdia");
    if (!tkhd || !mdia) continue;

    // hdlr : version/flags (4) + pre_defined (4) + handler_type (4)
    const hdlr = await findChild(io, mdia, "hdlr");
    if (!hdlr || hdlr.end - hdlr.start < hdlr.headerSize + 12) continue;
    const handler = await io.read(hdlr.start + hdlr.headerSize + 8, 4);
    if (fourcc(handler, 0) !== "vide") continue;

    const tkhdBytes = await io.read(tkhd.start, tkhd.end - tkhd.start);
    const content = tkhd.headerSize;
    const version = tkhdBytes[content];
    // version 0 : dates/durée sur 32 bits (20 octets), version 1 : sur 64 bits (32 octets)
    // puis reserved(8) + layer(2) + alternate_group(2) + volume(2) + reserved(2) = 16 octets
    const matrixOffset = content + 4 + (version === 1 ? 32 : 20) + 16;
    if (matrixOffset + 36 + 8 > tkhdBytes.length) {
      throw new Error("En-tête de piste \"tkhd\" tronqué.");
    }
    const view = viewOf(tkhdBytes);
    tracks.push({
      matrixPosition: tkhd.start + matrixOffset,
      matrix: readMatrix(view, matrixOffset),
      width: view.getUint32(matrixOffset + 36) / 65536,
      height: view.getUint32(matrixOffset + 40) / 65536,
    });
  }
  if (tracks.length === 0) {
    throw new Error("Aucune piste vidéo trouvée dans ce fichier.");
  }
  return tracks;
}

function readMatrix(view, offset) {
  const m = [];
  for (let i = 0; i < 9; i++) m.push(view.getInt32(offset + i * 4));
  return m;
}

/*
 * Construit la matrice tkhd pour une rotation horaire de `degrees`.
 * Mêmes valeurs que celles écrites par ffmpeg / les iPhone.
 * Format : [a b u | c d v | tx ty w], a..ty en 16.16, u/v/w en 2.30.
 */
function buildMatrix(degrees, width, height) {
  const one = 0x10000;
  const w = Math.round(width) * one;
  const h = Math.round(height) * one;
  const W = 0x40000000;
  switch (degrees) {
    case 0:
      return [one, 0, 0, 0, one, 0, 0, 0, W];
    case 90:
      return [0, one, 0, -one, 0, 0, h, 0, W];
    case 180:
      return [-one, 0, 0, 0, -one, 0, w, h, W];
    case 270:
      return [0, -one, 0, one, 0, 0, 0, w, W];
    default:
      throw new Error(`Rotation non supportée : ${degrees}° (valeurs possibles : ${ROTATIONS.join(", ")}).`);
  }
}

/* Déduit la rotation (0/90/180/270) d'une matrice, ou null si ce n'est pas une rotation simple. */
function matrixToRotation(m) {
  const a = Math.sign(m[0]);
  const b = Math.sign(m[1]);
  const c = Math.sign(m[3]);
  const d = Math.sign(m[4]);
  if (a > 0 && b === 0 && c === 0 && d > 0) return 0;
  if (a === 0 && b > 0 && c < 0 && d === 0) return 90;
  if (a < 0 && b === 0 && c === 0 && d < 0) return 180;
  if (a === 0 && b < 0 && c > 0 && d === 0) return 270;
  return null;
}

function encodeMatrix(m) {
  const bytes = new Uint8Array(36);
  const view = new DataView(bytes.buffer);
  m.forEach((value, i) => view.setInt32(i * 4, value));
  return bytes;
}

/* Rotation actuelle de la première piste vidéo. */
async function getRotation(io) {
  const tracks = await findVideoTracks(io);
  return matrixToRotation(tracks[0].matrix);
}

function toHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

/*
 * Prépare une rotation absolue (0, 90, 180 ou 270 degrés, sens horaire) en
 * lecture seule. Retourne { previous, rotation, writes } : `writes` est vide si
 * le fichier est déjà dans le bon sens (aucune écriture nécessaire).
 * Chaque écriture garde les octets d'origine (`before`, hexadécimal) pour
 * pouvoir annuler exactement.
 */
async function planRotation(io, degrees) {
  const tracks = await findVideoTracks(io);
  const writes = [];
  for (const track of tracks) {
    const target = buildMatrix(degrees, track.width, track.height);
    if (target.every((v, i) => v === track.matrix[i])) continue;
    writes.push({
      position: track.matrixPosition,
      bytes: encodeMatrix(target),
      before: toHex(encodeMatrix(track.matrix)),
    });
  }
  return { previous: matrixToRotation(tracks[0].matrix), rotation: degrees, writes };
}

async function applyPlan(io, plan) {
  for (const { position, bytes } of plan.writes) await io.write(position, bytes);
}

/* Raccourci lecture + écriture sur le même accès fichier. Retourne { previous, rotation, changed }. */
async function setRotation(io, degrees) {
  const plan = await planRotation(io, degrees);
  await applyPlan(io, plan);
  return { previous: plan.previous, rotation: degrees, changed: plan.writes.length > 0 };
}

/*
 * Annulation : remet les octets d'origine (`before`) à chaque position, mais
 * seulement si le fichier contient toujours ce que le plugin y a écrit
 * (`after`). Sinon le fichier a été modifié entre-temps : on n'y touche pas.
 * changes : [{ position, before, after }] (hexadécimal). Retourne "restored" | "unchanged" | "modified".
 */
async function restoreBytes(io, changes) {
  let alreadyRestored = 0;
  for (const c of changes) {
    const current = toHex(await io.read(c.position, c.before.length / 2));
    if (current === c.before) alreadyRestored++;
    else if (current !== c.after) return "modified";
  }
  if (alreadyRestored === changes.length) return "unchanged";
  for (const c of changes) await io.write(c.position, fromHex(c.before));
  return "restored";
}

/*
 * Vrai si le fichier est un MP4/MOV complet (boîte "moov" présente et
 * structure lisible jusqu'au bout). Sert à savoir si Media Encoder a fini
 * d'écrire un proxy : tant que l'encodage tourne, le "moov" n'existe pas encore.
 */
async function isComplete(io) {
  try {
    const size = await io.size();
    const boxes = await findBoxes(io, 0, size, ["moov"], false);
    return boxes.length > 0;
  } catch (e) {
    return false;
  }
}

module.exports = {
  ROTATIONS,
  SUPPORTED_EXTENSIONS,
  isSupportedPath,
  getRotation,
  planRotation,
  applyPlan,
  setRotation,
  restoreBytes,
  isComplete,
  toHex,
  // exportés pour les tests
  buildMatrix,
  matrixToRotation,
  findVideoTracks,
};
