package com.sanadunt.groundview.core;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Finds the Ground Console's LAN view on the tablet's own network: the
 * groundstation's mDNS name, and every address of the local subnet asked on
 * the LAN view port (GET /api/capabilities with access "lan-view").
 */
public final class Discovery {
    public static final String DEFAULT_NAME = "groundstation.local";
    static final int SCAN_THREADS = 48;
    static final int SCAN_CONNECT_MS = 400;
    static final int SCAN_READ_MS = 2500;
    static final int MDNS_TIMEOUT_MS = 1200;
    /** Subnets wider than this are scanned as the /24 around the tablet's address. */
    static final int WIDEST_SCANNED_PREFIX = 22;

    public interface Listener {
        /** Called from scan threads; done of total addresses asked so far. */
        void onProgress(int done, int total);
    }

    /** One IPv4 address of this device and its subnet. */
    public static final class LocalAddress {
        public final Inet4Address address;
        public final int prefix;
        public final NetworkInterface nif;

        LocalAddress(Inet4Address address, int prefix, NetworkInterface nif) {
            this.address = address;
            this.prefix = prefix;
            this.nif = nif;
        }

        @Override
        public String toString() {
            return address.getHostAddress() + "/" + prefix;
        }
    }

    public static final class Result {
        /** LAN views that answered, the mDNS name's address first. */
        public final List<ProbeResult> consoles;
        /** LAN views that refused this device's address. */
        public final List<ProbeResult> refused;
        public final List<LocalAddress> local;

        Result(List<ProbeResult> consoles, List<ProbeResult> refused, List<LocalAddress> local) {
            this.consoles = consoles;
            this.refused = refused;
            this.local = local;
        }
    }

    private Discovery() {}

    public static Result run(String name, int port, Listener listener) {
        List<LocalAddress> local = localAddresses();
        List<String> hosts = new ArrayList<>();
        for (LocalAddress la : local) {
            for (String host : hostsToScan(la.address, la.prefix)) {
                if (!hosts.contains(host)) hosts.add(host);
            }
        }
        List<NetworkInterface> interfaces = new ArrayList<>();
        for (LocalAddress la : local) {
            if (!interfaces.contains(la.nif)) interfaces.add(la.nif);
        }

        ExecutorService pool = Executors.newFixedThreadPool(SCAN_THREADS);
        try {
            Future<List<Inet4Address>> mdns = pool.submit(() -> Mdns.resolve(name, interfaces, MDNS_TIMEOUT_MS));
            List<Future<ProbeResult>> scans = new ArrayList<>();
            AtomicInteger done = new AtomicInteger();
            int total = hosts.size();
            for (String host : hosts) {
                scans.add(pool.submit(() -> {
                    ProbeResult r = Probe.check(host, port, SCAN_CONNECT_MS, SCAN_READ_MS);
                    if (listener != null) listener.onProgress(done.incrementAndGet(), total);
                    return r;
                }));
            }
            Map<String, ProbeResult> byHost = new LinkedHashMap<>();
            for (Inet4Address a : get(mdns, Collections.<Inet4Address>emptyList())) {
                String host = a.getHostAddress();
                ProbeResult r = Probe.check(host, port, 1500, SCAN_READ_MS);
                byHost.put(host, r);
            }
            for (Future<ProbeResult> f : scans) {
                ProbeResult r = get(f, null);
                if (r != null && !byHost.containsKey(r.host)) byHost.put(r.host, r);
            }
            List<ProbeResult> consoles = new ArrayList<>();
            List<ProbeResult> refused = new ArrayList<>();
            for (ProbeResult r : byHost.values()) {
                if (r.kind == ProbeResult.Kind.CONSOLE) consoles.add(r);
                else if (r.kind == ProbeResult.Kind.NOT_ALLOWED) refused.add(r);
            }
            return new Result(consoles, refused, local);
        } finally {
            pool.shutdownNow();
        }
    }

    private static <T> T get(Future<T> future, T fallback) {
        try {
            return future.get(30, TimeUnit.SECONDS);
        } catch (Exception e) {
            return fallback;
        }
    }

    /** The private IPv4 addresses of interfaces that are up, leaving out mobile data and VPNs. */
    public static List<LocalAddress> localAddresses() {
        List<LocalAddress> out = new ArrayList<>();
        Enumeration<NetworkInterface> all;
        try {
            all = NetworkInterface.getNetworkInterfaces();
        } catch (SocketException e) {
            return out;
        }
        if (all == null) return out;
        for (NetworkInterface nif : Collections.list(all)) {
            try {
                if (!nif.isUp() || nif.isLoopback() || nif.isVirtual() || nif.isPointToPoint()) continue;
            } catch (SocketException e) {
                continue;
            }
            String n = nif.getName().toLowerCase(Locale.ROOT);
            if (n.startsWith("rmnet") || n.startsWith("ccmni") || n.startsWith("tun") || n.startsWith("ppp")
                    || n.startsWith("dummy") || n.startsWith("v4-") || n.startsWith("clat") || n.startsWith("utun")) {
                continue;
            }
            for (InterfaceAddress ia : nif.getInterfaceAddresses()) {
                InetAddress a = ia.getAddress();
                if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                    out.add(new LocalAddress((Inet4Address) a, ia.getNetworkPrefixLength(), nif));
                }
            }
        }
        return out;
    }

    /** Every host address of the subnet (the /24 around address when the subnet is wider than /22). */
    static List<String> hostsToScan(Inet4Address address, int prefix) {
        List<String> out = new ArrayList<>();
        if (prefix > 30 || prefix < 0) return out;
        if (prefix < WIDEST_SCANNED_PREFIX) prefix = 24;
        byte[] b = address.getAddress();
        long ip = ((b[0] & 0xffL) << 24) | ((b[1] & 0xffL) << 16) | ((b[2] & 0xffL) << 8) | (b[3] & 0xffL);
        long mask = (0xffffffffL << (32 - prefix)) & 0xffffffffL;
        long network = ip & mask;
        long broadcast = network | (~mask & 0xffffffffL);
        for (long h = network + 1; h < broadcast; h++) {
            out.add(((h >> 24) & 0xff) + "." + ((h >> 16) & 0xff) + "." + ((h >> 8) & 0xff) + "." + (h & 0xff));
        }
        return out;
    }
}
