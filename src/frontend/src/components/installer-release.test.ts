import { describe, expect, it } from "vitest";
import { installerReleaseAssetLink, selectInstallerRelease } from "./InstallerReleasePanel";

const root = "https://github.com/KeyserDSoze/SoftwareFactory/releases/download/v0.2.0/";
const asset = (name: string, url = root + name) => ({ name, browser_download_url: url, size: 8192 });
const release = {
  tag_name: "v0.2.0", html_url: "https://github.com/KeyserDSoze/SoftwareFactory/releases/tag/v0.2.0",
  draft: false, prerelease: false, assets: [
    asset("softwarefactory-runner-installer.tar.gz"),
    asset("softwarefactory-runner-installer.tar.gz.sha256"),
  ],
};
describe("public Release downloads on static Pages", () => {
  it("accepts only exact GitHub asset URL matching the fixed installer name/tag", () => {
    expect(installerReleaseAssetLink(release, "softwarefactory-runner-installer.tar.gz")).toBe(
      root + "softwarefactory-runner-installer.tar.gz");
    for (const unsafe of [
      { ...release, tag_name: "v0.2.0-rc1" },
      { ...release, draft: true },
      { ...release, prerelease: true },
      { ...release, assets: [asset("softwarefactory-runner-installer.tar.gz", "https://evil.example/installer")] },
      { ...release, assets: [asset("softwarefactory-runner-installer.tar.gz", root + "other.tar.gz")] },
      { ...release, assets: [{ ...asset("softwarefactory-runner-installer.tar.gz"), size: 0 }] },
    ]) expect(installerReleaseAssetLink(unsafe, "softwarefactory-runner-installer.tar.gz")).toBeNull();
  });
  it("accepts exact CI-approved rc.N prereleases but never disguised stable tags", () => {
    const rc = { ...release, tag_name: "v0.2.0-rc.2", prerelease: true,
      html_url: "https://github.com/KeyserDSoze/SoftwareFactory/releases/tag/v0.2.0-rc.2",
      assets: [
        asset("softwarefactory-runner-installer.tar.gz",
          root.replace("v0.2.0/", "v0.2.0-rc.2/") + "softwarefactory-runner-installer.tar.gz"),
        asset("softwarefactory-runner-installer.tar.gz.sha256",
          root.replace("v0.2.0/", "v0.2.0-rc.2/") + "softwarefactory-runner-installer.tar.gz.sha256"),
      ] };
    expect(installerReleaseAssetLink(rc,"softwarefactory-runner-installer.tar.gz")).toContain("-rc.2/");
    expect(selectInstallerRelease([rc])).toEqual(rc);
    expect(selectInstallerRelease([rc,release])).toEqual(release);
    expect(selectInstallerRelease([{...rc, prerelease:false}])).toBeNull();
    const legacyRc = {...rc, tag_name: "v0.2.0-rc.1",
      html_url: "https://github.com/KeyserDSoze/SoftwareFactory/releases/tag/v0.2.0-rc.1",
      assets: rc.assets.map(a => ({
        ...a, browser_download_url: a.browser_download_url.replace("v0.2.0-rc.2/", "v0.2.0-rc.1/"),
      }))};
    expect(selectInstallerRelease([legacyRc])).toBeNull();
    expect(installerReleaseAssetLink(legacyRc, "softwarefactory-runner-installer.tar.gz")).toBeNull();
    expect(selectInstallerRelease([{...rc, draft:true}])).toBeNull();
    expect(selectInstallerRelease([{...rc, assets:[...rc.assets,rc.assets[0]]}])).toBeNull();
    expect(selectInstallerRelease({releases:[rc]})).toBeNull();
    expect(installerReleaseAssetLink(rc,"../../evil")).toBeNull();
  });
});

const exactRelease = (tag: string, prerelease = tag.includes("-rc.")) => {
  const site = "https://github.com/KeyserDSoze/SoftwareFactory/releases";
  return { ...release, tag_name: tag, prerelease, html_url: site + "/tag/" + tag,
    assets: release.assets.map(a => ({
      ...a, browser_download_url: site + "/download/" + tag + "/" + a.name,
    })),
  };
};
describe("installer verified-source release floor and deterministic selection #131", () => {
  it("refuses all historical pre-manifest or malformed versions, not just rc.1", () => {
    for (const tag of [
      "v0.1.99", "v0.2.0-rc.1", "v0.2.0-rc.0",
      "v0.2.0-rc.01", "v0.2.0-RC.2", "v0.2.0-rc.2-extra",
      "v0.2.00", "v00.2.0", "v0.02.0", "v0.2.0-rc.0002",
      "v0.2.0-rc.1000000", "v0.2.1000000", "v0.2.0+dirty",
      "v0.2.0-beta.1", "v0.2.0/", "v0.0.0",
    ]) {
      const candidate = exactRelease(tag);
      expect(installerReleaseAssetLink(candidate, "softwarefactory-runner-installer.tar.gz")).toBeNull();
      expect(selectInstallerRelease([candidate])).toBeNull();
    }
    expect(selectInstallerRelease([exactRelease("v0.2.0-rc.2")])).not.toBeNull();
    expect(selectInstallerRelease([exactRelease("v0.2.0-rc.4")])).not.toBeNull();
    expect(selectInstallerRelease([exactRelease("v0.2.0")])).not.toBeNull();
  });
  it("picks numerically newest RC independent of API order, never lexicographically", () => {
    const rc2 = exactRelease("v0.2.0-rc.2");
    const rc3 = exactRelease("v0.2.0-rc.3");
    const rc4 = exactRelease("v0.2.0-rc.4");
    const rc10 = exactRelease("v0.2.0-rc.10");
    for(const items of [
      [rc2,rc4,rc3,rc10], [rc10,rc2,rc3,rc4],
      [rc3,rc4,rc2,rc10],
    ]) {
      expect(selectInstallerRelease(items)).toEqual(rc10);
      // Do not alter the GitHub API array passed to the selector.
      expect(items[0]).toBe(items[0]);
    }
    expect(selectInstallerRelease([rc3,rc4])).toEqual(rc4);
    expect(selectInstallerRelease([rc4,rc3])).toEqual(rc4);
  });
  it("prefers newest valid stable but rejects duplicate or spoofed RC records", () => {
    const rc = exactRelease("v0.3.0-rc.5");
    const stable = exactRelease("v0.2.0", false);
    const laterStable = exactRelease("v0.2.1", false);
    expect(selectInstallerRelease([stable,rc,laterStable])).toEqual(laterStable);
    expect(selectInstallerRelease([laterStable,stable,rc])).toEqual(laterStable);
    expect(selectInstallerRelease([rc,exactRelease("v0.2.0-rc.4")])).toEqual(rc);
    expect(selectInstallerRelease([rc,rc])).toBeNull();
    expect(selectInstallerRelease([
      rc, exactRelease("v0.3.0-rc.5"),
    ])).toBeNull();
    expect(selectInstallerRelease([{...rc, prerelease:false}])).toBeNull();
    expect(selectInstallerRelease([{...rc, draft:true}])).toBeNull();
    expect(selectInstallerRelease([{...rc, assets: [
      {...rc.assets[0], browser_download_url:"https://untrusted.example/download"},
      rc.assets[1],
    ]}])).toBeNull();
  });
});
