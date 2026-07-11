import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist-pages");
const apiBaseUrl = String(process.env.PORTFOLIO_API_BASE_URL || "").replace(/\/$/, "");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const filename of ["index.html", "styles.css", "app.js"]) {
  await cp(path.join(root, filename), path.join(output, filename));
}
await cp(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });

const config = `window.PORTFOLIO_CONFIG = ${JSON.stringify({ apiBaseUrl }, null, 2)};\n`;
await writeFile(path.join(output, "config.js"), config, "utf8");
await writeFile(path.join(output, ".nojekyll"), "", "utf8");

const html = await readFile(path.join(output, "index.html"), "utf8");
if (!html.includes('src="config.js"')) throw new Error("config.js doit être chargé par index.html");

console.log(`GitHub Pages construit dans ${output}${apiBaseUrl ? ` avec API ${apiBaseUrl}` : " sans API publique"}`);
