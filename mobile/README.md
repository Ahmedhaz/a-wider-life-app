# A Wider Life · native shells

`mobile/` wraps `web/` with Capacitor. The content still comes from the Worker; only the shell ships through the stores.
Bundle id `com.awiderlife.app`, team `M3RPNM736H`, iOS 15+, iPhone only, portrait only.

What the shell adds over the web page: the system camera for the printed code (`@capacitor-mlkit/barcode-scanning`),
universal links (`https://a-wider-life.ahmed-haz.workers.dev/k/<code>` opens the app when installed; the Worker serves
`/.well-known/apple-app-site-association`), and push registration that stays dormant until the Worker's
`NOTIFY_ENABLED` is "true" (`/v1/flags`, `POST /v1/device`; no sender exists yet).

## One-time setup on the Mac (read the scars first)

```
brew install cocoapods                 # NOT `sudo gem install cocoapods`: it hangs on a silent Password: prompt
cd mobile && npm install
npx cap sync ios                       # copies web/ into ios/App/App/public and runs pod install
```
If `npx cap sync ios` prints nothing for minutes, run the pod step by hand: `cd ios/App && pod install`.

Open the workspace directly (not the repo folder, not `npx cap open ios` if it lands on the wrong window):
`open mobile/ios/App/App.xcworkspace`. After any `pod install`, close and reopen the workspace or Xcode keeps
the pre-Pods references and complains "No such module 'Capacitor'".

In Xcode once: Settings → Accounts → sign in with the Apple ID of team M3RPNM736H. Signing is automatic; the team
is already written into the project. Under Signing & Capabilities the two capabilities must be present:
Associated Domains (`applinks:a-wider-life.ahmed-haz.workers.dev`) and Push Notifications. Add them if Xcode
did not pick them up from `App/App.entitlements`.

## Every build

```
cd mobile && npx cap sync ios          # after any change under web/
```
Then in Xcode: a plugged iPhone or "Any iOS Device (arm64)" → Product → Archive → Distribute → TestFlight.
The App Store Connect record (name حياة أوسع / A Wider Life, bundle `com.awiderlife.app`) must exist before the first upload.

## Scars from the Adamos app (July 2026), still valid
- A leftover filter in the project navigator hides every file: clear the filter box at the bottom.
- "Device not registered": Signing & Capabilities → Register Device.
- Menu-bar overlays (NotchBox) block clicks on Xcode menus; use the keyboard or quit the overlay.
- Never commit `Pods/`, `node_modules/` or `ios/App/App/public/` (the copied web); `.gitignore` here covers them.

## What is NOT built
- No push sender. Registration only, and only when the flag is on.
- No Android project yet (`npx cap add android` when Google Play is opened).
- No offline audio.
