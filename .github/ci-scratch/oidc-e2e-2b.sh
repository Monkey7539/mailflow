#!/usr/bin/env bash
# Round-2b emulator run for the review of maathimself/mailflow#620. In this scratch branch the PR's
# test server ignores dropped connections (IOException) instead of rethrowing them, which crashed
# the process on API 34 and 36. Runs the PR's instrumented tests three times, the reviewer's sign-out
# scenario, and on API 34 the "certificate accepted" break twice. Run from frontend/packages/android.
set -u
APK=app/build/outputs/apk/debug/app-debug.apk
TEST_APK=app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
OUT="${GITHUB_WORKSPACE}/e2e-out"
mkdir -p "$OUT/shots"
SUMMARY=()

run_class() {
  local name="$1" class="$2"
  adb shell am instrument -w -r -e class "$class" \
    sh.mailflow.app.test/androidx.test.runner.AndroidJUnitRunner > "$OUT/$name.txt" 2>&1
  if grep -q "FAILURES!!!" "$OUT/$name.txt" || ! grep -q "^OK (" "$OUT/$name.txt"; then
    echo "fail: $(grep -E "^[0-9]+\) |AssertionError|Exception:|Process crashed" "$OUT/$name.txt" | head -3 | tr '\n' ' ' | cut -c1-400)"
  else
    echo "pass: $(grep -E "^OK \(" "$OUT/$name.txt")"
  fi
}

adb wait-for-device
adb shell getprop ro.build.version.sdk
adb shell input keyevent 82 || true
adb install -r -t "$APK"
adb install -r -t "$TEST_APK"
adb logcat -c || true

for i in 1 2 3; do
  SUMMARY+=("PR's MailFlowOidcFlowTest, run $i: $(run_class "author-$i" sh.mailflow.app.MailFlowOidcFlowTest)")
done
SUMMARY+=("Reviewer sign-out scenario: $(run_class ours-j 'sh.mailflow.app.OidcLoginFlowTest#j_signOutEndsTheProviderSessionHeldByTheApp')")

if [ "${MUTATE:-0}" = "1" ]; then
  L=app/src/main/java/sh/mailflow/app/MailFlowOidcLogin.java
  sed -i 's#handler.cancel();#handler.proceed();#' "$L"
  git diff -- "$L"
  if ./gradlew -q :app:assembleDebug > /tmp/wiring-build.log 2>&1 && adb install -r -t "$APK" > /dev/null; then
    for i in 1 2; do
      SUMMARY+=("certificate accepted, run $i: $(run_class "cert-accepted-$i" 'sh.mailflow.app.MailFlowOidcFlowTest#certificateErrorsOnlyCloseTheWindowForMainPageLoads')")
    done
  else
    tail -20 /tmp/wiring-build.log
    SUMMARY+=("certificate accepted: BUILD FAILED")
  fi
  git checkout -- "$L"
fi

adb logcat -d > "$OUT/logcat.txt" || true
grep "OidcFlow" "$OUT/logcat.txt" | grep -E "RESULT|PROBE|SHOT" > "$OUT/flow.txt" || true

echo "== Summary"
printf '%s\n' "${SUMMARY[@]}"
echo "== Results and probes"
cut -c1-700 "$OUT/flow.txt"
echo "== Crashes"
grep -n "FATAL EXCEPTION" "$OUT/logcat.txt" || echo "none"
