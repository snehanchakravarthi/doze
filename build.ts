import { cp, readFile, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/background.ts", "src/popup.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Content scripts can't be ES modules, so the in-page probe is bundled as a plain script.
const probe = await Bun.build({
  entrypoints: ["src/probe.ts"],
  outdir: "dist",
  target: "browser",
  format: "iife",
});

if (!probe.success) {
  for (const log of probe.logs) console.error(log);
  process.exit(1);
}

await cp("static", "dist", { recursive: true });

// The side panel is the same page with room to breathe.
const popup = await readFile("dist/popup.html", "utf8");
await writeFile("dist/panel.html", popup.replace("<body>", '<body class="panel">'));
console.log("Built to dist/. Load it from chrome://extensions → Load unpacked.");
