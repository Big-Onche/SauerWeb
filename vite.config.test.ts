import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeSauerbratenGzip } from "./sauerbratenGzip";
import { DEFAULT_SAUERBRATEN_DIR, loadSauerbratenDirectory, resolveSauerbratenDirectory,
  validateSauerbratenDirectory } from "./sauerbratenDirectory";

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

  it("loads a persistent relative root from .env.local", () => {
    const projectRoot = temporaryDirectory();
    fs.writeFileSync(path.join(projectRoot, ".env.local"), 'SAUERBRATEN_DIR="../shared/sauerbraten"\n');
    const configuredDirectory = process.env.SAUERBRATEN_DIR;
    delete process.env.SAUERBRATEN_DIR;

    try {
      expect(loadSauerbratenDirectory("test", projectRoot)).toBe(path.resolve(projectRoot, "../shared/sauerbraten"));
    } finally {
      if (configuredDirectory === undefined) delete process.env.SAUERBRATEN_DIR;
      else process.env.SAUERBRATEN_DIR = configuredDirectory;
    }
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

describe("legacy Sauerbraten gzip streams", () => {
  it("normalizes castle_trap's invalid checksum without changing its OCTA payload", () => {
    const compressed = fs.readFileSync(path.join(DEFAULT_SAUERBRATEN_DIR, "packages", "base", "castle_trap.ogz"));

    expect(() => zlib.gunzipSync(compressed)).toThrow();
    const map = zlib.gunzipSync(normalizeSauerbratenGzip(compressed));
    expect(map.subarray(0, 4).toString("ascii")).toBe("OCTA");
    expect(map.readInt32LE(4)).toBe(27);
  });
});
