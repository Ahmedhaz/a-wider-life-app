# A Wider Life · native shells

`mobile/` wraps `web/` with Capacitor. The content still comes from the Worker; only the shell ships through the stores.
Bundle id `com.awiderlife.app`, team `M3RPNM736H`, iOS 15.5+, iPhone only, portrait only.

What the shell adds over the web page: a saying from Ibn Arabi every three hours as a **local** notification
(`@capacitor/local-notifications`, off by default, toggled in settings), and push registration that stays dormant
until the Worker's `NOTIFY_ENABLED` is "true" (`/v1/flags`, `POST /v1/device`; no sender exists yet).

The notifications are local, not push: nothing is scheduled by a server, so they work offline and need no APNs key.
iOS caps an app at **64 pending** notifications, which is what shapes the design — 10:00 to 02:00 every three hours
is 6 a day, so the queue fills to 60 (about ten days) and is refilled on every launch and resume. The slots are
anchored to the window start, so a refill at 14:20 does not drag every later slot to :20 past. The 89 sayings live in
`web/quotes.json`, which the Worker serves and `cap sync` copies into the app, so the same file works both ways.

## One-time setup on the Mac (read the scars first)

```
brew install cocoapods                 # NOT `sudo gem install cocoapods`: it hangs on a silent Password: prompt
cd mobile && npm install
LANG=en_US.UTF-8 npx cap sync ios      # copies web/ into ios/App/App/public and runs pod install
```
**Always set `LANG`.** Without a UTF-8 locale, `pod install` dies on `Unicode Normalization not appropriate for
ASCII-8BIT` and `cap sync` hangs silently for minutes — the app name is Arabic, so CocoaPods hits non-ASCII bytes
while normalising paths. With it, sync finishes in seconds.

Open the workspace directly (not the repo folder, not `npx cap open ios` if it lands on the wrong window):
`open mobile/ios/App/App.xcworkspace`. After any `pod install`, close and reopen the workspace or Xcode keeps
the pre-Pods references and complains "No such module 'Capacitor'".

Signing is automatic and the team is already in the project. The app needs **no capabilities**: Associated Domains
and Push Notifications were both removed, and `App/App.entitlements` is deliberately an empty dict.

## Every build

```
cd mobile && LANG=en_US.UTF-8 npx cap sync ios     # after any change under web/
```
Then archive and upload. The Xcode Organizer works, but from the command line:

```
xcodebuild -workspace App.xcworkspace -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath <path> archive

launchctl asuser $(id -u) xcodebuild -exportArchive -allowProvisioningUpdates \
  -archivePath <path> -exportOptionsPlist <plist> -exportPath <out> \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 \
  -authenticationKeyID <KEYID> -authenticationKeyIssuerID <ISSUER>
```
**`launchctl asuser` is not optional.** Without it the upload fails with `Code=4097 "connection to service named
com.apple.dt.Xcode.ITunesSoftwareService"` and a misleading `No Accounts with App Store Connect Access`: the XPC
service cannot launch outside the GUI login session, so the API key is never validated. Xcode 27's bundled
`iTMSTransporter` is only a stub that points at the Mac App Store, so `xcrun altool` cannot upload at all.

App Store Connect **renumbers builds on upload** (`manageAppVersionAndBuildNumber`), so `CURRENT_PROJECT_VERSION`
can silently diverge from what lands. Check the real number through the API afterwards rather than assuming.

## Scars, still valid
- `npx` re-resolves through `npm exec` on this Mac and can stall for minutes with no output. Prefer
  `./node_modules/.bin/<tool>`; `ops/ship.sh` does this already.
- A leftover filter in the project navigator hides every file: clear the filter box at the bottom.
- "Device not registered": Signing & Capabilities → Register Device.
- Menu-bar overlays (NotchBox) block clicks on Xcode menus; use the keyboard or quit the overlay.
- Never commit `Pods/`, `node_modules/` or `ios/App/App/public/` (the copied web); `.gitignore` here covers them.
- An app built against the iOS 26+ SDK **must** adopt the UIScene lifecycle or iOS 27 traps at launch, before any
  of our code runs. Capacitor 7.6.9 ships no `UISceneDelegate`, so `AppDelegate.swift` carries its own alongside a
  `UIApplicationSceneManifest` in `Info.plist`. Revisit if Capacitor adds scene support upstream.

## What is NOT built
- No push sender. Registration only, and only when the flag is on.
- No Android project yet (`npx cap add android` when Google Play is opened).
- No offline audio.

## Removed on purpose
- **The QR scanner** and `@capacitor-mlkit/barcode-scanning`, which took twelve pods with it and most of the bundle
  (8.3 MB → 2.4 MB). `NSCameraUsageDescription` went with it.
- **Universal links.** The app no longer claims the domain, so a printed `/k/<code>` QR opens the web page instead of
  handing off. The Worker still serves `/k/*` and the `apple-app-site-association`, deliberately.
- **The code screen.** Sessions open anonymously through `POST /v1/session/anon`, which mints an anchor `books` row
  so everything downstream still reaches the reader through `session.book_id`. Two consequences: a printed code
  grants nothing the app does not already give away, and progress lives or dies with `localStorage` — clearing it
  or reinstalling starts a new anonymous reader with no way back. `users.email` is where a recovery path would go.
