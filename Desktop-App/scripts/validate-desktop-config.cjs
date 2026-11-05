const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const webappRoot = path.resolve(desktopRoot, "..", "webapp");

function validateDesktopProject() {
  const pkgPath = path.join(desktopRoot, "package.json");
  assert.ok(fs.existsSync(pkgPath), "Desktop-App/package.json must exist");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.name, "musicdeck-desktop");

  const tauriConfPath = path.join(tauriRoot, "tauri.conf.json");
  assert.ok(fs.existsSync(tauriConfPath), "src-tauri/tauri.conf.json must exist");
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));

  assert.equal(tauriConf.productName, "MusicDeck");
  assert.equal(tauriConf.identifier, "app.musicdeck.desktop");
  assert.equal(tauriConf.build.devUrl, "http://localhost:3000");
  assert.equal(tauriConf.build.frontendDist, "../../webapp/build");
  assert.equal(tauriConf.app.withGlobalTauri, true);
  assert.equal(tauriConf.app.windows[0].decorations, false, "Main window must use decorations: false for seamless titlebar");

  const resolvedWebappDir = path.resolve(tauriRoot, tauriConf.build.frontendDist, "..");
  assert.equal(
    resolvedWebappDir,
    webappRoot,
    "frontendDist in tauri.conf.json must resolve to ../webapp/build"
  );

  const capabilityPath = path.join(tauriRoot, "capabilities", "default.json");
  assert.ok(fs.existsSync(capabilityPath), "src-tauri/capabilities/default.json must exist");
  const capability = JSON.parse(fs.readFileSync(capabilityPath, "utf8"));
  assert.ok(Array.isArray(capability.windows) && capability.windows.includes("main"));
  assert.ok(Array.isArray(capability.permissions) && capability.permissions.includes("core:default"));
  assert.ok(capability.permissions.includes("core:tray:default"));
  assert.ok(capability.permissions.includes("core:window:allow-start-dragging"));

  for (const iconRel of tauriConf.bundle.icon) {
    const iconPath = path.join(tauriRoot, iconRel);
    assert.ok(fs.existsSync(iconPath), `Missing bundle icon: ${iconRel}`);
    const stat = fs.statSync(iconPath);
    assert.ok(stat.size > 0, `Bundle icon is empty: ${iconRel}`);
    if (iconRel.endsWith(".png")) {
      const buf = fs.readFileSync(iconPath);
      assert.equal(buf[25], 6, `PNG icon ${iconRel} must use RGBA (colorType 6)`);
    }
  }

  const cargoTomlPath = path.join(tauriRoot, "Cargo.toml");
  assert.ok(fs.existsSync(cargoTomlPath), "src-tauri/Cargo.toml must exist");
  const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
  assert.match(cargoToml, /name\s*=\s*"musicdeck-desktop"/);
  assert.match(cargoToml, /name\s*=\s*"musicdeck_desktop_lib"/);
  assert.match(cargoToml, /sha2\s*=/);

  const updaterRsPath = path.join(tauriRoot, "src", "updater.rs");
  assert.ok(fs.existsSync(updaterRsPath), "src-tauri/src/updater.rs must exist");

  const proxyRsPath = path.join(tauriRoot, "src", "proxy.rs");
  assert.ok(fs.existsSync(proxyRsPath), "src-tauri/src/proxy.rs must exist");

  const libRs = fs.readFileSync(path.join(tauriRoot, "src", "lib.rs"), "utf8");
  for (const cmd of [
    "desktop_get_config",
    "desktop_set_config",
    "desktop_check_server",
    "desktop_api_fetch",
    "desktop_update_playback",
    "desktop_window_action",
    "desktop_check_for_updates",
    "desktop_install_update",
  ]) {
    assert.ok(libRs.includes(cmd), `src/lib.rs must register command ${cmd}`);
  }

  const workflowPath = path.resolve(desktopRoot, "..", ".github", "workflows", "desktop-app.yml");
  assert.ok(fs.existsSync(workflowPath), ".github/workflows/desktop-app.yml must exist");
  const workflowContent = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflowContent, /runs-on:\s*windows-latest/);
  assert.match(workflowContent, /npx tauri build/);
  assert.match(workflowContent, /latest\.json/);

  return {
    productName: tauriConf.productName,
    identifier: tauriConf.identifier,
    frontendDist: tauriConf.build.frontendDist,
    icons: tauriConf.bundle.icon.length,
    workflow: ".github/workflows/desktop-app.yml",
  };
}

if (require.main === module) {
  const summary = validateDesktopProject();
  console.log("Desktop-App configuration validated:", JSON.stringify(summary));
}

module.exports = { validateDesktopProject };
