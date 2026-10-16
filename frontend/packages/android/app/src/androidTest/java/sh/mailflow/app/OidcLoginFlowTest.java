package sh.mailflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.CookieManager;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

// Scratch end-to-end check for the review of maathimself/mailflow#620, not for upstream. It drives
// MainActivity's real WebView and the PR's login view against a fake MailFlow server that also
// plays the identity provider. The app view's user agent is marked, so the server log shows which
// WebView sent each request.
@RunWith(AndroidJUnit4.class)
public class OidcLoginFlowTest {
    private static final String TAG = "OidcFlow";
    private static final String APP_MARK = "MailFlowAppView";
    private static final long WAIT_MS = 30_000;

    private Instrumentation instrumentation;
    private Context context;
    private FakeServer server;
    private String host;
    private ActivityScenario<MainActivity> scenario;

    @BeforeClass
    public static void grantNotifications() {
        if (Build.VERSION.SDK_INT >= 33) {
            Instrumentation inst = InstrumentationRegistry.getInstrumentation();
            inst.getUiAutomation().grantRuntimePermission(
                inst.getTargetContext().getPackageName(), "android.permission.POST_NOTIFICATIONS");
        }
    }

    @Before
    public void setUp() throws Exception {
        instrumentation = InstrumentationRegistry.getInstrumentation();
        context = instrumentation.getTargetContext();
        server = new FakeServer();
        server.start();
        host = "http://127.0.0.1:" + server.port;
        context.getSharedPreferences("mailflow-native", Context.MODE_PRIVATE)
            .edit().putString("host", host).commit();
        CountDownLatch cleared = new CountDownLatch(1);
        instrumentation.runOnMainSync(() ->
            CookieManager.getInstance().removeAllCookies(ignored -> cleared.countDown()));
        cleared.await(10, TimeUnit.SECONDS);
    }

    @After
    public void tearDown() {
        if (scenario != null) scenario.close();
        server.stop();
    }

    // ── Scenarios that should work ──────────────────────────────────────────────

    @Test
    public void a_signedInProviderRedirectsStraightBack() throws Exception {
        launchApp();
        click("redirect");
        Req start = awaitRequest("start", r -> r.path().equals("/auth/oidc/redirect/start"));
        Req authorize = awaitRequest("authorize", r -> r.path().equals("/idp/authorize"));
        Req callback = awaitRequest("callback", r -> r.path().equals("/auth/oidc/redirect/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertFalse("start loaded by the login view: " + start, start.fromApp());
        assertFalse("provider loaded by the login view: " + authorize, authorize.fromApp());
        assertTrue("callback loaded by the app view: " + callback, callback.fromApp());
        assertTrue("callback carries the cookie /start set: " + callback, callback.hasSid(start.setSid));
        assertFalse("app view never left the server", server.any(r -> r.fromApp() && r.path().startsWith("/idp/")));
        assertEquals("one callback request", 1, server.count(r -> r.path().endsWith("/callback")));
        shot("a-done");
        Log.i(TAG, "RESULT a redirect: ok " + server.snapshot());
    }

    @Test
    public void b_userSignsInOnTheProviderPage() throws Exception {
        launchApp();
        click("js");
        Req start = awaitRequest("start", r -> r.path().equals("/auth/oidc/js/start"));
        awaitRequest("provider page", r -> r.path().equals("/idp/authorize"));
        SystemClock.sleep(800);
        boolean dialogUp = !appHasFocus();
        String urlDuring = appUrl();
        shot("b-provider-page");
        Req callback = awaitRequest("callback", r -> r.path().equals("/auth/oidc/js/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertTrue("login dialog was over the app during the provider page", dialogUp);
        assertEquals("app view stayed on its page", host + "/", urlDuring);
        assertTrue("callback loaded by the app view: " + callback, callback.fromApp());
        assertTrue("callback carries the cookie /start set: " + callback, callback.hasSid(start.setSid));
        assertNull("callback came from loadUrl, not from the provider page: " + callback, callback.referer);
        Log.i(TAG, "RESULT b js: ok " + server.snapshot());
    }

    @Test
    public void c_providerFormPostThenRedirect() throws Exception {
        launchApp();
        click("post");
        Req start = awaitRequest("start", r -> r.path().equals("/auth/oidc/post/start"));
        Req post = awaitRequest("provider form post", r -> r.method.equals("POST") && r.path().equals("/idp/login"));
        Req callback = awaitRequest("callback", r -> r.path().equals("/auth/oidc/post/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertFalse("form posted from the login view: " + post, post.fromApp());
        assertTrue("callback loaded by the app view: " + callback, callback.fromApp());
        assertTrue("callback carries the cookie /start set: " + callback, callback.hasSid(start.setSid));
        Log.i(TAG, "RESULT c post: ok " + server.snapshot());
    }

    @Test
    public void d_startErrorReturnsToTheAppLoginPage() throws Exception {
        launchApp();
        click("fail");
        awaitRequest("start", r -> r.path().equals("/auth/oidc/fail/start"));
        String expected = host + "/login?oidc_error=SSO%20provider%20not%20found";
        waitFor("app on the error page", () -> expected.equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        Req login = awaitRequest("error page", r -> r.target.startsWith("/login?oidc_error="));
        assertTrue("error page loaded by the app view: " + login, login.fromApp());
        assertEquals("error page requested once", 1, server.count(r -> r.target.startsWith("/login?oidc_error=")));
        Log.i(TAG, "RESULT d fail: ok " + server.snapshot());
    }

    @Test
    public void f_backClosesTheLoginWindowAndARetryWorks() throws Exception {
        launchApp();
        click("wait");
        awaitRequest("start", r -> r.path().equals("/auth/oidc/wait/start"));
        awaitRequest("provider page", r -> r.path().equals("/idp/authorize"));
        SystemClock.sleep(800);
        assertFalse("login dialog is up", appHasFocus());
        instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
        waitFor("dialog gone after Back", this::appHasFocus);
        assertEquals("app view still on its page", host + "/", appUrl());
        assertFalse("no callback", server.any(r -> r.path().endsWith("/callback")));

        click("redirect");
        Req start = awaitRequest("second start", r -> r.path().equals("/auth/oidc/redirect/start"));
        Req callback = awaitRequest("callback", r -> r.path().equals("/auth/oidc/redirect/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertTrue("callback loaded by the app view: " + callback, callback.fromApp());
        assertTrue("callback carries the second session: " + callback, callback.hasSid(start.setSid));
        Log.i(TAG, "RESULT f back-then-retry: ok " + server.snapshot());
    }

    @Test
    public void l_plainSameOriginLinkStaysInTheApp() throws Exception {
        launchApp();
        click("plain");
        waitFor("app on /login", () -> (host + "/login").equals(appUrl()));
        SystemClock.sleep(500);
        assertTrue("no dialog", appHasFocus());
        Req login = awaitRequest("login page", r -> r.path().equals("/login"));
        assertTrue("loaded by the app view: " + login, login.fromApp());
        Log.i(TAG, "RESULT l plain: ok");
    }

    @Test
    public void h_activityDestroyedWhileTheLoginWindowIsOpen() throws Exception {
        launchApp();
        click("wait");
        awaitRequest("provider page", r -> r.path().equals("/idp/authorize"));
        SystemClock.sleep(800);
        assertFalse("login dialog is up", appHasFocus());
        scenario.close();
        scenario = null;
        SystemClock.sleep(1500);
        Log.i(TAG, "RESULT h destroy-while-open: no crash");
    }

    // ── Round 2: the review's points, now expected to hold ─────────────────────

    @Test
    public void e_insecureProviderClosesTheWindowWithAnError() throws Exception {
        launchApp();
        click("insecure");
        awaitRequest("start", r -> r.path().equals("/auth/oidc/insecure/start"));
        Req error = awaitRequest("error page in the app", r -> r.fromApp() && r.target.startsWith("/login?oidc_error="));
        waitFor("dialog gone", this::appHasFocus);
        assertFalse("provider over http was not loaded",
            server.any(r -> r.hostHeader != null && r.hostHeader.startsWith("127.0.0.2")));
        assertTrue("the error names the refused host: " + error, error.target.contains("127.0.0.2"));
        assertTrue("127.0.0.2 itself is reachable", reachable("http://127.0.0.2:" + server.port + "/probe"));
        Log.i(TAG, "RESULT e insecure: closed with " + error.target);
    }

    @Test
    public void i_pipeInCallbackQueryGoesThrough() throws Exception {
        launchApp();
        click("pipe");
        Req start = awaitRequest("start", r -> r.path().equals("/auth/oidc/pipe/start"));
        Req callback = awaitRequest("callback", r -> r.path().equals("/auth/oidc/pipe/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertTrue("callback loaded by the app view: " + callback, callback.fromApp());
        assertTrue("callback carries the cookie /start set: " + callback, callback.hasSid(start.setSid));
        Log.i(TAG, "RESULT i pipe: ok, callback " + callback.target);
    }

    @Test
    public void j_signOutEndsTheProviderSessionHeldByTheApp() throws Exception {
        launchApp();
        click("session");
        awaitRequest("provider form post", r -> r.method.equals("POST") && r.path().equals("/idp/login"));
        awaitRequest("callback", r -> r.path().equals("/auth/oidc/session/callback"));
        waitFor("app on the success page", () -> (host + "/?oidc_success=login").equals(appUrl())
            && "\"/\"".equals(evalApp("location.pathname")));
        waitFor("dialog gone", this::appHasFocus);

        server.clear();
        String handled = signOutThroughTheApp(host + "/idp/end-session");
        if (!"true".equals(handled)) {
            Log.i(TAG, "PROBE j session: openOidcLogout returned " + handled + ", so signOut.js falls back to the browser");
            return;
        }
        Req endSession = awaitRequest("end-session", r -> r.path().equals("/idp/end-session"));
        waitFor("app on /login", () -> server.any(r -> r.fromApp() && r.target.equals("/login"))
            && "\"/login\"".equals(evalApp("location.pathname")));
        waitFor("dialog gone", this::appHasFocus);
        assertFalse("end-session loaded by the login window: " + endSession, endSession.fromApp());
        assertTrue("end-session carried the provider cookie: " + endSession,
            endSession.cookie != null && endSession.cookie.contains("idp_session=1"));

        SystemClock.sleep(300);
        server.clear();
        click("session");
        awaitRequest("second callback", r -> r.path().equals("/auth/oidc/session/callback"));
        waitFor("app on the success page again", () -> (host + "/?oidc_success=login").equals(appUrl()));
        waitFor("dialog gone", this::appHasFocus);
        assertTrue("provider asked for the password again: " + server.snapshot(),
            server.any(r -> r.method.equals("POST") && r.path().equals("/idp/login")));
        Log.i(TAG, "RESULT j session: provider session ended, second sign-in prompted " + server.snapshot());
    }

    // ── Probes for the maintainer's follow-ups: record what happens ────────────

    @Test
    public void j2_probeProviderThatDoesNotRedirectBack() throws Exception {
        launchApp();
        server.clear();
        String handled = signOutThroughTheApp(host + "/idp/end-session?stay=1");
        if (!"true".equals(handled)) {
            Log.i(TAG, "PROBE j2 no-redirect: openOidcLogout returned " + handled);
            return;
        }
        awaitRequest("end-session", r -> r.path().equals("/idp/end-session"));
        SystemClock.sleep(1500);
        boolean dialogUp = !appHasFocus();
        shot("j2-provider-signed-out-page");
        if (dialogUp) {
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor("dialog gone after Back", this::appHasFocus);
        }
        SystemClock.sleep(1000);
        Log.i(TAG, "PROBE j2 no-redirect: windowStayedOnProviderPage=" + dialogUp + " appUrlAfterBack=" + appUrl());
    }

    @Test
    public void k_probeCustomSchemeRedirect() throws Exception {
        launchApp();
        click("intent");
        awaitRequest("start", r -> r.path().equals("/auth/oidc/intent/start"));
        SystemClock.sleep(1000);
        shot("k-custom-scheme-redirect");
        SystemClock.sleep(2000);
        boolean dialogUp = !appHasFocus();
        String urlDuring = appUrl();
        if (dialogUp) {
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor("dialog gone after Back", this::appHasFocus);
        }
        Log.i(TAG, "PROBE k intent redirect: windowStillOpenAfter3s=" + dialogUp + " appUrlDuring=" + urlDuring
            + " appUrlAfterBack=" + appUrl());
    }

    @Test
    public void g_probeExternalHttpsProvider() throws Exception {
        String base = null;
        for (String candidate : new String[] {"https://httpbin.org", "https://httpbingo.org"}) {
            if (reachable(candidate + "/status/200")) { base = candidate; break; }
        }
        if (base == null) {
            Log.i(TAG, "PROBE g external: SKIPPED, no network");
            return;
        }
        server.externalBase = base;
        launchApp();
        click("external");
        Req start = awaitRequest("start", r -> r.path().equals("/auth/oidc/external/start"));
        long end = SystemClock.uptimeMillis() + 45_000;
        Req callback = null;
        while (callback == null && SystemClock.uptimeMillis() < end) {
            callback = server.first(r -> r.path().equals("/auth/oidc/external/callback"));
            SystemClock.sleep(250);
        }
        SystemClock.sleep(1500);
        boolean dialogUp = !appHasFocus();
        String url = appUrl();
        if (callback == null) shot("g-external-stuck");
        if (dialogUp) {
            instrumentation.sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            waitFor("dialog gone after Back", this::appHasFocus);
        }
        Log.i(TAG, "PROBE g external via " + base + ": callback=" + callback
            + " fromApp=" + (callback != null && callback.fromApp())
            + " cookie=" + (callback != null && callback.hasSid(start.setSid))
            + " dialogUp=" + dialogUp + " appUrl=" + url + " requests=" + server.snapshot());
    }

    // What signOut.js does on Android when the server returns an end-session URL.
    private String signOutThroughTheApp(String endSessionUrl) throws Exception {
        waitFor("the injected native bridge", () ->
            "true".equals(evalApp("typeof (window.mailflowNative||{}).openOidcLogout === 'function'")));
        evalApp("window.__logout=null; window.mailflowNative.openOidcLogout('" + endSessionUrl + "')"
            + ".then(function(r){window.__logout=String(!!(r&&r.handled));},function(e){window.__logout='error '+e;}); true");
        AtomicReference<String> result = new AtomicReference<>();
        waitFor("openOidcLogout result", () -> {
            String value = evalApp("window.__logout");
            if (value == null || "null".equals(value)) return false;
            result.set(value.replace("\"", ""));
            return true;
        });
        return result.get();
    }

    // ── Helpers ─────────────────────────────────────────────────────────────────

    interface Check {
        boolean ok() throws Exception;
    }

    private void launchApp() throws Exception {
        scenario = ActivityScenario.launch(MainActivity.class);
        waitFor("the fake app page", () -> (host + "/").equals(appUrl()) && pageHas("redirect"));
        onApp(a -> {
            WebView view = a.getBridge().getWebView();
            view.getSettings().setUserAgentString(view.getSettings().getUserAgentString() + " " + APP_MARK);
        });
        waitFor("app focus", this::appHasFocus);
        server.clear();
    }

    private void onApp(ActivityScenario.ActivityAction<MainActivity> action) {
        scenario.onActivity(action);
    }

    private String appUrl() {
        AtomicReference<String> url = new AtomicReference<>();
        onApp(a -> url.set(a.getBridge().getWebView().getUrl()));
        return url.get();
    }

    private boolean appHasFocus() {
        AtomicBoolean focus = new AtomicBoolean();
        onApp(a -> focus.set(a.hasWindowFocus()));
        return focus.get();
    }

    private String evalApp(String js) throws InterruptedException {
        AtomicReference<String> out = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        onApp(a -> a.getBridge().getWebView().evaluateJavascript(js, value -> {
            out.set(value);
            done.countDown();
        }));
        done.await(5, TimeUnit.SECONDS);
        return out.get();
    }

    private boolean pageHas(String id) throws InterruptedException {
        return "true".equals(evalApp("!!document.getElementById('" + id + "')"));
    }

    private void click(String id) throws Exception {
        String clicked = evalApp("(function(){var a=document.getElementById('" + id + "');"
            + "if(!a)return false;a.click();return true;})()");
        assertEquals("clicked #" + id, "true", clicked);
    }

    private void waitFor(String what, Check check) throws Exception {
        long end = SystemClock.uptimeMillis() + WAIT_MS;
        while (SystemClock.uptimeMillis() < end) {
            if (check.ok()) return;
            SystemClock.sleep(200);
        }
        String url;
        try {
            url = appUrl();
        } catch (Throwable t) {
            url = "(no activity)";
        }
        fail("timed out waiting for " + what + "; app url " + url + "; requests " + server.snapshot());
    }

    private Req awaitRequest(String what, Predicate<Req> match) throws Exception {
        AtomicReference<Req> found = new AtomicReference<>();
        waitFor(what, () -> {
            Req r = server.first(match);
            found.set(r);
            return r != null;
        });
        return found.get();
    }

    private boolean reachable(String url) {
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            int code = connection.getResponseCode();
            connection.disconnect();
            return code == 200;
        } catch (IOException e) {
            Log.w(TAG, "unreachable " + url + ": " + e);
            return false;
        }
    }

    private void shot(String name) {
        try {
            Bitmap bitmap = instrumentation.getUiAutomation().takeScreenshot();
            if (bitmap == null) {
                Log.w(TAG, "no screenshot " + name);
                return;
            }
            File dir = new File(context.getFilesDir(), "oidc-shots");
            dir.mkdirs();
            try (FileOutputStream out = new FileOutputStream(new File(dir, name + ".png"))) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            }
            Log.i(TAG, "SHOT " + name);
        } catch (Exception e) {
            Log.w(TAG, "screenshot failed " + name, e);
        }
    }

    // ── Fake MailFlow server and identity provider ──────────────────────────────

    static final class Req {
        final String method;
        final String target;
        final String hostHeader;
        final String cookie;
        final String referer;
        final String userAgent;
        volatile String setSid;

        Req(String method, String target, String hostHeader, String cookie, String referer, String userAgent) {
            this.method = method;
            this.target = target;
            this.hostHeader = hostHeader;
            this.cookie = cookie;
            this.referer = referer;
            this.userAgent = userAgent;
        }

        String path() {
            int q = target.indexOf('?');
            return q < 0 ? target : target.substring(0, q);
        }

        boolean fromApp() {
            return userAgent != null && userAgent.contains(APP_MARK);
        }

        boolean hasSid(String sid) {
            return sid != null && cookie != null && (" " + cookie + ";").contains(" sid=" + sid + ";");
        }

        @Override
        public String toString() {
            return "[" + method + " " + target + " host=" + hostHeader + " cookie=" + cookie
                + " referer=" + referer + " view=" + (fromApp() ? "app" : "login") + "]";
        }
    }

    static final class FakeServer {
        private final List<Req> log = new ArrayList<>();
        private final ExecutorService pool = Executors.newCachedThreadPool();
        private final AtomicInteger sessions = new AtomicInteger();
        private ServerSocket socket;
        private volatile boolean running = true;
        volatile String externalBase;
        int port;

        void start() throws IOException {
            socket = new ServerSocket(0);
            port = socket.getLocalPort();
            pool.execute(() -> {
                while (running) {
                    try {
                        Socket client = socket.accept();
                        pool.execute(() -> handle(client));
                    } catch (IOException e) {
                        if (!running) return;
                    }
                }
            });
        }

        void stop() {
            running = false;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
            pool.shutdownNow();
        }

        void clear() {
            synchronized (log) {
                log.clear();
            }
        }

        List<Req> snapshot() {
            synchronized (log) {
                return new ArrayList<>(log);
            }
        }

        Req first(Predicate<Req> match) {
            for (Req r : snapshot()) if (match.test(r)) return r;
            return null;
        }

        boolean any(Predicate<Req> match) {
            return first(match) != null;
        }

        int count(Predicate<Req> match) {
            int n = 0;
            for (Req r : snapshot()) if (match.test(r)) n++;
            return n;
        }

        private void handle(Socket client) {
            try (Socket s = client) {
                s.setSoTimeout(15000);
                InputStream in = new BufferedInputStream(s.getInputStream());
                String requestLine = readLine(in);
                if (requestLine == null || requestLine.isEmpty()) return;
                Map<String, String> headers = new HashMap<>();
                for (String line = readLine(in); line != null && !line.isEmpty(); line = readLine(in)) {
                    int colon = line.indexOf(':');
                    if (colon > 0) {
                        headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
                    }
                }
                String[] parts = requestLine.split(" ");
                int length = headers.containsKey("content-length") ? Integer.parseInt(headers.get("content-length")) : 0;
                for (int i = 0; i < length && in.read() >= 0; i++) {
                    // discard the body
                }
                Req r = new Req(parts[0], parts.length > 1 ? parts[1] : "/", headers.get("host"),
                    headers.get("cookie"), headers.get("referer"), headers.get("user-agent"));
                respond(s.getOutputStream(), r);
                synchronized (log) {
                    log.add(r);
                }
                Log.i(TAG, "server " + r);
            } catch (Exception e) {
                Log.w(TAG, "server error: " + e);
            }
        }

        private static String readLine(InputStream in) throws IOException {
            StringBuilder sb = new StringBuilder();
            int b;
            while ((b = in.read()) >= 0 && b != '\n') {
                if (b != '\r') sb.append((char) b);
            }
            if (b < 0 && sb.length() == 0) return null;
            return sb.toString();
        }

        private void respond(OutputStream out, Req r) throws IOException {
            String path = r.path();
            Map<String, String> q = query(r.target);
            String self = "http://127.0.0.1:" + port;
            if (path.equals("/") || path.equals("/login")) {
                send(out, 200, appPage(), null, null);
            } else if (path.equals("/probe")) {
                send(out, 200, "ok", null, null);
            } else if (path.startsWith("/auth/oidc/") && path.endsWith("/start")) {
                String slug = path.substring("/auth/oidc/".length(), path.length() - "/start".length());
                String sid = "S" + sessions.incrementAndGet();
                r.setSid = sid;
                String cookie = "sid=" + sid + "; Path=/; HttpOnly; SameSite=Lax";
                String callback = self + "/auth/oidc/" + slug + "/callback?code=C&state=ST";
                String location;
                if (slug.equals("fail")) {
                    location = "/login?oidc_error=SSO%20provider%20not%20found";
                } else if (slug.equals("insecure")) {
                    location = "http://127.0.0.2:" + port + "/idp/authorize?mode=redirect&slug=insecure";
                } else if (slug.equals("external")) {
                    location = externalBase + "/redirect-to?status_code=302&url=" + URLEncoder.encode(callback, "UTF-8");
                } else if (slug.equals("intent")) {
                    location = "intent://scan/#Intent;scheme=zxing;end";
                } else {
                    location = "/idp/authorize?mode=" + slug + "&slug=" + slug + "&state=ST";
                }
                send(out, 302, null, location, cookie);
            } else if (path.equals("/idp/authorize")) {
                String mode = String.valueOf(q.get("mode"));
                String slug = q.get("slug");
                String cb = "/auth/oidc/" + slug + "/callback?code=C&state=ST";
                boolean idpSession = r.cookie != null && r.cookie.contains("idp_session=1");
                if (mode.equals("redirect") || (mode.equals("session") && idpSession)) {
                    send(out, 302, null, cb, null);
                } else if (mode.equals("pipe")) {
                    send(out, 302, null, "/auth/oidc/pipe/callback?code=a|b&state=ST", null);
                } else if (mode.equals("js")) {
                    send(out, 200, page("Fake provider: signing in",
                        "<script>setTimeout(function(){location.href='" + cb + "';},2000);</script>"), null, null);
                } else if (mode.equals("post") || mode.equals("session")) {
                    send(out, 200, page("Fake provider: sign-in form",
                        "<form id=f method=post action='/idp/login?slug=" + slug + "'><input name=u value=me></form>"
                            + "<script>setTimeout(function(){document.getElementById('f').submit();},1000);</script>"), null, null);
                } else {
                    send(out, 200, page("Fake provider: waiting", ""), null, null);
                }
            } else if (path.equals("/idp/end-session")) {
                String cleared = "idp_session=; Path=/idp; Max-Age=0";
                if ("1".equals(q.get("stay"))) {
                    send(out, 200, page("Fake provider: signed out", ""), null, cleared);
                } else {
                    send(out, 302, null, "/login", cleared);
                }
            } else if (path.equals("/idp/login")) {
                String slug = q.get("slug");
                String cookie = "session".equals(slug) ? "idp_session=1; Path=/idp; Max-Age=3600; HttpOnly" : null;
                send(out, 302, null, "/auth/oidc/" + slug + "/callback?code=C&state=ST", cookie);
            } else if (path.startsWith("/auth/oidc/") && path.endsWith("/callback")) {
                boolean ok = r.cookie != null && (" " + r.cookie).matches(".* sid=S\\d+.*");
                send(out, 302, null, ok ? "/?oidc_success=login" : "/login?oidc_error=SSO%20session%20expired", null);
            } else {
                send(out, 404, "not found", null, null);
            }
        }

        private static Map<String, String> query(String target) {
            Map<String, String> map = new HashMap<>();
            int i = target.indexOf('?');
            if (i < 0) return map;
            for (String pair : target.substring(i + 1).split("&")) {
                int eq = pair.indexOf('=');
                if (eq > 0) map.put(pair.substring(0, eq), pair.substring(eq + 1));
            }
            return map;
        }

        private static String appPage() {
            StringBuilder links = new StringBuilder();
            for (String slug : new String[] {"redirect", "js", "post", "fail", "insecure", "wait", "external", "pipe", "session", "intent"}) {
                links.append("<p><a id='").append(slug).append("' href='/auth/oidc/").append(slug)
                    .append("/start'>Sign in with ").append(slug).append("</a></p>");
            }
            links.append("<p><a id='plain' href='/login'>Plain link</a></p>");
            return page("Fake MailFlow", links.toString());
        }

        private static String page(String title, String body) {
            return "<!doctype html><html><head><meta name=viewport content='width=device-width'><title>" + title
                + "</title></head><body style='font:20px sans-serif'><h1>" + title + "</h1>" + body + "</body></html>";
        }

        private static void send(OutputStream out, int status, String body, String location, String cookie) throws IOException {
            byte[] bytes = body == null ? new byte[0] : body.getBytes(StandardCharsets.UTF_8);
            String reason = status == 302 ? "Found" : status == 200 ? "OK" : "Not Found";
            StringBuilder head = new StringBuilder("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
            if (body != null) head.append("Content-Type: text/html; charset=utf-8\r\n");
            if (location != null) head.append("Location: ").append(location).append("\r\n");
            if (cookie != null) head.append("Set-Cookie: ").append(cookie).append("\r\n");
            head.append("Cache-Control: no-store\r\nContent-Length: ").append(bytes.length).append("\r\nConnection: close\r\n\r\n");
            out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
            out.write(bytes);
            out.flush();
        }
    }
}
