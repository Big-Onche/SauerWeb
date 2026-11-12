import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "vite";

export const DEFAULT_SAUERBRATEN_DIR = ".Sauerbraten";
const requiredSauerbratenDirectories = ["data", "packages/base", "packages/models"];

export function resolveSauerbratenDirectory(projectRoot: string, configuredDirectory?: string): string {
  return path.resolve(projectRoot, configuredDirectory?.trim() || DEFAULT_SAUERBRATEN_DIR);
}

export function loadSauerbratenDirectory(mode: string, projectRoot = process.cwd()): string {
  const env = loadEnv(mode, projectRoot, "SAUERBRATEN_");
  return resolveSauerbratenDirectory(projectRoot, env.SAUERBRATEN_DIR);
}

export function validateSauerbratenDirectory(directory: string): void {
  const missing = requiredSauerbratenDirectories.filter((relativeDirectory) => {
    try {
      return !fs.statSync(path.join(directory, relativeDirectory)).isDirectory();
    } catch {
      return true;
    }
  });
  if (!missing.length) return;

  const diagnostic = [
    `Invalid SAUERBRATEN_DIR: ${directory}`,
    "The configured Sauerbraten source/assets root is missing required directories:",
    ...missing.map((relativeDirectory) => `  - ${relativeDirectory}`),
    "Set SAUERBRATEN_DIR to an absolute path or a path relative to the SauerWeb project root.",
  ].join("\n");
  console.error(diagnostic);
  throw new Error(diagnostic);
}
