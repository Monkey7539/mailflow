#!/usr/bin/env bash
# Round-2 emulator run for the review of maathimself/mailflow#620. Runs the PR's own instrumented
# tests and the reviewer's scenarios, and with MUTATE=1 breaks the wiring once per run to see
# whether the PR's instrumented tests notice. Run from frontend/packages/android inside
# reactivecircus/android-emulator-runner, after assembleDebug and assembleDebugAndroidTest.
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
    grep -E "^Tests run|^There w|AssertionError|Exception:" "$OUT/$name.txt" | head -6
    echo "fail"
  else
    grep -E "^OK \(" "$OUT/$name.txt"
    echo "pass"
  fi
}

adb wait-for-device
adb shell getprop ro.build.version.sdk
adb shell dumpsys webviewupdate | grep -i -E "current webview package" | head -2 || true
adb shell input keyevent 82 || true
adb install -r -t "$APK"
adb install -r -t "$TEST_APK"
adb logcat -c || true

echo "::group::PR instrumented tests"
author=$(run_class author sh.mailflow.app.MailFlowOidcFlowTest | tail -1)
cat "$OUT/author.txt" | grep -E "INSTRUMENTATION_STATUS: test=|INSTRUMENTATION_STATUS_CODE|^OK|^Tests run|AssertionError" | head -40
echo "::endgroup::"
SUMMARY+=("PR's MailFlowOidcFlowTest: $author")

echo "::group::Reviewer scenarios"
ours=$(run_class ours sh.mailflow.app.OidcLoginFlowTest | tail -1)
cat "$OUT/ours.txt" | grep -E "INSTRUMENTATION_STATUS: test=|INSTRUMENTATION_STATUS_CODE|^OK|^Tests run|AssertionError" | head -60
echo "::endgroup::"
SUMMARY+=("Reviewer OidcLoginFlowTest: $ours")

adb logcat -d > "$OUT/logcat.txt" || true
grep "OidcFlow" "$OUT/logcat.txt" | grep -E "RESULT|PROBE|SHOT" > "$OUT/flow.txt" || true
for f in $(adb shell run-as sh.mailflow.app ls files/oidc-shots 2>/dev/null | tr -d '\r'); do
  adb exec-out run-as sh.mailflow.app cat "files/oidc-shots/$f" > "$OUT/shots/$f"
done

if [ "${MUTATE:-0}" = "1" ]; then
  L=app/src/main/java/sh/mailflow/app/MailFlowOidcLogin.java
  C=app/src/main/java/sh/mailflow/app/MailFlowWebViewClient.java
  P=app/src/main/java/sh/mailflow/app/MailFlowNativePlugin.java
  wiring() {
    local name="$1" expect="$2" file="$3" script="$4"
    echo "::group::wiring: $name"
    sed -i "$script" "$file"
    if git diff --quiet -- "$file"; then
      SUMMARY+=("wiring '$name': NOT APPLIED")
      echo "::endgroup::"
      return
    fi
    git diff -- "$file"
    if ./gradlew -q :app:assembleDebug > /tmp/wiring-build.log 2>&1 && adb install -r -t "$APK" > /dev/null; then
      local outcome
      outcome=$(run_class "wiring-$(echo "$name" | tr ' /' '__')" sh.mailflow.app.MailFlowOidcFlowTest | tail -1)
      SUMMARY+=("wiring '$name': PR tests $outcome (expected $expect)")
    else
      tail -20 /tmp/wiring-build.log
      SUMMARY+=("wiring '$name': BUILD FAILED")
    fi
    git checkout -- "$file"
    echo "::endgroup::"
  }
  wiring "app view never opens the login window" fail "$C" '/openOidcLogin(view, url)) return true;/d'
  wiring "login window never hands back" fail "$L" 's#appView.loadUrl(url);#/* removed */#'
  wiring "blocked http redirect does nothing" fail "$L" 's#fail.accept("OIDC requires HTTPS for " + request.getUrl().getHost());#/* removed */#'
  wiring "certificate accepted" fail "$L" 's#handler.cancel();#handler.proceed();#'
  wiring "any certificate error closes the window" fail "$L" 's#if (error.getUrl().equals(mainFrameUrl)) {#if (true) {#'
  wiring "logout window never returns" fail "$L" 's#return "/login".equals(configuredPath(host, url));#return false;#'
  wiring "logout opened in sign-in mode" fail "$P" 's#host, url, true));#host, url, false));#'
  ./gradlew -q :app:assembleDebug > /dev/null 2>&1 && adb install -r -t "$APK" > /dev/null
fi

echo "== Summary"
printf '%s\n' "${SUMMARY[@]}"
echo "== Results and probes"
cut -c1-600 "$OUT/flow.txt"
echo "== Leaked windows"
grep -n -i "leaked window" "$OUT/logcat.txt" || echo "none"
echo "== Crashes"
grep -n "FATAL EXCEPTION" "$OUT/logcat.txt" || echo "none"
ls -la "$OUT/shots"

case "$author $ours" in
  *fail*) echo "::error::instrumented tests failed"; exit 1 ;;
esac
