import { describe, it, expect } from "vitest";
import { TelegramBot } from "../modules/telegram";

describe("TelegramBot", () => {
  it("is disabled without both token and chatId", () => {
    expect(new TelegramBot().isEnabled()).toBe(false);
    expect(new TelegramBot({ botToken: "123:ABC" }).isEnabled()).toBe(false);
  });

  it("is enabled with both token and chatId", () => {
    const bot = new TelegramBot({ botToken: "123:ABC", chatId: "999" });
    expect(bot.isEnabled()).toBe(true);
  });
});
