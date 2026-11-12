import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAUERBRATEN_DIR, resolveSauerbratenDirectory, validateSauerbratenDirectory } from "./vite.config";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sauerweb-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function createSauerbratenTree(directory: string): void {
  for (const relativeDirectory of ["data", "packages/base", "packages/models"]) {
    fs.mkdirSync(path.join(directory, relativeDirectory), { recursive: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("SAUERBRATEN_DIR", () => {
  it("defaults to .Sauerbraten below the project root", () => {
    const projectRoot = temporaryDirectory();

    expect(resolveSauerbratenDirectory(projectRoot)).toBe(path.resolve(projectRoot, DEFAULT_SAUERBRATEN_DIR));
  });

  it("preserves an absolute configured root", () => {
    const projectRoot = temporaryDirectory();
    const assetRoot = path.join(temporaryDirectory(), "assets");

    expect(resolveSauerbratenDirectory(projectRoot, assetRoot)).toBe(path.resolve(assetRoot));
  });

  it("resolves a relative configured root from the project root", () => {
    const projectRoot = temporaryDirectory();

    expect(resolveSauerbratenDirectory(projectRoot, "../shared/sauerbraten")).toBe(path.resolve(projectRoot, "../shared/sauerbraten"));
  });

  it("reports every missing required directory", () => {
    const assetRoot = temporaryDirectory();
    fs.mkdirSync(path.join(assetRoot, "data"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => validateSauerbratenDirectory(assetRoot)).toThrow(/packages\/base[\s\S]*packages\/models/);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`Invalid SAUERBRATEN_DIR: ${assetRoot}`));
  });

  it("accepts a complete Sauerbraten directory structure", () => {
    const assetRoot = temporaryDirectory();
    createSauerbratenTree(assetRoot);

    expect(() => validateSauerbratenDirectory(assetRoot)).not.toThrow();
  });
});
