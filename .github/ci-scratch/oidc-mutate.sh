#!/usr/bin/env bash
# Scratch mutations for the review of maathimself/mailflow#620: each one breaks one part of the
# change and records whether the PR's unit tests notice. Run from frontend/packages/android.
set -u
L=app/src/main/java/sh/mailflow/app/MailFlowOidcLogin.java
C=app/src/main/java/sh/mailflow/app/MailFlowWebViewClient.java
RESULTS=()

mutate() {
  local name="$1" expect="$2" file="$3" script="$4"
  echo "::group::$name"
  sed -i "$script" "$file"
  if git diff --quiet -- "$file"; then
    echo "::error::mutation '$name' did not apply"
    RESULTS+=("$name: NOT APPLIED")
    echo "::endgroup::"
    return
  fi
  git diff -- "$file"
  local outcome
  if ./gradlew --no-daemon -q :app:testDebugUnitTest --tests sh.mailflow.app.MailFlowOidcLoginTest > /tmp/mutation.log 2>&1; then
    outcome=pass
  else
    outcome=fail
    grep -h -o -E 'testcase name="[^"]+"|AssertionError[^<&]{0,160}' app/build/test-results/testDebugUnitTest/*.xml | head -8 || true
    grep -E 'error:|FAILED' /tmp/mutation.log | head -8 || true
  fi
  RESULTS+=("$name: tests $outcome (expected $expect)")
  git checkout -- "$file"
  echo "::endgroup::"
}

mutate "isAllowedUrl accepts any URL" fail "$L" \
  's#return NativeSecurity.isSameOrigin(host, url) || NativeSecurity.isHttpsUrl(url);#return true;#'
mutate "/login is not a return path" fail "$L" \
  's#("/".equals(path) || "/login".equals(path))#"/".equals(path)#'
mutate "isStartUrl skips the same-origin check" fail "$L" \
  '0,/isSameOrigin(host, url)) return false;/{/isSameOrigin(host, url)) return false;/d}'
mutate "callback path matched as a prefix" fail "$L" \
  's#"/auth/oidc/\[^/]+/callback"#"/auth/oidc/[^/]+/callback.*"#'
mutate "start path allows extra segments" fail "$L" \
  's#"/auth/oidc/\[^/]+/start"#"/auth/oidc/.+/start"#'
mutate "app view never opens the login view" pass "$C" \
  '/openOidcLogin(view, url)) return true;/d'
mutate "login view returns on sub-frame navigations too" pass "$L" \
  's#if (!request.isForMainFrame() || !isReturnUrl(host, url)) return false;#if (!isReturnUrl(host, url)) return false;#'
mutate "login view never returns to the app" pass "$L" \
  's#appView.loadUrl(url);#/* removed */#'

echo "== Mutation results"
printf '%s\n' "${RESULTS[@]}"
for r in "${RESULTS[@]}"; do
  case "$r" in
    *"NOT APPLIED"*) exit 1 ;;
    *"tests pass (expected fail)"*|*"tests fail (expected pass)"*) echo "::warning::unexpected: $r" ;;
  esac
done
