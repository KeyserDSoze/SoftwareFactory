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
      html_url: "https://github.com/KeyserDSoze/SoftwareFactory/releases/tag/v0.2.0-rc.1",
      assets: [
        asset("softwarefactory-runner-installer.tar.gz",
          root.replace("v0.2.0/", "v0.2.0-rc.2/") + "softwarefactory-runner-installer.tar.gz"),
        asset("softwarefactory-runner-installer.tar.gz.sha256",
          root.replace("v0.2.0/", "v0.2.0-rc.2/") + "softwarefactory-runner-installer.tar.gz.sha256"),
      ] };
    expect(installerReleaseAssetLink(rc,"softwarefactory-runner-installer.tar.gz")).toContain("-rc.1/");
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
