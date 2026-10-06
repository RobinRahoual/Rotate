"use strict";

const test = require("node:test");
const assert = require("node:assert");
const s = require("../src/shortcuts.js");

test("normalizeKey : lettres, chiffres (y compris AZERTY), modificateurs ignorés", () => {
  assert.strictEqual(s.normalizeKey({ key: "v", code: "KeyV" }), "V");
  assert.strictEqual(s.normalizeKey({ key: "&", code: "Digit1" }), "1");
  assert.strictEqual(s.normalizeKey({ key: "v", code: "KeyV", ctrlKey: true }), null);
  assert.strictEqual(s.normalizeKey({ key: "v", code: "KeyV", metaKey: true }), null);
  assert.strictEqual(s.normalizeKey({ key: "Enter", code: "Enter" }), null);
  assert.strictEqual(s.normalizeKey({ key: " ", code: "Space" }), null);
});

test("assign : une touche ne sert qu'à une action ; withDefaults ; actionFor", () => {
  let map = s.withDefaults(null);
  assert.deepStrictEqual(map, s.DEFAULTS);
  map = s.assign(map, "undo", "V");
  assert.strictEqual(map.undo, "V");
  assert.strictEqual(map.rotateDefault, "");
  assert.strictEqual(s.actionFor(map, "V"), "undo");
  assert.strictEqual(s.actionFor(map, "Q"), null);
  map = s.assign(map, "undo", "");
  assert.strictEqual(s.actionFor(map, "V"), null);
  assert.deepStrictEqual(s.withDefaults({ rotateDefault: "R", undo: "??" }), { ...s.DEFAULTS, rotateDefault: "R", undo: "" });
});
