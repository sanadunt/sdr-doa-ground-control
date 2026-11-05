package com.sanadunt.groundview.core;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

/** Plain-JVM checks of the discovery code; build.sh runs them before it packages the APK. */
public final class CoreTest {
    private static int passed;

    public static void main(String[] args) throws Exception {
        parseAddress();
        classify();
        hostsToScan();
        mdnsQuery();
        mdnsAnswers();
        probeOverHttp();
        System.out.println("CoreTest: " + passed + " checks passed");
    }

    static void check(boolean ok, String what) {
        if (!ok) throw new AssertionError(what);
        passed++;
    }

    static void eq(Object expected, Object actual, String what) {
        check(expected == null ? actual == null : expected.equals(actual), what + ": expected " + expected + ", got " + actual);
    }

    static void parseAddress() {
        eq(Arrays.asList("192.168.1.117", "8788"), list(Probe.parseAddress("192.168.1.117")), "bare IP");
        eq(Arrays.asList("192.168.1.117", "9000"), list(Probe.parseAddress(" 192.168.1.117:9000 ")), "IP and port");
        eq(Arrays.asList("192.168.1.117", "8788"), list(Probe.parseAddress("http://192.168.1.117:8788/")), "URL");
        eq(Arrays.asList("groundstation", "8788"), list(Probe.parseAddress("Groundstation")), "name");
        eq(Arrays.asList("fe80::1", "8788"), list(Probe.parseAddress("[fe80::1]:8788")), "IPv6 with port");
        eq(Arrays.asList("fe80::1", "8788"), list(Probe.parseAddress("fe80::1")), "bare IPv6");
        check(Probe.parseAddress("") == null, "empty");
        check(Probe.parseAddress("192.168.1.117:0") == null, "port 0");
        check(Probe.parseAddress("192.168.1.117:70000") == null, "port too big");
        check(Probe.parseAddress("192.168.1.117/api") == null, "path");
        check(Probe.parseAddress("a b") == null, "space");
        check(Probe.parseAddress("user@host") == null, "userinfo");
        eq("[fe80::1]:8788", Probe.authority("fe80::1", 8788), "IPv6 authority");
    }

    static List<String> list(String[] a) {
        return a == null ? null : Arrays.asList(a);
    }

    static void classify() {
        String lan = "{\"access\": \"lan-view\", \"config_patch\": {\"version\": \"9\"}, \"lan_access\": {}, \"version\": \"3.13.5\"}";
        ProbeResult r = Probe.classify("10.0.0.2", 8788, 200, lan);
        eq(ProbeResult.Kind.CONSOLE, r.kind, "LAN view");
        eq("3.13.5", r.version, "top-level version");
        eq(ProbeResult.Kind.OTHER, Probe.classify("h", 1, 200, "{\"access\": \"local\"}").kind, "loopback listener");
        eq(ProbeResult.Kind.NOT_ALLOWED, Probe.classify("h", 1, 403, "").kind, "bare 403");
        eq(ProbeResult.Kind.OTHER, Probe.classify("h", 1, 403, "{\"code\": \"ORIGIN_REJECTED\"}").kind, "403 with a body");
        eq(ProbeResult.Kind.OTHER, Probe.classify("h", 1, 404, "").kind, "404");
    }

    static void hostsToScan() throws Exception {
        Inet4Address a = (Inet4Address) InetAddress.getByName("192.168.1.54");
        List<String> c = Discovery.hostsToScan(a, 24);
        eq(254, c.size(), "/24 size");
        eq("192.168.1.1", c.get(0), "/24 first");
        eq("192.168.1.254", c.get(253), "/24 last");
        eq(254, Discovery.hostsToScan(a, 16).size(), "wide subnet scanned as /24");
        eq("192.168.1.1", Discovery.hostsToScan(a, 16).get(0), "wide subnet around the address");
        eq(1022, Discovery.hostsToScan(a, 22).size(), "/22 size");
        eq("192.168.0.1", Discovery.hostsToScan(a, 22).get(0), "/22 first");
        eq(2, Discovery.hostsToScan(a, 30).size(), "/30");
        eq(0, Discovery.hostsToScan(a, 31).size(), "/31");
    }

    static void mdnsQuery() {
        byte[] q = Mdns.buildQuery(0x1234, "groundstation.local");
        byte[] expected = concat(
                new byte[] {0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0},
                new byte[] {13}, ascii("groundstation"), new byte[] {5}, ascii("local"), new byte[] {0},
                new byte[] {0, 1, (byte) 0x80, 1});
        check(Arrays.equals(expected, q), "query bytes");
    }

    static void mdnsAnswers() {
        String name = "groundstation.local";
        // Question, then an answer whose name points back at the question.
        byte[] question = concat(Mdns.encodeName(name), new byte[] {0, 1, 0, 1});
        byte[] answer = concat(new byte[] {(byte) 0xc0, 12}, new byte[] {0, 1, (byte) 0x80, 1, 0, 0, 0, 120, 0, 4, (byte) 192, (byte) 168, 1, 117});
        byte[] good = concat(header(0x1234, 0x8400, 1, 1), question, answer);
        eq(Arrays.asList("192.168.1.117"), hosts(Mdns.parseAnswer(good, 0x1234, name)), "compressed answer");
        eq(Arrays.asList("192.168.1.117"), hosts(Mdns.parseAnswer(good, 0x1234, "GroundStation.local.")), "case and trailing dot");
        check(Mdns.parseAnswer(good, 0x4321, name).isEmpty(), "another query id");
        check(Mdns.parseAnswer(good, 0x1234, "other.local").isEmpty(), "another name");

        byte[] query = concat(header(0x1234, 0x0000, 1, 1), question, answer);
        check(Mdns.parseAnswer(query, 0x1234, name).isEmpty(), "a query, not a response");

        byte[] ttl0 = concat(header(0x1234, 0x8400, 1, 1), question,
                concat(new byte[] {(byte) 0xc0, 12}, new byte[] {0, 1, 0, 1, 0, 0, 0, 0, 0, 4, (byte) 192, (byte) 168, 1, 117}));
        check(Mdns.parseAnswer(ttl0, 0x1234, name).isEmpty(), "TTL 0");

        byte[] loopback = concat(header(0x1234, 0x8400, 1, 1), question,
                concat(new byte[] {(byte) 0xc0, 12}, new byte[] {0, 1, 0, 1, 0, 0, 0, 9, 0, 4, 127, 0, 0, 1}));
        check(Mdns.parseAnswer(loopback, 0x1234, name).isEmpty(), "loopback address");

        // A pointer to itself or forward is refused without hanging.
        byte[] loop = concat(header(0x1234, 0x8400, 0, 1), new byte[] {(byte) 0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 9, 0, 4, 10, 0, 0, 1});
        check(Mdns.parseAnswer(loop, 0x1234, name).isEmpty(), "pointer loop");
        byte[] forward = concat(header(0x1234, 0x8400, 0, 1), new byte[] {(byte) 0xc0, 40, 0, 1, 0, 1, 0, 0, 0, 9, 0, 4, 10, 0, 0, 1});
        check(Mdns.parseAnswer(forward, 0x1234, name).isEmpty(), "forward pointer");

        // A cut packet keeps nothing and throws nothing.
        for (int n = 0; n < good.length; n++) {
            Mdns.parseAnswer(Arrays.copyOf(good, n), 0x1234, name);
        }
        passed++;
    }

    static void probeOverHttp() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/capabilities", exchange -> {
            byte[] body = "{\"access\": \"lan-view\", \"version\": \"3.13.5\"}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();
        HttpServer refused = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        refused.createContext("/", exchange -> {
            exchange.sendResponseHeaders(403, -1);
            exchange.close();
        });
        refused.start();
        try {
            ProbeResult ok = Probe.check("127.0.0.1", server.getAddress().getPort(), 1000, 2000);
            eq(ProbeResult.Kind.CONSOLE, ok.kind, "console over HTTP");
            eq("3.13.5", ok.version, "version over HTTP");
            eq(ProbeResult.Kind.NOT_ALLOWED, Probe.check("127.0.0.1", refused.getAddress().getPort(), 1000, 2000).kind, "bare 403 over HTTP");
        } finally {
            server.stop(0);
            refused.stop(0);
        }
        // Nothing listens on port 1.
        eq(ProbeResult.Kind.UNREACHABLE, Probe.check("127.0.0.1", 1, 500, 500).kind, "closed port");
    }

    static List<String> hosts(List<Inet4Address> addresses) {
        String[] out = new String[addresses.size()];
        for (int i = 0; i < out.length; i++) out[i] = addresses.get(i).getHostAddress();
        return Arrays.asList(out);
    }

    static byte[] header(int id, int flags, int questions, int answers) {
        return new byte[] {(byte) (id >> 8), (byte) id, (byte) (flags >> 8), (byte) flags,
                0, (byte) questions, 0, (byte) answers, 0, 0, 0, 0};
    }

    static byte[] ascii(String s) {
        return s.getBytes(StandardCharsets.US_ASCII);
    }

    static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) out.write(p, 0, p.length);
        return out.toByteArray();
    }
}
