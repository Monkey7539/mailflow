package sh.mailflow.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

// Scratch probes for the review of maathimself/mailflow#620, not for upstream.
public class OidcLoginProbeTest {
    private static final String HOST = "https://mail.example.com";

    private static void show(String label, String url) {
        System.out.println("PROBE " + label
            + " start=" + MailFlowOidcLogin.isStartUrl(HOST, url)
            + " return=" + MailFlowOidcLogin.isReturnUrl(HOST, url)
            + " allowed=" + MailFlowOidcLogin.isAllowedUrl(HOST, url)
            + " url=" + url);
    }

    @Test
    public void probes() {
        show("idp-plain", "https://idp.example.com/authorize?client_id=x&state=y");
        show("idp-pipe", "https://idp.example.com/authorize?x=a|b");
        show("idp-brace", "https://idp.example.com/authorize?claims={%22id_token%22:{}}");
        show("idp-bracket", "https://idp.example.com/authorize?scope[]=openid");
        show("idp-caret", "https://idp.example.com/authorize?x=a^b");
        show("idp-backtick", "https://idp.example.com/authorize?x=a`b");
        show("idp-percent", "https://idp.example.com/authorize?x=100%");
        show("idp-backslash", "https://idp.example.com/authorize?x=a\\b");
        show("cb-plain", HOST + "/auth/oidc/sso/callback?code=a&state=s&iss=https%3A%2F%2Fidp.example.com");
        show("cb-pipe", HOST + "/auth/oidc/sso/callback?code=a|b&state=s");
        show("cb-brace", HOST + "/auth/oidc/sso/callback?code=a&state=s&x={}");
        show("err-pipe", HOST + "/login?oidc_error=a|b");
        show("start-link", HOST + "/auth/oidc/sso/start?action=link");
        show("start-trailing-slash", HOST + "/auth/oidc/sso/start/");
        show("start-upper", HOST + "/AUTH/OIDC/sso/START");
        show("start-encoded-slash", HOST + "/auth/oidc/a%2Fb/start");
        show("start-userinfo", "https://user@mail.example.com/auth/oidc/sso/start");
        show("cb-userinfo-attacker", "https://mail.example.com@attacker.test/auth/oidc/sso/callback?code=a&state=s");
        show("about-blank", "about:blank");
        show("data", "data:text/html,hi");
        show("blob", "blob:https://idp.example.com/uuid");
        show("http-lan-idp", "http://192.168.1.20:9000/application/o/authorize/");
        show("https-ip-idp", "https://192.168.1.20:9443/application/o/authorize/");
        show("intent", "intent://scan/#Intent;scheme=zxing;end");
        show("msauth", "msauth://com.example/abc");
    }

    // java.net.URI rejects characters that Chromium leaves raw in a query, so these URLs are blocked.
    @Test
    public void javaUriRejectsCharactersChromiumLeavesInQueries() {
        assertFalse(MailFlowOidcLogin.isAllowedUrl(HOST, "https://idp.example.com/authorize?x=a|b"));
        assertFalse(MailFlowOidcLogin.isAllowedUrl(HOST, HOST + "/auth/oidc/sso/callback?code=a|b&state=s"));
        assertFalse(MailFlowOidcLogin.isReturnUrl(HOST, HOST + "/auth/oidc/sso/callback?code=a|b&state=s"));
        assertTrue(MailFlowOidcLogin.isAllowedUrl(HOST, "https://idp.example.com/authorize?x=a%7Cb"));
    }
}
