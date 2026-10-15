#!/usr/bin/env bash
# Scratch emulator run for the review of maathimself/mailflow#620. Run from frontend/packages/android
# inside reactivecircus/android-emulator-runner, after assembleDebug and assembleDebugAndroidTest.
set -u
APK=app/build/outputs/apk/debug/app-debug.apk
TEST_APK=app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
OUT="${GITHUB_WORKSPACE}/e2e-out"
mkdir -p "$OUT/shots"

adb wait-for-device
adb shell getprop ro.build.version.sdk
adb shell dumpsys webviewupdate | grep -i -E "current webview package|version" | head -5 || true
adb shell input keyevent 82 || true
adb shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS || true
adb install -r -t "$APK"
adb install -r -t "$TEST_APK"
adb logcat -c || true

adb shell am instrument -w -r -e class sh.mailflow.app.OidcLoginFlowTest \
  sh.mailflow.app.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/instrument.txt" 2>&1
cat "$OUT/instrument.txt"

adb logcat -d > "$OUT/logcat.txt" || true
grep "OidcFlow" "$OUT/logcat.txt" | grep -E "RESULT|PROBE|SHOT" > "$OUT/flow.txt" || true
echo "== Results and probes"
cat "$OUT/flow.txt"
echo "== Leaked windows"
grep -n -i "leaked window" "$OUT/logcat.txt" || echo "none"
echo "== Crashes"
grep -n "FATAL EXCEPTION" "$OUT/logcat.txt" || echo "none"

for f in $(adb shell run-as sh.mailflow.app ls files/oidc-shots 2>/dev/null | tr -d '\r'); do
  adb exec-out run-as sh.mailflow.app cat "files/oidc-shots/$f" > "$OUT/shots/$f"
done
ls -la "$OUT/shots"

if grep -q "FAILURES!!!" "$OUT/instrument.txt" || ! grep -q "^OK (" "$OUT/instrument.txt"; then
  echo "::error::instrumented tests failed"
  exit 1
fi
