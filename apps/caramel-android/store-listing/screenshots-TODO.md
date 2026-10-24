# Screenshots - not produced (blocker)

Amazon needs 3+ screenshots (e.g. 1280x800 / 800x1280 / 1920x1080). None were made: they must come from the real app, never a
mock-up, and the app could not be run within reason for this task.

## Exact blockers (checked 2026-10-24)

- Remote compute (`MASTER_CHAT/tools/remote-run.sh`, host `devino-fifth`, load about 15 on 16 cores): `/dev/kvm` exists
  (`crw-rw---- root kvm`) but the agent user is **not in the `kvm` group** (`id -nG` has no `kvm`), so an x86 emulator would
  run without hardware acceleration, which is unusably slow for a Compose app.
- The host has **no JDK, no `adb`, no Android SDK or emulator** (`which java adb` finds nothing, `ANDROID_HOME` is empty). A
  debug build, an SDK, a multi-GB system image and an emulator would all have to be installed on a shared host.
- This Windows PC is off limits for Gradle and emulator work (task rule).
- No physical Fire or Android device is attached.

## Smallest working recipe (needs an owner decision on infra)

1. A runner with KVM access for the agent user (add it to the `kvm` group), JDK 21 and Android `cmdline-tools`.
2. `sdkmanager "platform-tools" "emulator" "system-images;android-35;default;x86_64"` (the plain AOSP image has no Google
   services, which is also the closest to Fire).
3. `avdmanager create avd`, boot headless, `adb install` the debug APK (`./gradlew assembleDebug` in `apps/caramel-android`)
   or the signed `app-release.apk` artifact from the release workflow.
4. Drive Deals, Search, a store page, Saved and Account (signed out), and capture with `adb exec-out screencap -p`. Set the
   emulator resolution to 1280x800 / 800x1280 / 1920x1080 for the Amazon sizes. Signed-in screens need a real sign-in on a
   device, which has not been done anywhere yet; do not fake them.

Alternative: a GitHub Actions job on a KVM-enabled ubuntu runner (the other Devino Android repos have `emulator-smoke.yml` /
`kvm-smoke.yml`). That is a new workflow and out of scope for a docs PR.
