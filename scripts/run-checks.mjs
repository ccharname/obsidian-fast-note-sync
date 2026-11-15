// Build in a temporary directory so verification never replaces a developer's bundle.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import releaseGate from "./release-check.cjs";

const root = path.resolve(import.meta.dirname, "..");
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${args.join(" ")} failed (${result.signal ?? result.status})`);
}

let temporary;
try {
  releaseGate.clearEvidence(root);
  run(["--test", "scripts/release-check.test.cjs"]);
  run(["scripts/run-tests.mjs"]);
  temporary = mkdtempSync(path.join(tmpdir(), "fast-note-sync-check-"));
  for (const entry of ["package.json", "tsconfig.json", "esbuild.config.mjs", "src"]) {
    cpSync(path.join(root, entry), path.join(temporary, entry), { recursive: true });
  }
  symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "junction");
  run([path.join(root, "node_modules/typescript/bin/tsc"), "-noEmit", "-skipLibCheck"], temporary);
  run(["esbuild.config.mjs", "production"], temporary);
  const output = path.join(root, "dist/plugin");
  mkdirSync(output, { recursive: true });
  cpSync(path.join(temporary, "main.js"), path.join(output, "main.js"));
  for (const name of ["manifest.json", "styles.css"]) {
    cpSync(path.join(root, name), path.join(output, name));
  }
  if (!existsSync(path.join(root, "scripts/release-check.cjs"))) {
    throw new Error("Missing scripts/release-check.cjs; release checks must not be skipped");
  }
  run(["scripts/release-check.cjs", "--local", "--asset-dir", "dist/plugin"]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
