import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLogger, safeErrorMessage, notify, setTelegram } from "../notify";

describe("createLogger", () => {
  it("returns object with debug, info, warn, error methods", () => {
    const log = createLogger("test");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
  });
});

describe("safeErrorMessage", () => {
  it("extracts message from Error", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
  });
  it("converts non-Error to string", () => {
    expect(safeErrorMessage(42)).toBe("42");
    expect(safeErrorMessage(null)).toBe("null");
  });
  it("does not include stack trace", () => {
    const err = new Error("test");
    err.stack = "Error: test\n    at Object.<anonymous> (/path/to/file.ts:1:1)";
    expect(safeErrorMessage(err)).toBe("test");
    expect(safeErrorMessage(err)).not.toContain("at Object");
  });
});

describe("notify", () => {
  beforeEach(() => { setTelegram(null as any); });

  it("forwards warn/error to telegram when set", async () => {
    const mockBot = { alert: vi.fn().mockResolvedValue(undefined) };
    setTelegram(mockBot);
    notify("warn", "test warning");
    notify("error", "test error");
    notify("info", "test info");
    expect(mockBot.alert).toHaveBeenCalledTimes(2);
    expect(mockBot.alert).toHaveBeenCalledWith("test warning");
    expect(mockBot.alert).toHaveBeenCalledWith("test error");
  });

  it("does not throw when no telegram set", () => {
    expect(() => notify("error", "test")).not.toThrow();
  });
});
