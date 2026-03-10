import { describe, it, expect } from "vitest";
import { validateBtcAddress, maskSecret } from "../setup/prompts";

describe("validateBtcAddress", () => {
  it("accepts bc1q P2WPKH address", () => {
    expect(
      validateBtcAddress("bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh")
    ).toBe(true);
  });

  it("accepts bc1p taproot address", () => {
    expect(
      validateBtcAddress(
        "bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297"
      )
    ).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateBtcAddress("")).toBe(false);
  });

  it("rejects random string", () => {
    expect(validateBtcAddress("not-a-btc-address")).toBe(false);
  });

  it("accepts legacy address starting with 1", () => {
    expect(validateBtcAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(
      true
    );
  });
});

describe("maskSecret", () => {
  it("masks a long string showing first and last 4", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("abcd...mnop");
  });

  it("masks a short string entirely", () => {
    expect(maskSecret("abc")).toBe("***");
  });

  it("returns empty for empty", () => {
    expect(maskSecret("")).toBe("");
  });
});
