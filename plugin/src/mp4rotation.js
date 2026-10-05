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
 * Ce module ne dépend ni de Premiere ni de Node : il travaille sur un objet
 * "io" qui expose read/write/size. On peut donc le tester en dehors de Premiere.
 *
 *   io.size()                -> Promise<number>      taille du fichier
 *   io.read(position, len)   -> Promise<Uint8Array>  lit len octets
 *   io.write(position, data) -> Promise<void>        écrit data (Uint8Array)
 */

"use strict";

const SUPPORTED_EXTENSIONS = [".mp4", ".mov", ".m4v"];

// Le moov d'un rush caméra fait quelques centaines de Ko à quelques Mo.
// Au-delà, on préfère refuser plutôt que de charger un fichier aberrant en mémoire.
const MAX_MOOV_SIZE = 256 * 1024 * 1024;

const ROTATIONS = [0, 90, 180, 270];

function isSupportedPath(path) {
  const lower = String(path).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readUint64(view, offset) {
  const high = view.getUint32(offset);
  const low = view.getUint32(offset + 4);
  return high * 0x100000000 + low;
}

/*
 * Parcourt les boîtes (atoms) contenues dans bytes[start, end[.
 * Retourne [{ type, start, headerSize, end }] où start/end sont relatifs à bytes.
 */
function listBoxes(bytes, start, end) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = fourcc(bytes, pos + 4);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = readUint64(view, pos + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < headerSize || pos + size > end) {
      throw new Error(`Structure MP4 invalide (boîte "${type}" corrompue).`);
    }
    boxes.push({ type, start: pos, headerSize, end: pos + size });
    pos += size;
  }
  return boxes;
}

function findChild(bytes, parent, type) {
  return listBoxes(bytes, parent.start + parent.headerSize, parent.end).find((b) => b.type === type);
}

/* Localise la boîte "moov" en ne lisant que les en-têtes des boîtes de premier niveau. */
async function locateMoov(io) {
  const fileSize = await io.size();
  let pos = 0;
  while (pos + 8 <= fileSize) {
    const header = await io.read(pos, Math.min(16, fileSize - pos));
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(header, 4);
    if (size === 1) {
      if (header.length < 16) break;
      size = readUint64(view, 8);
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < 8) {
      throw new Error(`Structure MP4 invalide à l'octet ${pos}.`);
    }
    if (type === "moov") {
      return { position: pos, size };
    }
    pos += size;
  }
  throw new Error("Aucune boîte \"moov\" trouvée : ce fichier n'est pas un MP4/MOV lisible.");
}

/*
 * Retourne la liste des pistes vidéo avec la position absolue (dans le fichier)
 * de leur matrice, ainsi que leur largeur/hauteur stockées dans le tkhd.
 */
async function findVideoTracks(io) {
  const moovInfo = await locateMoov(io);
  if (moovInfo.size > MAX_MOOV_SIZE) {
    throw new Error("En-tête \"moov\" anormalement volumineux, fichier ignoré.");
  }
  const moovBytes = await io.read(moovInfo.position, moovInfo.size);
  const view = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
  const moov = listBoxes(moovBytes, 0, moovBytes.length)[0];

  const tracks = [];
  for (const trak of listBoxes(moovBytes, moov.start + moov.headerSize, moov.end)) {
    if (trak.type !== "trak") continue;

    const mdia = findChild(moovBytes, trak, "mdia");
    const hdlr = mdia && findChild(moovBytes, mdia, "hdlr");
    // hdlr : version/flags (4) + pre_defined (4) + handler_type (4)
    if (!hdlr || fourcc(moovBytes, hdlr.start + hdlr.headerSize + 8) !== "vide") continue;

    const tkhd = findChild(moovBytes, trak, "tkhd");
    if (!tkhd) continue;
    const content = tkhd.start + tkhd.headerSize;
    const version = moovBytes[content];
    // version 0 : dates/durée sur 32 bits (20 octets), version 1 : sur 64 bits (32 octets)
    // puis reserved(8) + layer(2) + alternate_group(2) + volume(2) + reserved(2) = 16 octets
    const matrixOffset = content + 4 + (version === 1 ? 32 : 20) + 16;
    if (matrixOffset + 36 + 8 > tkhd.end) {
      throw new Error("En-tête de piste \"tkhd\" tronqué.");
    }
    tracks.push({
      matrixPosition: moovInfo.position + matrixOffset,
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

/*
 * Applique une rotation absolue (0, 90, 180 ou 270 degrés, sens horaire).
 * Retourne { previous, rotation, changed }.
 */
async function setRotation(io, degrees) {
  const tracks = await findVideoTracks(io);
  const previous = matrixToRotation(tracks[0].matrix);
  let changed = false;
  for (const track of tracks) {
    const target = buildMatrix(degrees, track.width, track.height);
    if (target.every((v, i) => v === track.matrix[i])) continue;
    await io.write(track.matrixPosition, encodeMatrix(target));
    changed = true;
  }
  return { previous, rotation: degrees, changed };
}

/* Rotation suivante quand on tourne de `delta` degrés à partir de `current`. */
function addRotation(current, delta) {
  return ((((current || 0) + delta) % 360) + 360) % 360;
}

module.exports = {
  ROTATIONS,
  SUPPORTED_EXTENSIONS,
  isSupportedPath,
  getRotation,
  setRotation,
  addRotation,
  // exportés pour les tests
  buildMatrix,
  matrixToRotation,
  findVideoTracks,
};
