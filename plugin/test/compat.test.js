"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { checkCompatibility } = require("../src/compat.js");

test("Compatibilité : tout présent / fonctions manquantes signalées", () => {
  const full = {
    Project: { getActiveProject() {} }, ProjectUtils: { getSelection() {} },
    ProjectItem: { TYPE_CLIP: 1, TYPE_BIN: 2 }, ClipProjectItem: { cast() {} }, FolderItem: { cast() {} },
    EncoderManager: { getManager() {} }, TickTime: { createWithSeconds() {} }, EventManager: { addEventListener() {} },
  };
  assert.deepStrictEqual(checkCompatibility(full), { missingRequired: [], missingOptional: [] });
  const partial = { ...full, ProjectUtils: {}, TickTime: undefined };
  assert.deepStrictEqual(checkCompatibility(partial), {
    missingRequired: ["ProjectUtils.getSelection"],
    missingOptional: ["TickTime.createWithSeconds"],
  });
});
