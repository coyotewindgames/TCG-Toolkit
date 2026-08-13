# Mobile Capacitor Roadmap

Research and a phased implementation plan for wrapping the Turbocomp web app (Register POS + Remote Scan) in
Capacitor to ship native iOS and Android apps — Option B from the mobile-strategy comparison, chosen because it
reuses nearly all existing React UI and gets native camera access + app-store distribution without a rewrite.

> Prepared from a full read of capacitorjs.com/docs plus the current state of `TCG-Toolkit` @ `main`, 2026-08-13.
> **Status: draft, for review.** Locked-in decisions: build iOS **and** Android from day one via a cloud Mac CI
> runner (no local Mac — dev machine is Windows); push notifications **deferred** to a later phase.

## Contents

**Part 1 — Capacitor documentation specification**
- [1.1 Wrapping an existing app](#11-wrapping-an-existing-app)
- [1.2 Platform prerequisites](#12-platform-prerequisites)
- [1.3 Secure token storage](#13-secure-token-storage)
- [1.4 Barcode / QR scanning](#14-barcode--qr-scanning)
- [1.5 Push notifications](#15-push-notifications-deferred)
- [1.6 Cookies & CORS in a WebView](#16-cookies--cors-in-a-webview)
- [1.7 Build, CI & signing](#17-build-ci--signing)
- [1.8 CLI reference](#18-cli-reference)

**Part 2 — Current state (corrections to the original brief)**
- [2.1 Auth is already mostly bearer-token-based](#21-auth-is-already-mostly-bearer-token-based)
- [2.2 Two different "scanners," not one](#22-two-different-scanners-not-one)
- [2.3 No idempotency on order-mutation endpoints](#23-no-idempotency-on-order-mutation-endpoints)
- [2.4 No offline/outbox pattern exists](#24-no-offlineoutbox-pattern-exists)
- [2.5 PWA / build state](#25-pwa--build-state)
- [2.6 Branding / appId](#26-branding--appid)

**Part 3 — Implementation phases**
- [Phase 1 — Workspace setup](#phase-1--workspace-setup)
- [Phase 2 — Auth rework](#phase-2--auth-rework)
- [Phase 3 — Idempotency + offline outbox](#phase-3--idempotency--offline-outbox)
- [Phase 4 — Camera scanner plugin swap](#phase-4--camera-scanner-plugin-swap)
- [Phase 5 — CI/CD](#phase-5--cicd)
- [Phase 6 — Push notifications (deferred)](#phase-6--push-notifications-deferred)

- [Open decisions](#open-decisions)

---

# Part 1 — Capacitor documentation specification

Reference material, current as of Capacitor 8.x (8.5, July 2026).

## 1.1 Wrapping an existing app

This is the "existing web app" path, distinct from `create @capacitor/app` (which scaffolds a new project).

```sh
npm i @capacitor/core
npm i -D @capacitor/cli
npx cap init <appName> <appId> --web-dir dist

npm i @capacitor/android @capacitor/ios
npx cap add android
npx cap add ios [--packagemanager SPM|Cocoapods]
```

- `appId` must be reverse-domain notation (e.g. `com.theturbocomp.app`); `appName` is the display name.
- `webDir` **must point at the Vite build output** — for this repo, `'dist'` matches `apps/web/vite.config.ts`'s
  `build.outDir` exactly, no rename needed.
- Requires a `package.json`, a build-output directory, and an `index.html` at that directory's root with a
  `<head>` tag — Vite's output already satisfies this.

**`capacitor.config.ts` key fields**: `appId`, `appName`, `webDir`, `loggingBehavior`, `backgroundColor`,
`server` (see below), per-platform `android`/`ios` override blocks, `plugins` (per-plugin config), `includePlugins`.

**Standard build/sync loop:**
```sh
npm run build      # vite build -> dist/
npx cap sync        # copies dist/ into ios/ and android/, updates native deps
npx cap run ios|android   # or `npx cap open <platform>` for the native IDE
```

**Live-reload against the existing Vite dev server** (which already proxies `/api` and `/socket.io` to
`localhost:3000` per `apps/web/vite.config.ts`):

The `server` config block drives this:
```ts
server?: {
  hostname?: string;          // default 'localhost'
  iosScheme?: string;         // default 'capacitor'
  androidScheme?: string;     // default 'https'
  url?: string;               // external dev-server URL — drives live reload
  cleartext?: boolean;        // default false; must be true for plain http:// on Android
  allowNavigation?: string[];
}
```

Two workflows:
1. **Preferred, no config file edits**: `npx cap run <platform> --live-reload --host=<LAN-IP> [--port 5173]`.
   The CLI computes the dev-server URL and patches only the native project's *runtime* copy of the config —
   the checked-in `capacitor.config.ts` stays clean. `--forwardPorts <port1:port2>` (`adb reverse`) avoids the
   LAN-IP dance entirely for a USB-tethered Android device/emulator.
2. **Manual fallback** (e.g. launching from Xcode/Android Studio directly): drive `server.url` from an
   environment variable read inside `capacitor.config.ts`, never as a literal — see Phase 1 below.

> **Never commit a literal `server.url`/`cleartext` value to `capacitor.config.ts`** — treat it as a local
> dev-only override.

## 1.2 Platform prerequisites

| Requirement | Value |
|---|---|
| Node.js | 22 or higher |
| Xcode | 26.0 minimum (macOS Sequoia 15.6+; Xcode 26.4 bumps this to macOS Tahoe 26.2) |
| CocoaPods | installed (`brew install cocoapods`), no hard-pinned minimum documented |
| Android Studio | 2025.2.1 minimum |
| Android SDK | Platforms for API 24+ installed; latest stable target referenced is API 36 |
| iOS deployment target | 15+ |
| Android deployment target | API 24+ (Android 7.0+, ~99% of the market) |
| WebView engine | iOS: WKWebView · Android: system WebView |

**What's inside the platform folders:**
- `ios/App/App.xcworkspace` — the file you actually open; standard Xcode project + `Podfile`/`Podfile.lock`
  (CocoaPods) or SPM package refs.
- `android/` — a standard Gradle project (`app/build.gradle`, `AndroidManifest.xml`,
  `app/src/main/assets/{public/, capacitor.config.json, capacitor.plugins.json}` — those last three are
  **generated by `cap sync`/`copy`**, never hand-edited).

**Git policy**: **commit** `ios/` and `android/` — they hold hand-edited native config (`Info.plist`,
`AndroidManifest.xml`, signing config, permission strings, push capability entitlements) that isn't regenerated
from web code. **Don't commit** the generated/derived pieces inside them: iOS `Pods/`, `build/`, `xcuserdata/`,
`DerivedData`; Android `app/build/`, `.gradle/`, `local.properties`, `*.apk`; and the copied web assets under
`android/app/src/main/assets/public` / `ios/App/App/public` (refreshed by every `cap sync`).

## 1.3 Secure token storage

**`@capacitor/preferences`** (first-party) is **explicitly not encrypted** — the docs state it uses
`UserDefaults` on iOS and `SharedPreferences` on Android, the same protection tier as `localStorage`, just
native. **Not suitable alone for a refresh token.**

| Package | iOS | Android | Cost | Status |
|---|---|---|---|---|
| `capacitor-secure-storage-plugin` | Keychain (SwiftKeychainWrapper) | AndroidKeyStore + SharedPreferences | Free, MIT | Established community plugin |
| `@aparajita/capacitor-secure-storage` | Encrypted system keychain | AES-GCM, key in AndroidKeyStore | Free, MIT | Actively used; has `setSynchronize()` for iCloud Keychain sync control |
| `@capawesome-team/capacitor-secure-preferences` | Keychain items | Keystore-encrypted key, SharedPreferences values | **Paid** (sponsorware) | Actively maintained, same vendor as the ML Kit plugins below |
| `@ionic-enterprise/secure-storage` | Keychain | Keystore | Commercial | **Sunsetting** (Ionic enterprise wind-down, Dec 31 2027) — don't adopt |
| `@capacitor-community/secure-storage` | — | — | — | **Does not exist as a published package.** Only ever an open, unfulfilled proposal. Don't plan around it. |

Common API shape:
```ts
configure(options: ConfigureOptions) => Promise<void>
get(options: { key: string }) => Promise<{ value: string | null }>
set(options: { key: string; value: string }) => Promise<void>
remove(options: { key: string }) => Promise<void>
```

**Recommendation**: `@aparajita/capacitor-secure-storage` (free, TypeScript-first) with
`capacitor-secure-storage-plugin` as a fallback if Capacitor 8 peer-dep support isn't confirmed yet at
implementation time.

## 1.4 Barcode / QR scanning

**`@capacitor-community/barcode-scanner`** — **archived October 2024**. Its own README says it's deprecated.
**Do not use.**

**`@capacitor/barcode-scanner`** — new first-party plugin.
- iOS: `NSCameraUsageDescription` in `Info.plist`; uses Apple's Vision framework.
- Android: minimum SDK **26**; can back onto ZXing or ML Kit per-call.
- API: `scanBarcode(options) => Promise<{ ScanResult: string; format: ... }>` — **single-shot**.

**`@capacitor-mlkit/barcode-scanning`** — Google ML Kit, from the Capawesome team (`capawesome-team/capacitor-mlkit`),
confirmed actively maintained in 2026.
- iOS: `NSCameraUsageDescription`; **CocoaPods only** (ML Kit doesn't support SPM).
- Android: `<uses-permission android:name="android.permission.CAMERA" />` + a required
  `<meta-data android:name="com.google.mlkit.vision.DEPENDENCIES" android:value="barcode_ui"/>` tag.
- API: **listener-based** — `checkPermissions()`/`requestPermissions()`, `addListener('barcodeScanned', cb)`,
  `startScan()`/`stopScan()`. Result: `{ format, rawValue, displayValue, valueType, bytes, cornerPoints }`.

Both are live, actively maintained 2026 options. See [2.2](#22-two-different-scanners-not-one) and
[Phase 4](#phase-4--camera-scanner-plugin-swap) for which one fits this app's existing UX.

## 1.5 Push notifications (deferred)

Documented for completeness — **out of scope for this plan** per the user's decision.

`@capacitor/push-notifications` (first-party). Apple side: Apple Developer Program account, Push Notifications
capability enabled in Xcode, an APNs Auth Key (.p8) — typically uploaded into a Firebase project rather than
used directly. Android side: a Firebase project, `google-services.json` in `android/app/`, Android 13+ needs an
explicit runtime permission prompt.

```ts
await PushNotifications.requestPermissions();
await PushNotifications.register();
await PushNotifications.addListener('registration', (token) => { /* token.value */ });
await PushNotifications.addListener('pushNotificationReceived', (n) => { ... });
```

## 1.6 Cookies & CORS in a WebView

The most consequential section for this app's httpOnly, `SameSite=None` refresh cookie.

**App origin**: Capacitor apps run at `capacitor://localhost` (iOS) or `http(s)://localhost` (Android, via
`server.androidScheme`) — **never** the API's real origin. Every API call is cross-origin by construction; there
is no same-site cookie behavior to rely on.

**`CapacitorHttp`** (bundled in `@capacitor/core`, disabled by default) patches `fetch`/`XMLHttpRequest` to route
through native HTTP libraries, which aren't subject to the WebView's CORS/Same-Origin Policy. **`CapacitorCookies`**
(same package, also disabled by default) similarly patches `document.cookie` to route through native cookie
stores. Enabling both is one way to keep cookie auth alive — but it's opt-in complexity, not the default.

**iOS third-party-cookie restriction**: WKWebView (iOS 14+) restricts third-party cookies. `WKAppBoundDomains`
in `Info.plist` (max 10 domains) is a partial mitigation, not a guarantee.

**CORS mechanics**: since the WebView origin never matches the API's origin, the backend must send a proper
`Access-Control-Allow-Origin` and — for any cookie-based auth to survive at all — `Access-Control-Allow-Credentials: true`.

**Net guidance** (synthesized from the above, not a single doc sentence): the lower-friction, standard hybrid-app
pattern is **bearer-token auth stored via a Keychain/Keystore secure-storage plugin**, sent as an
`Authorization` header — sidestepping the WKWebView third-party-cookie restriction entirely rather than fighting
it via `CapacitorCookies` + `WKAppBoundDomains` + CORS-credentials wiring. See [Phase 2](#phase-2--auth-rework).

## 1.7 Build, CI & signing

Capacitor has **no first-party CI/build product of its own** in practical terms today. Ionic's Appflow (cloud
build + live-update) is being wound down — no new customers, bug-fixes-only support until it sunsets
**December 31, 2027**. Don't build new infrastructure on it.

**Fastlane is the standard, community-recommended approach** for both platforms:
- `match` — syncs iOS signing certs & provisioning profiles across a team via a shared encrypted repo.
- `gym` (`build_ios_app`) — builds the `.ipa`, handles beta distribution.
- `supply` — uploads Android builds/metadata to Google Play.

**On EAS specifically**: EAS (Expo Application Services) is an **Expo/React-Native-ecosystem tool, not a
Capacitor tool**. It's built around Expo's managed config model and generates Expo-flavored native projects;
under the hood it shells out to Fastlane anyway. Referencing EAS in a Capacitor build pipeline — as the original
brief's "Fastlane/EAS" did — would be a mistake. **Use Fastlane directly.**

## 1.8 CLI reference

| Command | Description |
|---|---|
| `init <appName> <appId> [--web-dir <dir>]` | Creates `capacitor.config.ts`/`.json` |
| `add <ios\|android>` | Generates the native platform folder |
| `sync [<platform>]` | `copy` + `update` — copies web build + config, installs/updates native plugin deps |
| `copy [<platform>]` | Copies `webDir` + config into native project(s) only |
| `update [<platform>]` | Updates native plugin dependencies without recopying web assets |
| `open <ios\|android>` | Opens the native IDE (Xcode / Android Studio) |
| `run <ios\|android> [-l/--live-reload] [--host] [--port]` | Syncs, builds, deploys to a simulator/emulator/device |
| `ls` | Lists installed platforms and plugins |
| `build <platform>` | Builds a signed release artifact |
| `doctor` | Diagnostic check of the Capacitor environment/config |
| `migrate` | Assists a major-version migration |

---

# Part 2 — Current state (corrections to the original brief)

## 2.1 Auth is already mostly bearer-token-based

The original brief assumed a full cookie-auth rework was needed. Verified directly against the code, it's
smaller than that:

- **Access-token verification already has zero cookie dependency.** `passport-jwt`'s
  `ExtractJwt.fromAuthHeaderAsBearerToken()` (`apps/api/src/server/auth/strategies.ts:39`) is the only
  verification path server-side — an `Authorization: Bearer` header, not a cookie.
- **The frontend already sends it that way** — `apps/web/src/lib/api.ts`'s `rawFetch` attaches
  `Authorization: Bearer <accessToken>` on every request — and **already persists it to `localStorage`**
  (`apps/web/src/lib/session.ts`, key `tcg.auth`), not memory-only, despite a stale code comment claiming
  otherwise.
- **The only cookie-dependent call in the entire auth system is `POST /api/auth/refresh`**, which reads
  `req.cookies?.[env.REFRESH_COOKIE_NAME]` exclusively (`apps/api/src/server/auth/routes.ts:113-126`, verified
  directly this session). The cookie itself: name `tcg_refresh` (default), `httpOnly: true`,
  `secure: isProd()`, `sameSite: isProd() ? 'none' : 'lax'`, `domain: env.COOKIE_DOMAIN` (`.theturbocomp.com`
  in prod), `path: '/api/auth'` (`routes.ts:28-38`).
- The refresh token itself is already an **opaque random value** (`randomBytes(32).toString('base64url')`,
  `service.ts`), with only its SHA-256 hash persisted server-side — nothing about its design assumes
  cookie-only delivery. Handing the raw value to a client in a JSON body (as Phase 2 proposes) changes nothing
  about its security model.
- **Socket.IO auth needs zero changes.** `apps/web/src/lib/socket.ts` already sends the JWT explicitly in the
  handshake `auth` payload; `apps/api/src/server/realtime/socket.ts` verifies it with the same
  `verifyAccessToken` used for HTTP. Cookies are never involved.
- **There's an existing precedent for tokens outside cookies**: the "remote scan handoff" QR feature already
  base64url-encodes `{ accessToken, user, locationId, registerId }` into a URL fragment (`Register.tsx`) so a
  second device can inherit a session by scanning a code (`AuthGuard.tsx` consumes it) — architecturally close
  to what native bearer-only auth needs.

**Net**: the real work is narrower than "rework auth" — it's (a) a mobile-aware branch on `/api/auth/refresh`
and `/logout` so they work without a cookie, and (b) moving both tokens from plain `localStorage` into real
Keychain/Keystore secure storage on native builds only, leaving the web app's cookie flow untouched.

## 2.2 Two different "scanners," not one

The brief referred to "the scanner" as one thing. It's two, serving different purposes:

- **`useBarcodeScanner`** (`apps/web/src/hooks/useBarcodeScanner.ts`) is **not a camera scanner** — it's a pure
  `keydown` event listener for a **USB HID keyboard-wedge scanner gun** (the physical device a clerk points at a
  card at the register; it "types" the barcode + Enter like a keyboard). Used in `Register.tsx`. A WebView
  receives `keydown` DOM events identically to a desktop browser — **this needs no code change**, only
  device-pairing verification on both target OSes.
- **The actual camera-based scanning** — `@zxing/browser`'s `BrowserMultiFormatReader.decodeFromConstraints(...)`
  — is inlined directly in **`RemoteScan.tsx`** (lines ~193-217), with no shared hook to preserve. This is the
  file that needs decomposing into a swappable web/native abstraction (Phase 4). `@zxing/browser: ^0.1.5`
  (`apps/web/package.json`) is a real, singular dependency, used only here.

## 2.3 No idempotency on order-mutation endpoints

`POST /orders/:id/items` (`apps/api/src/server/routes/orders.ts`, body `{ barcode }`) →
`OrdersService.addScannedItem` (`apps/api/src/server/services/orders.ts:37-101`, verified directly this
session) has **no transaction wrapper** and **unconditionally inserts a new `order_items` row on every call** —
no client-supplied request id, no dedupe. Replaying a queued offline POST would double-add the item.

The codebase already has a pattern to mirror: **`webhookEvents`** (`apps/api/src/db/schema/audit.ts:34`, dedupes
by `(provider, providerEventId)`), the established idempotency mechanism for inbound POS webhooks today. A
`(storeId, clientRequestId)`-keyed table following the same shape is the natural fit — see
[Phase 3](#phase-3--idempotency--offline-outbox).

(Note: the schema was reorganized into `apps/api/src/db/schema/` as a directory — `enums.ts`, `core.ts`,
`catalog.ts`, `inventory.ts`, `orders.ts`, `trades.ts`, `audit.ts`, `auth.ts`, `config.ts`, re-exported from
`index.ts` — since earlier work in this repo. `orders`, `orderItems`, and `payments` all live in
`db/schema/orders.ts`; the new idempotency table belongs there too, not in `audit.ts`.)

## 2.4 No offline/outbox pattern exists

Confirmed via exhaustive grep across `apps/web/src` for "outbox," "offline," "queue," "idb," "indexeddb" — no
hits relevant to network retry (the only "queue" matches are the unrelated in-memory Trade-In cart-building
feature). `apps/web/src/main.tsx`'s `QueryClient` has no `mutations` defaults, no `persistQueryClient`, no
network-mode config. This is genuinely new subsystem work, not a config flip.

Two things that make the build easier than a from-scratch design, though: `Register.tsx` already reconciles
state by calling a full `refreshOrder()` (`GET /orders/:id`) on every socket event *and* every 2500ms poll tick
— it doesn't try to merge pushed payloads — so a flushed outbox entry just needs to trigger that same call
rather than new merge logic.

## 2.5 PWA / build state

`apps/web/public/manifest.webmanifest` is minimal (name "Turbocomp", one 512×512 icon, no maskable icon) — no
service worker, no `vite-plugin-pwa`/workbox anywhere. Nothing conflicts with adding Capacitor.

The Vite dev server proxies `/api` and `/socket.io` to `localhost:3000` (`apps/web/vite.config.ts`) — this
proxy does not exist inside a Capacitor WebView. Native builds must set `VITE_API_URL` to an absolute, reachable
URL (the deployed API in prod, or a LAN IP for local device testing). The env var mechanism already exists
(`import.meta.env.VITE_API_URL`, used in both `api.ts` and `socket.ts`) — no new plumbing needed, just a
build-time value.

Root `package.json`'s workspace glob (`["packages/*", "apps/*"]`) already picks up a new `apps/mobile` workspace
with zero config changes.

## 2.6 Branding / appId

Production is `theturbocomp.com` / `api.theturbocomp.com` (brand **"Turbocomp"**) — distinct from the repo's
internal name "TCG-Toolkit." The Capacitor `appId` should be confirmed against the real brand
(e.g. `com.theturbocomp.app`), not assumed from the repo name. Flagged as an open decision below.

---

# Part 3 — Implementation phases

## Phase 1 — Workspace setup

**Goal**: stand up `apps/mobile` as a Capacitor shell around `apps/web`'s existing build output, with a safe
local live-reload workflow, without touching `apps/web`'s production (Render static site) build path.

**Structure decision**: a new `apps/mobile` workspace — not Capacitor-ifying `apps/web` in place. Keeping them
separate avoids coupling the Render static-site build (`render.yaml`: `staticPublishPath: apps/web/dist`) with
native tooling in the same tree, and avoids `package.json` script-name collisions (`build` meaning "for the CDN"
vs "for `cap sync`").

- `apps/mobile/package.json` — new workspace `@tcg/mobile`, scripts wrapping `build --workspace=@tcg/web` +
  `cap sync`/`open`. `@capacitor/android`, `@capacitor/ios`, `@capacitor/cli` live here.
  `@capacitor/core` itself belongs in **`apps/web/package.json`** instead — the runtime code that calls
  `Capacitor.isNativePlatform()` (secure storage branch, scanner abstraction) lives in `apps/web/src`, the same
  bundle both the browser and the WebView load.
- `apps/mobile/capacitor.config.ts` — `webDir: '../web/dist'` (relative path straight into `apps/web`'s real
  Vite output — no copy step, no symlink; Windows symlinks need elevated privileges, a needless dev-onboarding
  tax). `appId` per [2.6](#26-branding--appid), pending confirmation.
- `apps/mobile/ios/` and `apps/mobile/android/` — created via `npx cap add ios`/`android` (once `apps/web/dist`
  exists from a prior build). Both **committed to git** per [1.2](#12-platform-prerequisites).
- `apps/mobile/.gitignore` (new) — `ios/App/Pods/`, `ios/App/App.xcworkspace/xcuserdata/`,
  `ios/App/App/public/`, `android/.gradle/`, `android/app/src/main/assets/public/`, `android/local.properties`.
  (The root `.gitignore` already has bare `build/`/`dist/` lines that cover the Gradle build dirs — only the
  Capacitor/Xcode/Gradle-specific paths above are new.)
- Live-reload: `npx cap run android --live-reload --host=<LAN-IP>` as the default path (see
  [1.1](#11-wrapping-an-existing-app)); a `CAP_DEV_SERVER_URL` env var read inside `capacitor.config.ts` as the
  manual fallback for launching directly from Xcode/Android Studio.

**Exit criterion**: `npx cap doctor` (run from `apps/mobile`) reports no errors; `npx cap open ios`/`android`
launches Xcode/Android Studio with the current `apps/web` build visible in a simulator/emulator as a
blank-but-loading SPA (API calls fail until Phase 2 — expected). `git status` shows `ios/`/`android/` tracked
with `Pods/`/`.gradle/`/copied `public/` assets absent.

## Phase 2 — Auth rework

**Goal**: make `/api/auth/refresh` and `/logout` work from a Capacitor origin that can't rely on the httpOnly
refresh cookie, without breaking the existing browser cookie flow; move both tokens to native secure storage.

**Backend** (`apps/api/src/server/auth/routes.ts`) — additive, backward-compatible:
- `/login` (line 65) and `/signup` (lines 103-109): also return the raw refresh token in the JSON body
  alongside the existing cookie set. Existing web callers already ignore unknown response fields.
- `/refresh` (lines 113-126): resolve the token from the body first, falling back to the cookie:
  `req.body?.refreshToken ?? req.cookies?.[env.REFRESH_COOKIE_NAME]`. Still calls `setRefreshCookie` too — a
  harmless no-op for a WebView that can't use it.
- `/logout` (lines 128-136): same body-or-cookie fallback for revocation.
- New shared DTOs in `packages/shared/src/index.ts`: `RefreshRequest`/`LogoutRequest`, both
  `{ refreshToken: z.string().min(16).max(512).optional() }`.
- **Operational, not code**: `CORS_ORIGIN` (Render dashboard secret, per `render.yaml`) needs
  `capacitor://localhost` / `https://localhost` added before native builds can call the API at all.

**Frontend** (`apps/web/src`) — all native-vs-web branching happens at runtime via
`Capacitor.isNativePlatform()`, since `apps/mobile` just wraps this same bundle:
- `apps/web/src/lib/secureStorage.ts` (new) — a `TokenStorage` interface with a `localStorage`-backed web
  implementation (unchanged behavior) and a secure-storage-plugin-backed native implementation
  (`@aparajita/capacitor-secure-storage`, see [1.3](#13-secure-token-storage)).
- `apps/web/src/lib/session.ts` — `bootstrapSessionFromStorage()` currently runs **synchronously** at module
  load (`localStorage` is sync); secure-storage plugins are Promise-based, so this becomes async on native:
  `state.bootstrapping` stays `true` until an async hydrate resolves. `persistAuthSession`/
  `clearPersistedAuthSession` become `async`, routed through the new storage adapter. `AuthGuard.tsx`'s existing
  `session.bootstrapping` gate needs no change — it already waits correctly regardless of *why*.
- `apps/web/src/lib/api.ts` — two fixes while touching this file anyway:
  1. **Consolidate the duplicated refresh-on-401 logic** — `rawFetch`, `getBlob`, and `postForm` each
     independently call `refreshAccessToken()` today with no de-dupe (three concurrent 401s fire three refresh
     calls). Add a module-level single-flight guard and route all three through it.
  2. `refreshAccessToken()` gains a native branch: read the stored refresh token via `secureStorage.ts` and POST
     it as `{ refreshToken }` in the body instead of relying on `credentials: 'include'`; persist the rotated
     token from the response back into secure storage. Web behavior is unchanged.
- `Register.tsx` / `useSellTransaction.ts` — both duplicate an `isLocalOrigin()` helper gating whether
  `window.location.origin` is usable as the remote-scan QR base URL, with `VITE_REMOTE_SCAN_BASE_URL` as an
  existing escape hatch. On native, `window.location.origin` is `capacitor://localhost`/`https://localhost` —
  **verify** `VITE_REMOTE_SCAN_BASE_URL` is set correctly for native builds, and consider tightening
  `isLocalOrigin()` to treat any non-`http(s)` scheme as "not usable" so a misconfigured build fails safe
  instead of emitting a broken QR code. Flagged as verify + small hardening, not a rebuild.

**Exit criterion**: on a real device, login → app backgrounded past `JWT_ACCESS_TTL_SECONDS` (default 1hr) →
foregrounded → next API call transparently refreshes via the body-based flow, with rotated tokens re-persisted
in Keychain/AndroidKeyStore. Existing browser login/refresh/logout on theturbocomp.com is unchanged (regression
check — cookie flow untouched). Root `typecheck`/`lint` pass across all three workspaces.

## Phase 3 — Idempotency + offline outbox

**Goal**: make replaying a queued write safe, then build the minimal offline queue that actually needs it.

**Step A — idempotency** (prerequisite, ships independently of the outbox):
- New table in **`apps/api/src/db/schema/orders.ts`** (co-located with `orders`/`orderItems`/`payments`):
  `orderMutationRequests` — `id`, `storeId`, `orderId`, `clientRequestId`, `action`, `responseSnapshot` (jsonb),
  `createdAt`; unique on `(storeId, clientRequestId)`, mirroring `webhookEvents`'s dedupe shape. Needs a Drizzle
  migration (`npm run db:generate --workspace=@tcg/api`).
- `AddItemRequest` moves from being defined inline in `apps/api/src/server/routes/orders.ts` into
  `packages/shared/src/index.ts` (alongside `CreateOrderRequest`/`CheckoutRequest`), gaining an optional
  `clientRequestId: z.string().uuid()`.
- `OrdersService.addScannedItem` (`apps/api/src/server/services/orders.ts:37-101`) gets wrapped in
  `this.db.transaction(...)` (it isn't today — a real gap, since two near-simultaneous replays of the same
  `clientRequestId` could otherwise both pass a "not found" check before either commits) and a
  check-then-cache: look up `orderMutationRequests` by `(storeId, clientRequestId)` first; if found, return the
  cached `responseSnapshot` verbatim; if not, do the existing insert, then record the idempotency row in the
  same transaction.

**Step B — the outbox** (client, genuinely new subsystem):
- Scope: queue **only** the scanned-item-add action. Checkout/record-sale/cancel stay online-only — checkout
  depends on a live round-trip to the POS provider and isn't safe to blind-queue; surface a clear "you're
  offline, try again" state for those instead.
- `apps/web/src/lib/outbox/db.ts` (new) — IndexedDB via the `idb` package (new dependency), one object store
  keyed by `clientRequestId` — the *same* id sent to the server as the idempotency key, not a separate one.
  Entry: `{ clientRequestId, orderId, action, payload, status, attempts, createdAt, lastError? }`.
- `apps/web/src/lib/outbox/processor.ts` (new) — flush loop on `online` event + a periodic timer, exponential
  backoff per entry, marks `failed` after N attempts with a manual-retry affordance, removes the entry and
  triggers `refreshOrder()` on confirmed success (safe even on a duplicate replay thanks to Step A).
- `Register.tsx` (HID-scan handler) and `RemoteScan.tsx` (`submitBarcode`) — generate a `clientRequestId` per
  scan, try the network call first, enqueue into the outbox only on an actual network-level failure (not an
  HTTP error). Render an optimistic "Syncing…" line until reconciled.

**Exit criterion**: toggling Wi-Fi off mid-scan queues locally (visible as "Syncing…"), reconnecting flushes
automatically within one backoff cycle, and a manual duplicate replay of the same `clientRequestId` provably
does not create a second `order_items` row (new backend test, mirroring however `webhookEvents` dedupe is
tested today).

## Phase 4 — Camera scanner plugin swap

**Goal**: extract the inlined `@zxing/browser` logic in `RemoteScan.tsx` into a swappable web/native scanning
abstraction; confirm (not rebuild) that `Register.tsx`'s HID listener needs no change.

- `apps/web/src/lib/scanning/types.ts` (new) — a `CameraScanner` interface: `start(video, onDecode)`, `stop()`,
  `isSupported()`.
- `apps/web/src/lib/scanning/webZxingScanner.ts` (new) — the existing `BrowserMultiFormatReader`/
  `decodeFromConstraints` logic moved verbatim out of `RemoteScan.tsx`, used when
  `!Capacitor.isNativePlatform()` — keeps the browser flow fully intact.
- `apps/web/src/lib/scanning/nativeMlkitScanner.ts` (new) — wraps `@capacitor-mlkit/barcode-scanning`.
  **Recommendation**: ML Kit over the first-party single-shot plugin — `RemoteScan.tsx`'s existing UX is
  *continuous* (camera stays live, a `DEDUPE_WINDOW_MS` guard prevents re-submitting the same code), and ML
  Kit's listener-based `startScan()`/`addListener('barcodeScanned', ...)` maps directly onto that; the
  single-shot plugin would need a manual loop to approximate it. Tradeoff: third-party (Capawesome) vendor
  rather than first-party, CocoaPods-only on iOS, and bundles ML Kit's on-device models (larger app size).
- `apps/web/src/lib/scanning/useCameraScanner.ts` (new) — picks the implementation via
  `Capacitor.isNativePlatform()`, exposes a uniform `{ status, error, start, stop }` to the page.
- `RemoteScan.tsx` — refactored to consume the hook instead of inlining `readerRef`/`controlsRef`. The
  `<video>` element is meaningful only for the web zxing path — most native plugins render their own camera
  overlay outside the WebView DOM, so the component needs a conditional render.
- Native permissions: `NSCameraUsageDescription` in `apps/mobile/ios/App/App/Info.plist`;
  `<uses-permission android:name="android.permission.CAMERA" />` + the ML Kit meta-data tag in
  `apps/mobile/android/app/src/main/AndroidManifest.xml`.
- `Register.tsx`'s `useBarcodeScanner` — **verify, don't rebuild** (see [2.2](#22-two-different-scanners-not-one)):
  confirm a USB-C/Lightning or Bluetooth HID scanner actually pairs and types into the WebView on both target
  OSes, and that no on-screen keyboard/focus-stealing interferes since the listener is `window`-level.

**Exit criterion**: `RemoteScan.tsx` behaves identically in a desktop/mobile browser (confirms the abstraction
didn't regress the web flow); on a native build, the same page uses the native scanner with a camera permission
prompt showing the configured usage string, successfully posting to `/orders/:id/items` with the same
dedupe/audio/vibration feedback.

## Phase 5 — CI/CD

**Goal**: automate iOS and Android builds/signing from a cloud Mac runner, using Fastlane, per the user's
decision to ship both platforms from day one without a local Mac.

**Hard prerequisites** (account/billing actions, not something this plan can execute):
- Apple Developer Program enrollment ($99/yr) — bundle-ID registration matching the chosen `appId`,
  provisioning profiles via `match`, an App Store Connect record, TestFlight.
- Google Play Console developer account ($25 one-time) — package registration, Play App Signing, a
  service-account JSON key for `supply`. Note: a brand-new app's *first* release typically needs one manual pass
  through the Play Console UI (store copy, content rating, screenshots) before `supply` automation is clean for
  subsequent releases.
- A private `match` storage location (git repo or cloud bucket) for iOS certs/profiles, created and seeded
  before CI's `match` step can succeed.
- Store listing assets (icons, screenshots, descriptions).

**Files**:
- `.github/workflows/mobile-release.yml` (new — kept separate from the existing `.github/workflows/ci.yml`,
  which stays `ubuntu-latest` and continues running `typecheck`/`lint`/`test` for `apps/api`/`apps/web`/
  `packages/shared` unchanged).
- `apps/mobile/ios/fastlane/{Fastfile,Appfile,Matchfile}` — `match` → `gym` → `pilot` lanes.
- `apps/mobile/android/fastlane/{Fastfile,Appfile}` — Gradle assemble/bundle → `supply` lanes.

**Workflow shape**: both jobs on `macos-latest` (per the locked-in decision — Android would build more cheaply
on `ubuntu-latest`, a low-stakes future optimization, not changing what's decided). Each: checkout → Node 22
setup → `npm ci` → build `@tcg/shared` then `@tcg/web` with `VITE_API_URL` set to the production API as a
build-time value → `npx cap sync <platform>` → Ruby/Fastlane setup → `bundle exec fastlane <platform> beta`.

**Secrets needed** (documented, not created by this doc): `MATCH_GIT_URL`/`MATCH_PASSWORD`, an App Store Connect
API key, `ANDROID_KEYSTORE_BASE64` + password/alias, `PLAY_STORE_SERVICE_ACCOUNT_JSON`, `VITE_API_URL`.

**Trigger recommendation**: manual `workflow_dispatch` (optionally also on a version tag), not build-on-every-push
— native store builds are slow and consume paid macOS runner minutes.

**Exit criterion**: a manually triggered run produces a signed, installable TestFlight build and a signed Play
internal-testing `.aab` from the same commit, with no local Mac involved end to end.

## Phase 6 — Push notifications (deferred)

Out of scope per the user's decision. Placeholder only: when picked up later, it needs an Apple Developer push
certificate/key (APNs) and a Firebase project (FCM/Android) — neither needs setup now. See
[1.5](#15-push-notifications-deferred) for the plugin/API shape when this is revisited.

---

## Open decisions

- **`appId` / bundle naming** ([2.6](#26-branding--appid)) — confirm `com.theturbocomp.app` (or the real
  preferred reverse-DNS name) against the production brand before Phase 1.
- **Secure storage plugin** ([1.3](#13-secure-token-storage)) — `@aparajita/capacitor-secure-storage`
  recommended; verify its Capacitor 8 peer-dependency support at implementation time before locking it in.
- **Barcode plugin** ([1.4](#14-barcode--qr-scanning), [Phase 4](#phase-4--camera-scanner-plugin-swap)) —
  `@capacitor-mlkit/barcode-scanning` recommended for its continuous-scan UX fit; final call is a tradeoff
  against vendor/app-size concerns.
- **CI trigger** ([Phase 5](#phase-5--cicd)) — manual `workflow_dispatch` recommended over auto-build-on-merge.
- **Idempotency coverage** ([Phase 3](#phase-3--idempotency--offline-outbox)) — this plan scopes the dedupe
  table to `add_item` only; extending the same protection to `record-sale`/`checkout`/`cancel` would guard
  against double-tap/retry-button UI bugs too, even though those actions aren't outbox-queued — worth a call on
  whether that's in scope now or later.
