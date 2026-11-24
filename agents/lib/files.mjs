import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const agentsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const outDir = process.env.REPORT_DIR || path.join(agentsDir, "out");

export function readIfExists(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

export function write(name, text) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), text);
}

export function readOut(name) {
  return readIfExists(path.join(outDir, name));
}
