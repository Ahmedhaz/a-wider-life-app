# Turath2026 · native shells

`turath/` turns the site [ahmedhaz.github.io/turath-2026](https://ahmedhaz.github.io/turath-2026/)
([source](https://github.com/Ahmedhaz/turath-2026)) into an iOS and Android app with Capacitor.
The site itself is never edited: `npm run build` pulls it and bundles it into `www/`, so the app reads
**offline**: all 387 pages, the search index and the site's fonts ship inside it.
Bundle id `com.turath2026.app`, team `M3RPNM736H`, iOS 15.5+, iPhone only, portrait only. Android 6+.

## What the build changes, and why

`scripts/build-www.mjs` copies the site and fixes three things at build time:

| Site | App | Why |
| --- | --- | --- |
| Folder links (`./library/`, `../../`) | `./library/index.html` | Capacitor serves any extensionless path as the root page (SPA routing), so a folder link would open the home page. `app/shim.js` does the same at click time for links the site's JS builds (search results, home picks, framework lists). |
| Google Fonts | `www/fonts/` from `@fontsource` | The same four families and weights (Amiri, Noto Naskh Arabic, IBM Plex Sans Arabic, Newsreader), so it reads offline with the site's own typography. |
| 21 PDFs (~20 MB) | Links to the live site | Keeps the app small; the OS opens them in the browser or its PDF viewer. |

`npm run check` refuses a `www/` where any local link on any page fails to resolve to a file, where any page
still loads Google Fonts, or where the shim is missing. The shim also keeps the status bar in step with the site's
light/dark theme.

## Every build

```
cd turath && npm install
npm run sync          # pulls the site (into .site/, ignored), builds www/, checks it, cap sync
```
Set `TURATH_SRC=/path/to/turath-2026` to build from a local checkout instead of the latest `main`.

**Android.** Every push touching `turath/` runs `.github/workflows/turath-android.yml`, which builds a debug APK and
uploads it as the `turath2026-debug-apk` artifact. You can also run it by hand from the Actions tab. Locally:
`npx cap open android`, or `cd android && ./gradlew assembleDebug`. A Play Store release still needs an upload
keystore (`./gradlew bundleRelease` with signing configured). No keystore is in this repo.

**iOS.** Same Mac steps and scars as `../mobile/README.md`. In short:
```
brew install cocoapods
cd turath && npm install && LANG=en_US.UTF-8 npm run sync
open ios/App/App.xcworkspace          # then archive and upload as in ../mobile/README.md
```
`AppDelegate.swift` and `Info.plist` carry the same UIScene fix as the A Wider Life shell (iOS 27 traps at launch
without it). Create the app record for `com.turath2026.app` in App Store Connect before the first upload.

## Icons and splash

`assets/` holds the sources, drawn from the site's `assets/mark.svg`. After changing them:
```
npx capacitor-assets generate --ios --android --iconBackgroundColor '#1F5E57' \
  --splashBackgroundColor '#F5EFE3' --splashBackgroundColorDark '#15130F'
```

## What is NOT built
- No notifications, accounts or anything the site does not do. The app is the site, offline.
- New site content reaches users only with a new app build. Rebuild after publishing.
