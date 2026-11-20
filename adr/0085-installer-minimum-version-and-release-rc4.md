# ADR 0085 — Installer UI version floor and CI-gated v0.2.0-rc.4 release

**Date:** 2026-11-20  
**Issue:** #131 (subtask of #90 and #87)  
**Status:** accepted for CI-gated experimental prerelease; no physical-VM acceptance.

## Context

GitHub Pages displays an installer download via the public Releases API. The existing selector checked exact asset names and GitHub download URLs but accepted the first eligible item in the returned array. It blocked only the known unsafe `v0.2.0-rc.1`, rather than enforcing a general version floor at `rc.2` (where mandatory source manifest verification and canary-first rootless installation entered the release contract). The existing `v0.2.0-rc.3` was published on November 18 while further source/runner security improvements landed on `main`.

## Decision

- Parse bounded strict numeric SemVer `vMAJOR.MINOR.PATCH` or `-rc.N`; reject leading-zero numeric fields, nonstandard suffixes, excessively long fields and tags older than `v0.2.0-rc.2`. Exact canonical GitHub Release and asset URL and positive size constraints are still mandatory.
- Among eligible Releases, reject duplicate tags as an ambiguous response. Preserve the preference for stable builds, choosing the numerically highest stable if any, else choose the numerically highest RC, independent of the provider's list ordering. Do not let any remote API value construct a download URL outside of the fixed repository.
- Bump the already CI-gated `.github/installer-release.version` marker from rc.3 to rc.4. Do not modify the release publishing workflow: only a successful Factory CI of this repository's `main` SHA may trigger prerelease creation, with a uniquely named tag, source manifest, archive SHA256, and no tag repointing or replacement of rc.1/2/3.

## Validation and limitations

Vitest exercises malformed/legacy tags, ordering, stable preference, spoofed and duplicated releases. Verify the exact commit, Factory CI, Pages, Installer workflow and **actual public GitHub Release with two nonempty assets** before closing #131. Checksums published with the archive check integrity but not the GitHub account's independent authenticity. The installer itself is still experimental: publishing does not prove compatibility with any particular Ubuntu/Debian machine, Docker rootless, reboot, Tunnel route, external Cloudflare Access or browser CORS. Keep #90/#87/#2 open until acceptance on a real VM.
