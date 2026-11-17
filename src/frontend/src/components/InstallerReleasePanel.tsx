import { useEffect, useState } from "react";
import { Download, ExternalLink, ShieldCheck, ShieldAlert } from "lucide-react";
import { t, type FactoryLocale } from "../i18n";

const repository = "https://github.com/KeyserDSoze/SoftwareFactory";
const name = "softwarefactory-runner-installer.tar.gz";
type Asset = { name: string; browser_download_url: string; size: number };
type Release = { tag_name: string; html_url: string; draft: boolean; prerelease: boolean; assets: Asset[] };
export function installerReleaseAssetLink(release: Release, assetName: string): string | null {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || release.draft || release.prerelease) return null;
  const asset = release.assets?.find(item => item.name === assetName);
  if (!asset || asset.size <= 0 || asset.size > 100_000_000) return null;
  const expected = repository + "/releases/download/" + release.tag_name + "/" + assetName;
  return asset.browser_download_url === expected ? expected : null;
}
export default function InstallerReleasePanel({ locale }: { locale: FactoryLocale }) {
  const [release, setRelease] = useState<Release | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("https://api.github.com/repos/KeyserDSoze/SoftwareFactory/releases/latest", {
          method: "GET", mode: "cors", redirect: "error", cache: "no-store",
          headers: { Accept: "application/vnd.github+json" }, signal: controller.signal,
        });
        if (!response.ok) throw Error("no latest release");
        const parsed: unknown = await response.json();
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("invalid release");
        const r = parsed as Release;
        if (!installerReleaseAssetLink(r, name) || !installerReleaseAssetLink(r, name + ".sha256") ||
            r.html_url !== repository + "/releases/tag/" + r.tag_name)
          throw Error("release has no verified installer assets");
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
