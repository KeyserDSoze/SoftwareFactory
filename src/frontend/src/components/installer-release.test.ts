import { describe, expect, it } from "vitest";
import { installerReleaseAssetLink } from "./InstallerReleasePanel";

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
});
