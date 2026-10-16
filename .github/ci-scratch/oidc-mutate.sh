#!/usr/bin/env bash
# Round-2 Android unit mutations for the review of maathimself/mailflow#620: each one breaks one
# part of the URL rules and records whether MailFlowOidcLoginTest notices. Run from frontend/packages/android.
set -u
L=app/src/main/java/sh/mailflow/app/MailFlowOidcLogin.java
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
    grep -h -o -E 'AssertionError[^<&]{0,160}' app/build/test-results/testDebugUnitTest/*.xml | head -4 || true
    grep -E 'error:' /tmp/mutation.log | head -4 || true
  fi
  RESULTS+=("$name: tests $outcome (expected $expect)")
  git checkout -- "$file"
  echo "::endgroup::"
}

mutate "isAllowedUrl accepts any URL" fail "$L" \
  's#return NativeSecurity.isSameOrigin(host, navigationUrl(url)) || NativeSecurity.isHttpsUrl(navigationUrl(url));#return true;#'
mutate "/login is not a return path" fail "$L" \
  's#if (!"/".equals(path) && !"/login".equals(path)) return false;#if (!"/".equals(path)) return false;#'
mutate "configuredPath skips the same-origin check" fail "$L" \
  '/if (!NativeSecurity.isSameOrigin(host, navigation)) return "";/d'
mutate "query not stripped before java.net.URI" fail "$L" \
  's|url.split("\[?#]", 2)\[0];|url;|'
mutate "logout returns on any configured page" fail "$L" \
  's#return "/login".equals(configuredPath(host, url));#return !configuredPath(host, url).isEmpty();#'
mutate "start path allows extra segments" fail "$L" \
  's#matches("/auth/oidc/\[^/]+/start")#matches("/auth/oidc/.+/start")#'
mutate "fragment read as the query" fail "$L" \
  's|url.split("#", 2)\[0].split("\\\\?", 2)|url.split("\\\\?", 2)|'

echo "== Mutation results"
printf '%s\n' "${RESULTS[@]}"
for r in "${RESULTS[@]}"; do
  case "$r" in
    *"NOT APPLIED"*) exit 1 ;;
    *"tests pass (expected fail)"*) echo "::warning::unexpected: $r" ;;
  esac
done
