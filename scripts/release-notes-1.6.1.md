# StreamFusion 1.6.1

## What's new for you

🔧 **Hotfix: auto-updater broken on the 1.5.5 → 1.6.0 path.** If you tried to auto-update to 1.6.0 and saw "new version detected" but the install never landed — this fixes it. 1.6.1 publishes a correctly-named installer; your auto-updater will pick this up on the next check and complete the update.

You don't need to do anything: launch SF, wait a minute or two for the auto-update check to fire, the download + install will complete normally.

(If you want to skip the wait, you can also manually download from the release page — the manual install also works on the 1.6.0 release; only the auto-update path was broken.)

---

## Technical details

### Root cause

`package.json`'s `build` config had an explicit `nsis.artifactName` for the **portable** target but not for the **NSIS installer** target:

```json
"nsis": {
  "oneClick": false,
  ...                    // no artifactName field
},
"portable": {
  "artifactName": "StreamFusion-Portable-${version}.exe"   // explicit
}
```

electron-builder fell back to its default for NSIS — `${productName} Setup ${version}.${ext}` — which produces `StreamFusion Setup 1.6.0.exe` (with **spaces**). But electron-updater's `latest.yml` generator slugged the filename to `StreamFusion-Setup-1.6.0.exe` (with **hyphens**). The auto-updater would fetch `latest.yml`, read the hyphenated filename, hit GitHub for a download, and 404 because the actual asset is named with spaces.

The 1.5.4 build had a manual override that produced hyphens — that override got dropped at some point in the 1.5.x line, so 1.5.5 stable also had the same mismatch but nobody noticed because nobody auto-updated to 1.5.5 (we promoted from 1.5.4 directly to 1.6.0 in the merge session).

### Fix

Added explicit `nsis.artifactName: "StreamFusion-Setup-${version}.${ext}"` to `package.json`. Now the NSIS .exe and the `latest.yml` URL match. Pinned to a hyphenated form so the URL doesn't have to deal with `%20` percent-encoding either.

### What's NOT affected

- **Manual download** of 1.6.0 Setup or Portable from the release page — the actual files are correct, just the filename inside `latest.yml` was wrong.
- **Beta channel** (`aquiloplays/StreamFusion-beta`) — `electron-builder-beta.json` already had explicit `nsis.artifactName: "StreamFusion-Beta-Setup-${version}.${ext}"`, so beta users never hit this. 1.5.5-beta.0 → 1.6.0-beta.1 auto-update works as expected.

### Auth regression

16/16 PASS.
