import { useEffect, useState } from "react";
import { Download, ExternalLink, ShieldCheck, ShieldAlert } from "lucide-react";
import { t, type FactoryLocale } from "../i18n";

const repository = "https://github.com/KeyserDSoze/SoftwareFactory";
const name = "softwarefactory-runner-installer.tar.gz";
type Asset = { name: string; browser_download_url: string; size: number };
type Release = { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: Asset[] };
export function installerReleaseAssetLink(release: Release, assetName: string): string | null {
  if (!release || typeof release !== "object" ||
      !/^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(release.tag_name) ||
      typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean" ||
      release.draft || release.prerelease !== release.tag_name.includes("-rc.") ||
      // rc.1 predates the verified-source manifest. Never recommend the
      // insecure direct host-setup start path from that archived release.
      release.tag_name === "v0.2.0-rc.1" ||
      ![name, name + ".sha256"].includes(assetName) ||
      !Array.isArray(release.assets) || release.assets.length > 50) return null;
  const assets = release.assets.filter(item => item && item.name === assetName);
  if (assets.length !== 1 || !Number.isSafeInteger(assets[0].size) ||
      assets[0].size <= 0 || assets[0].size > 100_000_000) return null;
  const expected = repository + "/releases/download/" + release.tag_name + "/" + assetName;
  return assets[0].browser_download_url === expected ? expected : null;
}
/** Prefer stable Releases; show only a marked experimental RC when there is
 * no valid stable installer. Never construct URLs from untrusted API fields.
 */
export function selectInstallerRelease(value: unknown): Release | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const eligible = value.filter((r: unknown): r is Release => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return false;
    const release = r as Release;
    return Boolean(installerReleaseAssetLink(release, name) &&
      installerReleaseAssetLink(release, name + ".sha256") &&
      release.html_url === repository + "/releases/tag/" + release.tag_name);
  });
  return eligible.find(r => !r.prerelease) ?? eligible.find(r => r.prerelease) ?? null;
}
export default function InstallerReleasePanel({ locale }: { locale: FactoryLocale }) {
  const [release, setRelease] = useState<Release | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("https://api.github.com/repos/KeyserDSoze/SoftwareFactory/releases?per_page=20", {
          method: "GET", mode: "cors", redirect: "error", cache: "no-store",
          credentials: "omit", referrerPolicy: "no-referrer",
          headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
        });
        if (!response.ok) throw Error("release list not available");
        const raw = await response.text();
        if (raw.length > 1_500_000) throw Error("release list too large");
        const r = selectInstallerRelease(JSON.parse(raw) as unknown);
        if (!r) throw Error("no verified installer release");
        if (!controller.signal.aborted) { setRelease(r); setState("ready"); }
      } catch {
        if (!controller.signal.aborted) setState("missing");
      }
    })();
    return () => controller.abort();
  }, []);
  const items = ["guideOne", "guideTwo", "guideThree", "guideFour",
    "guideFive", "guideSix", "guideSeven"] as const;
  return <section className="installer-release-panel" aria-label={t(locale, "installerTitle")}>
    <strong><Download size={16}/> {t(locale, "installerTitle")}</strong>
    {state === "loading" && <p className="helper">{t(locale, "releaseLookup")}</p>}
    {state === "missing" && <p className="helper"><ShieldAlert size={15}/>
      {t(locale, "releaseMissing")}{" "}
      <a href={repository + "/releases"} target="_blank" rel="noopener noreferrer">
        {t(locale, "releaseNotes")}</a>.</p>}
    {state === "ready" && release && <div className="installer-release-assets" role="status">
      <span><ShieldCheck size={16}/> {t(locale, "releaseAvailable")}: <code>{release.tag_name}</code></span>
      {release.prerelease && <p role="alert" className="code-agent-warning">
        <ShieldAlert size={15}/> {t(locale, "releaseExperimental")}
      </p>}
      <a href={installerReleaseAssetLink(release, name)!} target="_blank" rel="noopener noreferrer">
        <Download size={15}/> {t(locale, "releaseDownload")}</a>
      <a href={installerReleaseAssetLink(release, name + ".sha256")!} target="_blank" rel="noopener noreferrer">
        <ShieldCheck size={15}/> {t(locale, "releaseChecksum")}</a>
    </div>}
    <details className="installer-guide" open>
      <summary>{t(locale, "installGuide")}</summary>
      <ol>{items.map(key => <li key={key}>{t(locale, key)}</li>)}</ol>
      <p className="code-agent-warning">{t(locale, "guideWarning")}</p>
      <div className="button-group">
        <a href={repository + "/blob/main/INSTALLER." + locale + ".md"}
          target="_blank" rel="noopener noreferrer">{t(locale, "installGuideLink")} <ExternalLink size={14}/></a>
        <a href={repository + "/releases"} target="_blank" rel="noopener noreferrer">
          {t(locale, "releaseNotes")} <ExternalLink size={14}/></a>
      </div>
    </details>
  </section>;
}
