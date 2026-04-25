// scripts/merge-deps.mjs
import { cpSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const depsOS = platform() === "win32" ? "depsWIN" : "depsUNX";

const targets = [
  join(root, "src-tauri", "target", "release"),
  join(root, "src-tauri", "target", "debug"),
];

const outDir = targets.find(existsSync);

if (!outDir) {
  console.warn("⚠ No build folder yet, skipping deps merge");
  process.exit(0);
}

const depsOut = join(outDir, "deps");

// ✅ NO DELETION EVER
if (!existsSync(depsOut)) {
  mkdirSync(depsOut, { recursive: true });
}

function safeCopy(src, dest) {
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true });
}

// GLOBAL DEPS
const global = join(root, "src-tauri", "depsG");
if (existsSync(global)) {
  safeCopy(global, depsOut);
  console.log("✓ deps (Global) copied");
} else {
  console.warn("⚠ deps (Global) not found, skipping");
}

// OS DEPS
const osDir = join(root, "src-tauri", depsOS);
if (existsSync(osDir)) {
  safeCopy(osDir, depsOut);
  console.log(`✓ ${depsOS} copied`);
} else {
  console.warn(`⚠ ${depsOS} not found, skipping`);
}

console.log(`\n✅ deps/ ready at ${depsOut}`);