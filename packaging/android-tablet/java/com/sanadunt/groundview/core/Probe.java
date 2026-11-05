package com.sanadunt.groundview.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Asks one address whether it is the Ground Console's LAN view. Plain Java, so it runs on the JVM tests too. */
public final class Probe {
    public static final int DEFAULT_PORT = 8788;
    static final int MAX_BODY = 64 * 1024;

    private static final Pattern ACCESS_LAN_VIEW = Pattern.compile("\"access\"\\s*:\\s*\"lan-view\"");
    private static final Pattern VERSION = Pattern.compile("\"version\"\\s*:\\s*\"([0-9A-Za-z.+-]{1,32})\"");

    private Probe() {}

    public static ProbeResult check(String host, int port, int connectMs, int readMs) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL("http://" + authority(host, port) + "/api/capabilities");
            // Never through a proxy: the groundstation is on this LAN.
            connection = (HttpURLConnection) url.openConnection(Proxy.NO_PROXY);
            connection.setConnectTimeout(connectMs);
            connection.setReadTimeout(readMs);
            connection.setInstanceFollowRedirects(false);
            connection.setUseCaches(false);
            connection.setRequestProperty("Accept", "application/json");
            int status = connection.getResponseCode();
            InputStream in = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = in == null ? "" : read(in);
            return classify(host, port, status, body);
        } catch (IOException | RuntimeException e) {
            return new ProbeResult(host, port, ProbeResult.Kind.UNREACHABLE, null, e.getClass().getSimpleName());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    static ProbeResult classify(String host, int port, int status, String body) {
        if (status == 200 && ACCESS_LAN_VIEW.matcher(body).find()) {
            // The console sorts its keys, so the top-level "version" is the last one.
            String version = null;
            Matcher m = VERSION.matcher(body);
            while (m.find()) version = m.group(1);
            return new ProbeResult(host, port, ProbeResult.Kind.CONSOLE, version, null);
        }
        // The LAN view answers a client outside allowed_clients with a bare 403
        // on its accept thread, before reading the request.
        if (status == 403 && body.trim().isEmpty()) {
            return new ProbeResult(host, port, ProbeResult.Kind.NOT_ALLOWED, null, null);
        }
        return new ProbeResult(host, port, ProbeResult.Kind.OTHER, null, "HTTP " + status);
    }

    static String read(InputStream in) throws IOException {
        try (InputStream stream = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int n;
            while ((n = stream.read(buffer)) != -1) {
                if (out.size() + n > MAX_BODY) throw new IOException("answer too large");
                out.write(buffer, 0, n);
            }
            return new String(out.toByteArray(), "UTF-8");
        }
    }

    public static String authority(String host, int port) {
        return (host.indexOf(':') >= 0 ? "[" + host + "]" : host) + ":" + port;
    }

    /**
     * An address the operator typed: "192.168.1.117", "192.168.1.117:8788",
     * "groundstation", "[fe80::1]:8788", optionally with http:// and a trailing slash.
     * Returns {host, port} or null.
     */
    public static String[] parseAddress(String text) {
        if (text == null) return null;
        String s = text.trim();
        if (s.regionMatches(true, 0, "http://", 0, 7)) s = s.substring(7);
        int slash = s.indexOf('/');
        if (slash >= 0) {
            if (!s.substring(slash).matches("/*")) return null;
            s = s.substring(0, slash);
        }
        if (s.isEmpty()) return null;
        String host;
        String portText = null;
        if (s.startsWith("[")) {
            int close = s.indexOf(']');
            if (close < 0) return null;
            host = s.substring(1, close);
            String rest = s.substring(close + 1);
            if (!rest.isEmpty()) {
                if (!rest.startsWith(":")) return null;
                portText = rest.substring(1);
            }
            if (!host.matches("[0-9A-Fa-f:.]+")) return null;
        } else {
            int colon = s.indexOf(':');
            if (colon >= 0) {
                if (s.indexOf(':', colon + 1) >= 0) {
                    host = s; // a bare IPv6 address without a port
                    if (!host.matches("[0-9A-Fa-f:.]+")) return null;
                } else {
                    host = s.substring(0, colon);
                    portText = s.substring(colon + 1);
                }
            } else {
                host = s;
            }
            if (host.indexOf(':') < 0 && !host.matches("[A-Za-z0-9]([A-Za-z0-9.-]{0,252})")) return null;
        }
        int port = DEFAULT_PORT;
        if (portText != null) {
            if (!portText.matches("[0-9]{1,5}")) return null;
            port = Integer.parseInt(portText);
            if (port < 1 || port > 65535) return null;
        }
        return new String[] {host.toLowerCase(java.util.Locale.ROOT), Integer.toString(port)};
    }
}
