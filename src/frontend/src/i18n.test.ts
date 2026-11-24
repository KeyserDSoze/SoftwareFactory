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
  it("explains non-restorable oversized CAS ZIP exports in both languages",()=>{
    expect(t("it","casLibraryBackupNotRestorable")).toContain("20 MB");
    expect(t("en","casLibraryBackupNotRestorable")).toContain("20 MB");
    expect(t("it","casLibraryBackupNotRestorable")).toContain("JSON");
    expect(t("en","casLibraryBackupNotRestorable")).toContain("JSON");
  });
  it("does not label local CAS form copy as a committed write (#196)",()=>{
    expect(t("it","casIsoDraftCopyInMemory")).toContain("NON SALVATA");
    expect(t("en","casIsoDraftCopyInMemory")).toContain("UNSAVED");
    expect(t("it","casIsoDraftCopyRefused")).toContain("Nessun campo copiato");
    expect(t("en","casIsoDraftCopyExplain")).toContain("No storage write");
  });
  it("translates offline-only draft inspection without implying a CAS write (#195)",()=>{
    expect(t("it","casIsoDraftInspectWarning")).toContain("SOLO LETTURA");
    expect(t("en","casIsoDraftInspectWarning")).toContain("READ-ONLY");
    expect(t("it","casIsoDraftInspectConsent")).toContain("NON CONFERMATA");
    expect(t("en","casIsoDraftInspectReady")).toContain("not imported");
  });
  it("labels the uncommitted CAS draft recovery as offline, not an IndexedDB ACK",()=>{
    expect(t("it","casIsoDraftBackupExplain")).toContain("NON SALVATA");
    expect(t("en","casIsoDraftBackupExplain")).toContain("UNCOMMITTED");
    expect(t("it","casIsoDraftBackupOffered")).toContain("NON certifica");
    expect(t("en","casIsoDraftBackupConsent")).toContain("CANNOT");
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
