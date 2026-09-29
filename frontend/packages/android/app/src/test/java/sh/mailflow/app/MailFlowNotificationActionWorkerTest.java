package sh.mailflow.app;

import static org.junit.Assert.assertEquals;

import androidx.work.ListenableWorker;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class MailFlowNotificationActionWorkerTest {
    @Test
    public void onlyTransientFailuresAreRetried() {
        assertEquals(ListenableWorker.Result.success(), MailFlowNotificationActionWorker.resultForStatus(200));
        for (int status : new int[] { 400, 401, 403, 404, 422, 423 }) {
            assertEquals("HTTP " + status, ListenableWorker.Result.failure(), MailFlowNotificationActionWorker.resultForStatus(status));
        }
        for (int status : new int[] { 408, 409, 429, 500, 503 }) {
            assertEquals("HTTP " + status, ListenableWorker.Result.retry(), MailFlowNotificationActionWorker.resultForStatus(status));
        }
    }

    @Test
    public void deletePassesTheApiCsrfGate() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) {
            server.setSoTimeout(15000);
            Thread api = new Thread(() -> answerLikeCsrfGate(server));
            api.setDaemon(true);
            api.start();

            // Only Delete runs here: the JVM's HttpURLConnection refuses PATCH, Android's does not.
            int status = MailFlowNotificationActionWorker.request(
                "http://127.0.0.1:" + server.getLocalPort() + "/api/mail/messages/m1",
                "DELETE",
                "connect.sid=s%3Aabc",
                null
            );

            assertEquals(200, status);
        }
    }

    // Stands in for the CSRF gate in backend/src/index.js for one request: a mutating request
    // whose X-Requested-With is missing or empty gets 403.
    private static void answerLikeCsrfGate(ServerSocket server) {
        try (Socket socket = server.accept()) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
            boolean hasCsrfHeader = false;
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0
                    && line.substring(0, colon).trim().equalsIgnoreCase("X-Requested-With")
                    && !line.substring(colon + 1).trim().isEmpty()) {
                    hasCsrfHeader = true;
                }
            }

            String response = (hasCsrfHeader ? "HTTP/1.1 200 OK" : "HTTP/1.1 403 Forbidden")
                + "\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
            OutputStream output = socket.getOutputStream();
            output.write(response.getBytes(StandardCharsets.ISO_8859_1));
            output.flush();
        } catch (IOException ignored) {}
    }
}
