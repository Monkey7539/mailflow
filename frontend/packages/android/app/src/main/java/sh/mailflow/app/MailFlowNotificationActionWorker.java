package sh.mailflow.app;

import android.content.Context;
import android.util.Log;
import android.webkit.CookieManager;
import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MailFlowNotificationActionWorker extends Worker {
    private static final String TAG = "MailFlowNotification";
    static final String KEY_ACTION = "action";
    static final String KEY_MESSAGE_ID = "messageId";

    public MailFlowNotificationActionWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        String host = MailFlowNativePlugin.getSavedHost(context);
        String action = getInputData().getString(KEY_ACTION);
        String messageId = getInputData().getString(KEY_MESSAGE_ID);
        if (host == null || host.isEmpty() || action == null || messageId == null || messageId.isEmpty()) {
            return Result.failure();
        }

        String cookie = CookieManager.getInstance().getCookie(host);
        if (cookie == null || cookie.trim().isEmpty()) return Result.failure();

        try {
            int status;
            if (MailFlowNativePlugin.ACTION_DELETE_MESSAGE.equals(action)) {
                status = request(host + "/api/mail/messages/" + messageId, "DELETE", cookie, null);
            } else if (MailFlowNativePlugin.ACTION_STAR_MESSAGE.equals(action)) {
                status = request(host + "/api/mail/messages/" + messageId + "/star", "PATCH", cookie, "{\"starred\":true}");
            } else {
                return Result.failure();
            }

            if (status < 200 || status >= 300) Log.w(TAG, "Notification action " + action + " got HTTP " + status);
            return resultForStatus(status);
        } catch (Exception error) {
            Log.w(TAG, "Notification action " + action + " failed", error);
            return Result.retry();
        }
    }

    // A 4xx is final apart from 408, 409 and 429. A 409 means another delete of this message is
    // still running and may yet fail; once one succeeds the message has a new id and a retry gets
    // 404. A tap made while signed out (401) or locked (423) is dropped, not replayed later.
    static Result resultForStatus(int status) {
        if (status >= 200 && status < 300) return Result.success();
        if (status >= 400 && status < 500 && status != 408 && status != 409 && status != 429) return Result.failure();
        return Result.retry();
    }

    static int request(String url, String method, String cookie, String body) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cookie", cookie);
        // The API's CSRF gate rejects a mutating request without this header.
        connection.setRequestProperty("X-Requested-With", "MailFlow");

        if (body != null) {
            byte[] bytes = body.getBytes("UTF-8");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setFixedLengthStreamingMode(bytes.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(bytes);
            }
        }

        int status = connection.getResponseCode();
        connection.disconnect();
        return status;
    }
}
