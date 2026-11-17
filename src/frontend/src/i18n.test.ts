import { describe, expect, it } from "vitest";
import { messages, normalizeLocale, t } from "./i18n";
describe("installer and GitHub Actions i18n", () => {
  it("keeps all English and Italian keys aligned and nonempty", () => {
    expect(Object.keys(messages.it).sort()).toEqual(Object.keys(messages.en).sort());
    for (const locale of ["it","en"] as const)
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value.length, locale + "/" + key).toBeGreaterThan(3);
        expect(value).not.toContain("github_pat_");
      }
  });
  it("normalizes a language preference safely and translates operational steps", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("not-a-locale")).toBe("it");
    expect(t("en", "releaseDownload")).toContain("Download");
    expect(t("it", "releaseChecksum")).toContain("SHA-256");
    expect(t("en", "guideSix")).toContain("runner-api:8787");
    expect(t("it", "guideSix")).toContain("runner-api:8787");
  });
});
