# Fire OS / no-GMS check of the staged release build

Date: 2026-10-24. Tools: Android SDK build-tools 36.1.0 (`aapt2`, `apksigner`), JDK 21 (`jarsigner`, `keytool`), Python 3 stdlib.
`$SDK` below = `~/AppData/Local/Android/Sdk/build-tools/36.1.0`.

Files checked (the staged release build as handed over; origin assumed to be the signed `bundleRelease` + `assembleRelease` output of `release-android-app.yml`, not verified):

| File                                                      | Size   | sha256                                                             |
| --------------------------------------------------------- | ------ | ------------------------------------------------------------------ |
| `$TEMP/cc-android-apk/rel/apk/release/app-release.apk`    | 1.3 MB | `73772fb455f98acffe8f62545d4fc8b9d69c956ccd2d573fc1b5f209b3783edb` |
| `$TEMP/cc-android-apk/rel/bundle/release/app-release.aab` | 3.2 MB | `239b88285d2dbf851c706dff59654e31d0c820dcbcc772d07fac3b4d9c2aa4f4` |

(`sha256sum` of both files.) Provenance caveat: these are local copies of the workflow artifact; this check proves what is in
THESE bytes, not that they equal a future tagged release.

## Result: PASS (no Google Mobile Services, no Firebase, no billing, no uses-library)

### 1. Badging

```
$ $SDK/aapt2.exe dump badging app-release.apk | head -4; ... | grep -i -E "uses-library|uses-feature|gms|firebase|play-services|billing|google"
package: name='com.devino.caramel' versionCode='107' versionName='1.5.0' platformBuildVersionName='16' platformBuildVersionCode='36' compileSdkVersion='36' compileSdkVersionCodename='16'
minSdkVersion:'26'
targetSdkVersion:'36'
uses-permission: name='android.permission.INTERNET'
uses-permission: name='com.devino.caramel.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
  uses-feature: name='android.hardware.faketouch'      <- the only grep hit: the "faketouch" feature, nothing Google
```

- Permissions: `INTERNET` and the app-private `com.devino.caramel.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` (added by AndroidX
  core for unexported dynamic receivers). No other permission.
- No `<uses-library>` element anywhere. (`grep -n "uses-library" manifest.txt` -> nothing.)
- `faketouch` is an implied feature (touchscreen not required), so Fire TV style devices are not filtered out.
- versionCode 107 (the workflow formula is 100 + run number, so this would be run 7; the origin of the staged files was not verified).

### 2. Manifest (`aapt2 dump xmltree --file AndroidManifest.xml app-release.apk`)

Relevant attributes: `usesCleartextTraffic=false`, `allowBackup=false`, `dataExtractionRules=@xml/data_extraction_rules`,
`appComponentFactory=androidx.core.app.CoreComponentFactory`. Components: `MainActivity` (exported, MAIN/LAUNCHER plus a
VIEW/BROWSABLE filter for the sign-in scheme `com.devino.caramel`), `androidx.startup.InitializationProvider` (EmojiCompat,
ProcessLifecycle, ProfileInstaller), `androidx.profileinstaller.ProfileInstallReceiver`. No service, no Google component, no
`com.google.*` or `com.android.vending` reference.

### 3. Forbidden-string scan (case-insensitive byte search; Python `re` over the bytes)

APK: `classes*.dex`, `AndroidManifest.xml`, `resources.arsc`. AAB: `base/dex/*.dex`, every `AndroidManifest*`,
`resources.pb`, `BUNDLE-METADATA/*`.

```
pattern                          APK   AAB
com/google/android/gms           0     0
com.google.android.gms           0     0
firebase                         0     0
billingclient                    0     0
com/android/billingclient        0     0
com/android/vending              0     0
play-services                    0     0
com/google/android/play          0     0
crashlytics                      0     0
analytics                        0     0
stripe                           0     0
io/sentry                        0     0
```

(One extra hit, `Sentry` x12 in the AAB, was inspected: it is the substring "sentry" inside `containsEntry` in `BUNDLE-METADATA/.../proguard.map` (case-insensitive match),
not a Sentry library. `io/sentry` is 0 in both.)

### 4. Bundled libraries (the `META-INF/*.version` files in the APK)

Only AndroidX (activity, annotation, arch core, autofill, browser, compose animation/foundation/material3/material-icons-core/
material-ripple/runtime/ui\*, core, customview, emoji2, graphics-path, interpolator, lifecycle, navigation, profileinstaller,
savedstate, startup, tracing, versionedparcelable) and `kotlinx_coroutines_android` / `kotlinx_coroutines_core`.
Nothing from `com.google.android.gms`, `com.google.firebase`, `com.android.billingclient` or any analytics/ads vendor.
(`androidx.browser` is the Custom Tabs helper: it opens whatever browser the device has; on Fire that is Silk, see risks.)

### 5. Signature (`apksigner`) and AAB signature

```
$ $SDK/apksigner.bat verify --verbose --print-certs app-release.apk
Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
Signer #1 certificate DN: CN=Caramel, O=Devino, C=CA
Signer #1 certificate SHA-256 digest: 328107e276b28d52e4b0be6423972122288fc13e6952d4626949df6bad6a0dce
Signer #1 key algorithm: RSA, key size 4096

$ jarsigner -verify app-release.aab
jar verified.
$ keytool -printcert -jarfile app-release.aab
Owner: CN=Caramel, O=Devino, C=CA     Valid from: Fri Oct 23 2026 until Tue Mar 10 2054
SHA256: 32:81:07:E2:76:B2:8D:52:E4:B0:BE:64:23:97:21:22:28:8F:C1:3E:69:52:D4:62:69:49:DF:6B:AD:6A:0D:CE
```

The AAB and the APK are signed by the same certificate (the colon-separated SHA256 equals the apksigner digest). The v2
scheme verifies, which is what Fire OS 7+ (Android 9+ based) needs; v1 is not required at minSdk 26. Only the public
certificate fingerprint is shown here; no key material or passwords were read.

### 6. Fire OS compatibility notes

- minSdk 26 (Android 8.0) covers Fire OS 7 (Android 9) and Fire OS 8 (Android 11) devices; it excludes Fire OS 5 and 6
  (Android 5.1 / 7.1), which is a known, accepted limit.
- ABIs: the APK carries `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` for `libandroidx.graphics.path.so`; Fire tablets are
  ARM (arm64 or armeabi-v7a), so both are covered.
- targetSdk 36 is fine on Fire (the platform runs the app in the compat mode of the device's own API level).

### 7. What this check does NOT prove

- It was not run on a Fire device or emulator (no emulator infrastructure, see `screenshots-TODO.md`). Whether Silk handles the
  Custom Tab redirect to `com.devino.caramel://auth/callback` is **untested**, as already noted on PR #465.
- Amazon's own Appstore submission scanner (virus / "Appstore Developer Select" checks) was not run.
- The AAB was checked as a zip (no `bundletool` installed); Amazon takes the APK, not the AAB.
