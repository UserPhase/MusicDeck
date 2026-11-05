const test = require("node:test");
const assert = require("node:assert/strict");
const { validateDesktopProject } = require("../scripts/validate-desktop-config.cjs");

test("MusicDeck Tauri desktop configuration and assets are valid", () => {
  const result = validateDesktopProject();
  assert.equal(result.productName, "MusicDeck");
  assert.equal(result.identifier, "app.musicdeck.desktop");
  assert.equal(result.frontendDist, "../../webapp/build");
  assert.ok(result.icons >= 5);
});
