const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Extend the pinned CRA production config while retaining its build, asset
// manifest, type checking, and Workbox pipeline.
process.env.BABEL_ENV = "production";
process.env.NODE_ENV = "production";
process.env.INLINE_RUNTIME_CHUNK = "false";

const configPath = require.resolve("react-scripts/config/webpack.config");
const createConfig = require(configPath);
const publicDir = path.join(__dirname, "..", "public");

require.cache[configPath].exports = (environment) => {
  const config = createConfig(environment);
  config.optimization.runtimeChunk = "single";
  config.optimization.splitChunks = {
    chunks: "all",
    cacheGroups: {
      reactCore: {
        test: /[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/,
        name: "react-core",
        priority: 30,
        enforce: true,
      },
      audioRuntime: {
        test: /[\\/]src[\\/]services[\\/]audio[\\/]/,
        name: "audio-runtime",
        chunks: "initial",
        priority: 20,
        enforce: true,
      },
    },
  };

  const terser = config.optimization.minimizer.find((plugin) => plugin.constructor.name === "TerserPlugin");
  Object.assign(terser.options.minimizer.options.compress, {
    drop_console: ["debug", "info", "log", "trace", "warn", "group", "groupCollapsed", "groupEnd", "table", "time", "timeEnd"],
    drop_debugger: true,
  });

  const workbox = config.plugins.find((plugin) => plugin.constructor.name === "InjectManifest");
  workbox.config.dontCacheBustURLsMatching = /\.[0-9a-f]{8,}\./;
  const publicPath = config.output.publicPath === "auto" ? "" : config.output.publicPath;
  const shellAssets = ["manifest.json", "favicon.ico", "musicdeck-icon.svg", "musicdeck-192.png", "musicdeck-512.png"];
  workbox.config.additionalManifestEntries = shellAssets.map((file) => ({
    url: `${publicPath}${file}`,
    revision: createHash("sha256").update(fs.readFileSync(path.join(publicDir, file))).digest("hex"),
  }));
  workbox.config.manifestTransforms = [(manifest, compilation) => {
    const entrypointFiles = compilation.entrypoints.get("main").getFiles();
    const shellUrls = new Set(["index.html", ...entrypointFiles].map((file) => `${publicPath}${file}`));
    return {
      manifest: manifest.map((entry) => shellUrls.has(entry.url) || /\.(?:woff2?|ttf|otf|eot)$/.test(entry.url)
        ? entry
        : { ...entry, precache: false }),
      warnings: [],
    };
  }];
  return config;
};

require("react-scripts/scripts/build");
