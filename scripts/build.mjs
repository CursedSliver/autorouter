import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import * as sass from "sass";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(rootDir, "src");
const publicDir = path.join(rootDir, "public");
const outDir = path.join(rootDir, "dist");

const flags = new Set(process.argv.slice(2));
const serving = flags.has("--serve");
const watching = flags.has("--watch") || serving;
const production = flags.has("--prod") || process.env.NODE_ENV === "production";
const host = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 3000);

/**
 * Compiles .scss / .sass with dart-sass, then hands the CSS to esbuild so that
 * url() assets, bundling and minification keep working as usual.
 */
function sassPlugin() {
  return {
    name: "sass",
    setup(build) {
      build.onLoad({ filter: /\.s[ac]ss$/ }, (args) => {
        const result = sass.compile(args.path, {
          loadPaths: [srcDir, path.join(rootDir, "node_modules")],
          style: production ? "compressed" : "expanded",
        });

        return {
          contents: result.css,
          loader: "css",
          resolveDir: path.dirname(args.path),
          watchFiles: result.loadedUrls
            .filter((url) => url.protocol === "file:")
            .map((url) => fileURLToPath(url)),
        };
      });
    },
  };
}

/** Keeps dist/ self-contained by mirroring public/ into it after every build. */
function staticFilesPlugin() {
  return {
    name: "static-files",
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length > 0) return;
        await mkdir(outDir, { recursive: true });
        await cp(publicDir, outDir, { recursive: true, force: true });
      });
    },
  };
}

const buildOptions = {
  entryPoints: {
    app: path.join(srcDir, "index.ts"),
    // The search worker is loaded by URL from app.js, so it has to be an entry
    // of its own: the planner refers to the emitted "route-worker.js".
    "route-worker": path.join(srcDir, "components", "route-worker.ts"),
    styles: path.join(srcDir, "styles", "main.scss"),
  },
  outdir: outDir,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: ["es2022", "chrome110", "firefox110", "safari16"],
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "assets/[name]-[hash]",
  loader: {
    ".svg": "file",
    ".png": "file",
    ".jpg": "file",
    ".jpeg": "file",
    ".gif": "file",
    ".webp": "file",
    ".avif": "file",
    ".ico": "file",
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".otf": "file",
  },
  sourcemap: production ? false : "inline",
  sourcesContent: true,
  minify: production,
  legalComments: "none",
  drop: production ? ["debugger"] : [],
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
  plugins: [sassPlugin(), staticFilesPlugin()],
};

const label = production ? "production" : "development";

if (watching) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log(`esbuild: watching (${label}) -> dist/`);

  if (serving) {
    await context.serve({ servedir: outDir, host, port });
    console.log(`esbuild: serving dist/ at http://${host}:${port}`);
  }
} else {
  await esbuild.build(buildOptions);
  console.log(`esbuild: built (${label}) -> dist/`);
}
