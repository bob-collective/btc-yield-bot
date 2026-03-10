import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("config", () => {
  describe("ConfigSchema", () => {
    it("validates minimal config", async () => {
      const { ConfigSchema } = await import("../config");
      expect(ConfigSchema.safeParse({ btcCashOutAddress: "bc1q" }).success).toBe(true);
    });
    it("rejects invalid values", async () => {
      const { ConfigSchema } = await import("../config");
      expect(ConfigSchema.safeParse({ btcCashOutAddress: "" }).success).toBe(false);
      expect(ConfigSchema.safeParse({ btcCashOutAddress: "bc1q", usdcSplitPercent: 150 }).success).toBe(false);
    });
  });

  describe("getEnv", () => {
    beforeEach(() => { vi.resetModules(); });
    it("throws when ANTHROPIC_API_KEY is missing", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const { getEnv } = await import("../config");
      expect(() => getEnv()).toThrow();
      vi.unstubAllEnvs();
    });
    it("caches result", async () => {
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
      const { getEnv } = await import("../config");
      expect(getEnv()).toBe(getEnv());
      vi.unstubAllEnvs();
    });
  });

  describe("readJsonFile / writeJsonFile", () => {
    const tmpDir = path.join(os.tmpdir(), "btc-yield-agent-test-" + Date.now());
    const tmpFile = path.join(tmpDir, "test.json");

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true });
      }
    });

    it("returns undefined for missing file", async () => {
      const { readJsonFile } = await import("../config");
      expect(readJsonFile("/tmp/nonexistent-config-test.json")).toBeUndefined();
    });
    it("roundtrips JSON data", async () => {
      const { readJsonFile, writeJsonFile } = await import("../config");
      writeJsonFile(tmpFile, { foo: "bar" });
      expect(readJsonFile(tmpFile)).toEqual({ foo: "bar" });
    });
    it("creates parent directories", async () => {
      const { writeJsonFile } = await import("../config");
      const nested = path.join(tmpDir, "a", "b", "file.json");
      writeJsonFile(nested, { key: "value" });
      expect(fs.existsSync(nested)).toBe(true);
    });
  });
});
