/*
 * Préréglage Media Encoder pour les proxys verticaux, créé automatiquement.
 *
 * 1. On cherche les préréglages livrés par Adobe sur l'ordinateur (dossier
 *    MediaIO/systempresets de Media Encoder / Premiere), de préférence
 *    « Apple ProRes 422 Proxy » (QuickTime).
 * 2. On en fait une copie dont la taille d'image est verticale (720×1280 par
 *    défaut), la cadence restant celle de la source.
 * 3. On vérifie la copie avec un encodage test d'une seconde (petite vidéo
 *    fournie avec le plugin) : taille et cadence doivent être exactement
 *    celles attendues. La façon dont Media Encoder enregistre la case
 *    « Identique à la source » varie selon les versions : on essaie les
 *    variantes possibles et on garde celle qui fonctionne.
 */

"use strict";

const { decompress, utf8Decode } = require("./inflate.js");

const SIZES = {
  "540x960": { width: 540, height: 960 },
  "720x1280": { width: 720, height: 1280 },
  "1080x1920": { width: 1080, height: 1920 },
};
const DEFAULT_SIZE = "720x1280";

// Dossiers de Media Encoder : <ExporterClassID>_<ExporterFileType> en hexadécimal.
const QUICKTIME_FOLDER = /_4D6F6F56$/i; // 'MooV'
const H264_FOLDER = /_48323634$/i; // 'H264'

function scorePreset(folder, file) {
  const name = file.toLowerCase();
  if (QUICKTIME_FOLDER.test(folder)) {
    if (/prores 422 proxy/.test(name)) return 100;
    if (/prores 422 lt/.test(name)) return 80;
    if (/prores 422(?! hq)/.test(name) && !/4444/.test(name)) return 60;
  }
  if (H264_FOLDER.test(folder) && /match source/.test(name)) {
    if (/medium/.test(name)) return 40;
    if (/low/.test(name)) return 35;
    return 30;
  }
  return 0;
}

/* Dossiers de préréglages système possibles, du plus récent au plus ancien. */
async function systemPresetRoots(fs, platform) {
  const mac = platform === "darwin";
  const base = mac ? "/Applications" : "C:\\Program Files\\Adobe";
  const sep = mac ? "/" : "\\";
  let apps = [];
  try {
    apps = await fs.readdir(base);
  } catch (e) {
    return [];
  }
  const roots = [];
  apps
    .filter((n) => /^Adobe (Media Encoder|Premiere Pro)/.test(n))
    .sort((a, b) => (a.includes("Media Encoder") === b.includes("Media Encoder") ? b.localeCompare(a) : a.includes("Media Encoder") ? -1 : 1))
    .forEach((app) => {
      if (mac) {
        roots.push(`${base}/${app}/${app}.app/Contents/MediaIO/systempresets`);
        roots.push(`${base}/${app}/Contents/MediaIO/systempresets`);
      } else {
        roots.push(`${base}${sep}${app}${sep}MediaIO${sep}systempresets`);
      }
    });
  return roots.map((path) => ({ path, sep }));
}

/* Liste les préréglages utilisables comme modèle, les meilleurs d'abord. */
async function findTemplates(fs, platform) {
  const found = [];
  for (const root of await systemPresetRoots(fs, platform)) {
    let folders = [];
    try {
      folders = await fs.readdir(root.path);
    } catch (e) {
      continue;
    }
    for (const folder of folders) {
      if (!QUICKTIME_FOLDER.test(folder) && !H264_FOLDER.test(folder)) continue;
      let files = [];
      try {
        files = await fs.readdir(`${root.path}${root.sep}${folder}`);
      } catch (e) {
        continue;
      }
      for (const file of files) {
        if (!/\.epr$/i.test(file)) continue;
        const score = scorePreset(folder, file);
        if (score) found.push({ path: `${root.path}${root.sep}${folder}${root.sep}${file}`, name: file.replace(/\.epr$/i, ""), score });
      }
    }
  }
  return found.sort((a, b) => b.score - a.score);
}

function decodePreset(bytes) {
  return utf8Decode(decompress(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
}

function uuid() {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) out += hex[Math.floor(Math.random() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Remplace la valeur d'une balise simple à l'intérieur d'un bloc XML. */
function setTag(block, tag, value) {
  const re = new RegExp(`<${tag}>[^<]*</${tag}>`);
  return re.test(block) ? block.replace(re, `<${tag}>${value}</${tag}>`) : block;
}

function getTag(block, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return m ? m[1] : null;
}

/*
 * Copie verticale d'un préréglage. `optionalEnabled` décide de la valeur de
 * IsOptionalParamEnabled pour largeur/hauteur (null = laisser tel quel).
 */
function makeVerticalPreset(xml, { width, height, name, optionalEnabled, fpsOptionalEnabled = null }) {
  let foundWidth = false;
  let foundHeight = false;
  let out = xml.replace(/<ExporterParam\b[^>]*>[\s\S]*?<\/ExporterParam>/g, (block) => {
    const id = getTag(block, "ParamIdentifier");
    if (id === "ADBEVideoWidth" || id === "ADBEVideoHeight") {
      if (id === "ADBEVideoWidth") foundWidth = true;
      else foundHeight = true;
      let b = setTag(block, "ParamValue", id === "ADBEVideoWidth" ? width : height);
      if (optionalEnabled !== null && getTag(b, "IsOptionalParam") === "true") {
        b = setTag(b, "IsOptionalParamEnabled", optionalEnabled ? "true" : "false");
      }
      return b;
    }
    if (id === "ADBEVideoMatchSource") return setTag(block, "ParamValue", "false");
    if (id === "ADBEVideoFPS" && fpsOptionalEnabled !== null && getTag(block, "IsOptionalParam") === "true") {
      return setTag(block, "IsOptionalParamEnabled", fpsOptionalEnabled ? "true" : "false");
    }
    return block;
  });
  if (!foundWidth || !foundHeight) throw new Error("préréglage sans réglage de taille d'image");
  out = setTag(out, "PresetName", escapeXml(name));
  out = setTag(out, "PresetID", uuid());
  return out;
}

/*
 * Variantes à essayer (sans doublon) : d'abord la case « taille identique à la
 * source » décochée/cochée, puis, si seule la cadence est fausse, la case de
 * la cadence. Chaque variante : { text, sizeFlag, fpsFlag }.
 */
function presetVariants(xml, size, name, fpsFlags = [null]) {
  const seen = new Set();
  const out = [];
  for (const fpsOptionalEnabled of fpsFlags) {
    for (const optionalEnabled of [false, true, null]) {
      const text = makeVerticalPreset(xml, { ...size, name, optionalEnabled, fpsOptionalEnabled });
      const key = text.replace(/<PresetID>[^<]*<\/PresetID>/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text, sizeFlag: optionalEnabled, fpsFlag: fpsOptionalEnabled });
    }
  }
  return out;
}

/*
 * Crée et vérifie le préréglage. deps : {
 *   fs, platform, dataFolder, calibrationFile, rotation, withFile,
 *   encodeTest(input, output, preset) -> Promise<boolean>   lance l'encodage test
 *   waitForFile(path, timeoutMs) -> Promise<boolean>        attend un MP4/MOV complet
 *   log(message, level)
 * }
 * Retourne { path, template, size }.
 */
async function createVerticalPreset(deps, sizeKey) {
  const log = deps.log || (() => {});
  const size = SIZES[sizeKey] || SIZES[DEFAULT_SIZE];
  const key = SIZES[sizeKey] ? sizeKey : DEFAULT_SIZE;
  const templates = await findTemplates(deps.fs, deps.platform);
  if (!templates.length) {
    throw new Error("Aucun préréglage Media Encoder trouvé sur cet ordinateur (Media Encoder est-il installé ?). Tu peux aussi choisir un préréglage manuel.");
  }
  const sep = deps.platform === "darwin" ? "/" : "\\";
  const ext = (t) => (/_4D6F6F56/i.test(t.path) ? ".mov" : ".mp4");
  const tried = [];
  let produced = false; // Media Encoder a-t-il produit au moins un fichier test ?

  for (const template of templates.slice(0, 3)) {
    let xml;
    try {
      xml = decodePreset(await deps.fs.readFile(template.path));
    } catch (e) {
      tried.push(`${template.name} : illisible`);
      continue;
    }
    let variants;
    try {
      variants = presetVariants(xml, size, `Rotate - Proxy vertical ${size.width}x${size.height}`);
    } catch (e) {
      tried.push(`${template.name} : ${e.message}`);
      continue;
    }
    log(`Préparation du préréglage à partir de « ${template.name} »…`, "info");

    for (let i = 0; i < variants.length && i < 8; i++) {
      const presetPath = `${deps.dataFolder}${sep}Rotate-Proxy-${key}.epr`;
      const testPath = `${deps.dataFolder}${sep}Rotate-test-${key}-${i + 1}${ext(template)}`;
      await deps.fs.writeFile(presetPath, variants[i].text, { encoding: "utf-8" });
      try {
        await deps.fs.unlink(testPath);
      } catch (e) {
        // pas de test précédent
      }
      const queued = await deps.encodeTest(deps.calibrationFile, testPath, presetPath);
      if (!queued || !(await deps.waitForFile(testPath, 180000))) {
        // Rien du tout dès le premier essai : c'est Media Encoder qui ne répond pas, pas le préréglage.
        if (!produced) {
          throw new Error("Media Encoder n'a produit aucun fichier test en 3 minutes. Vérifie qu'il est installé et qu'il s'ouvre, puis réessaie (ou choisis un préréglage manuel).");
        }
        tried.push(`${template.name} (essai ${i + 1}) : pas de fichier produit`);
        continue;
      }
      produced = true;
      let info;
      try {
        info = await deps.withFile(testPath, "r", (io) => deps.rotation.readVideoInfo(io));
      } catch (e) {
        tried.push(`${template.name} (essai ${i + 1}) : fichier test illisible`);
        continue;
      } finally {
        try {
          await deps.fs.unlink(testPath);
        } catch (e) {
          // fichier test laissé dans le dossier du plugin, sans conséquence
        }
      }
      const sizeOk = info.displayWidth === size.width && info.displayHeight === size.height;
      const fpsOk = !!info.fps && Math.abs(info.fps - 25) < 0.01; // la vidéo test est à 25 i/s
      if (sizeOk && fpsOk) {
        log(`Préréglage vertical prêt : ${size.width}×${size.height}, cadence identique à la source.`, "ok");
        return { path: presetPath, template: template.name, size: key };
      }
      tried.push(`${template.name} (essai ${i + 1}) : ${info.displayWidth}×${info.displayHeight} à ${info.fps ? info.fps.toFixed(2) : "?"} i/s`);
      // Bonne taille mais mauvaise cadence : on n'essaie plus que la case de la cadence.
      const current = variants[i];
      if (sizeOk && !fpsOk && current.fpsFlag === null) {
        const fpsVariants = presetVariants(xml, size, `Rotate - Proxy vertical ${size.width}x${size.height}`, [false, true]);
        variants = variants.slice(0, i + 1).concat(fpsVariants.filter((v) => v.sizeFlag === current.sizeFlag));
      }
    }
  }
  throw new Error(`Impossible de créer automatiquement le préréglage (${tried.join(" ; ")}). Choisis-en un manuellement.`);
}

module.exports = {
  SIZES,
  DEFAULT_SIZE,
  scorePreset,
  findTemplates,
  decodePreset,
  makeVerticalPreset,
  presetVariants,
  createVerticalPreset,
};
