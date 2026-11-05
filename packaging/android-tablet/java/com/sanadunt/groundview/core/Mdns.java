package com.sanadunt.groundview.core;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * A one-shot mDNS A lookup (RFC 6762 section 5.1, the legacy unicast query): a
 * question with the QU bit from an ephemeral port to 224.0.0.251:5353, which
 * avahi answers by unicast to that port with the query ID echoed. Android's
 * browsers do not resolve .local names, so the app asks itself.
 * The same rules as tools/mdns_resolver.py: backward-only compression
 * pointers, at most 16 jumps, the asked name only, class IN, TTL above 0,
 * no loopback, unspecified, multicast or link-local address.
 */
public final class Mdns {
    static final InetSocketAddress GROUP = new InetSocketAddress("224.0.0.251", 5353);
    private static final int TYPE_A = 1;
    private static final int CLASS_IN = 1;
    private static final int QU_BIT = 0x8000;
    private static final int MAX_JUMPS = 16;

    private Mdns() {}

    /** Asks every given interface once and gathers the answers until the timeout. */
    public static List<Inet4Address> resolve(String name, List<NetworkInterface> interfaces, int timeoutMs) {
        Set<Inet4Address> found = new LinkedHashSet<>();
        int id = (int) (System.nanoTime() & 0xffff);
        byte[] query = buildQuery(id, name);
        try (MulticastSocket socket = new MulticastSocket(0)) {
            socket.setTimeToLive(255);
            if (!send(socket, query, interfaces)) return new ArrayList<>(found);
            long start = System.currentTimeMillis();
            long deadline = start + timeoutMs;
            // A responder may stay quiet about a name it answered within the
            // last second (RFC 6762 6.2), so ask once more halfway when nothing came.
            long resendAt = start + timeoutMs / 2;
            byte[] buffer = new byte[1500];
            while (true) {
                long now = System.currentTimeMillis();
                if (now >= deadline) break;
                if (resendAt > 0 && now >= resendAt) {
                    resendAt = 0;
                    if (found.isEmpty()) send(socket, query, interfaces);
                }
                long wake = resendAt > 0 ? Math.min(resendAt, deadline) : deadline;
                socket.setSoTimeout((int) Math.max(1, wake - now));
                DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
                try {
                    socket.receive(packet);
                } catch (SocketTimeoutException e) {
                    continue;
                }
                if (packet.getPort() != 5353) continue;
                byte[] data = new byte[packet.getLength()];
                System.arraycopy(packet.getData(), packet.getOffset(), data, 0, data.length);
                found.addAll(parseAnswer(data, id, name));
            }
        } catch (IOException ignored) {
            // No socket: the scan still runs.
        }
        return new ArrayList<>(found);
    }

    /** Sends the query on every interface that takes it; false when none did. */
    private static boolean send(MulticastSocket socket, byte[] query, List<NetworkInterface> interfaces) {
        boolean sent = false;
        for (NetworkInterface nif : interfaces) {
            try {
                socket.setNetworkInterface(nif);
                socket.send(new DatagramPacket(query, query.length, GROUP));
                sent = true;
            } catch (IOException ignored) {
                // This interface takes no multicast; try the next one.
            }
        }
        return sent;
    }

    static byte[] buildQuery(int id, String name) {
        byte[] encoded = encodeName(name);
        byte[] packet = new byte[12 + encoded.length + 4];
        packet[0] = (byte) (id >> 8);
        packet[1] = (byte) id;
        packet[5] = 1; // QDCOUNT
        System.arraycopy(encoded, 0, packet, 12, encoded.length);
        int at = 12 + encoded.length;
        packet[at] = 0;
        packet[at + 1] = TYPE_A;
        packet[at + 2] = (byte) ((QU_BIT | CLASS_IN) >> 8);
        packet[at + 3] = (byte) CLASS_IN;
        return packet;
    }

    static byte[] encodeName(String name) {
        String[] labels = trimDot(name).split("\\.");
        int length = 1;
        for (String label : labels) length += 1 + label.length();
        byte[] out = new byte[length];
        int at = 0;
        for (String label : labels) {
            byte[] bytes = label.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
            if (bytes.length == 0 || bytes.length > 63) throw new IllegalArgumentException("bad label in " + name);
            out[at++] = (byte) bytes.length;
            System.arraycopy(bytes, 0, out, at, bytes.length);
            at += bytes.length;
        }
        out[at] = 0;
        return out;
    }

    /** The A addresses for name in a response to query id; empty for anything else. */
    static List<Inet4Address> parseAnswer(byte[] data, int id, String name) {
        List<Inet4Address> out = new ArrayList<>();
        try {
            if (data.length < 12) return out;
            if (u16(data, 0) != (id & 0xffff)) return out;
            int flags = u16(data, 2);
            if ((flags & 0x8000) == 0) return out; // not a response
            if ((flags & 0x000f) != 0) return out; // RCODE
            int questions = u16(data, 4);
            int records = u16(data, 6) + u16(data, 8) + u16(data, 10);
            int[] at = {12};
            for (int i = 0; i < questions; i++) {
                readName(data, at);
                at[0] += 4;
            }
            String wanted = trimDot(name).toLowerCase(Locale.ROOT);
            for (int i = 0; i < records; i++) {
                String owner = readName(data, at);
                if (at[0] + 10 > data.length) return out;
                int type = u16(data, at[0]);
                int klass = u16(data, at[0] + 2) & 0x7fff; // the top bit is cache-flush
                long ttl = ((long) u16(data, at[0] + 4) << 16) | u16(data, at[0] + 6);
                int rdLength = u16(data, at[0] + 8);
                at[0] += 10;
                if (at[0] + rdLength > data.length) return out;
                if (type == TYPE_A && klass == CLASS_IN && rdLength == 4 && ttl > 0 && owner.equals(wanted)) {
                    byte[] raw = new byte[4];
                    System.arraycopy(data, at[0], raw, 0, 4);
                    InetAddress address = InetAddress.getByAddress(raw);
                    if (usable(address)) out.add((Inet4Address) address);
                }
                at[0] += rdLength;
            }
        } catch (IOException | IndexOutOfBoundsException | IllegalArgumentException e) {
            // A malformed packet: keep what was read before it.
        }
        return out;
    }

    static boolean usable(InetAddress a) {
        return a instanceof Inet4Address
                && !a.isLoopbackAddress()
                && !a.isAnyLocalAddress()
                && !a.isMulticastAddress()
                && !a.isLinkLocalAddress()
                && (a.getAddress()[0] & 0xff) < 240;
    }

    /** Reads a (possibly compressed) name at at[0] and moves at[0] past it. */
    static String readName(byte[] data, int[] at) throws IOException {
        StringBuilder name = new StringBuilder();
        int position = at[0];
        int jumps = 0;
        boolean jumped = false;
        while (true) {
            if (position >= data.length) throw new IOException("name runs past the packet");
            int length = data[position] & 0xff;
            if (length == 0) {
                if (!jumped) at[0] = position + 1;
                break;
            }
            if ((length & 0xc0) == 0xc0) {
                if (position + 1 >= data.length) throw new IOException("cut pointer");
                int target = ((length & 0x3f) << 8) | (data[position + 1] & 0xff);
                if (target >= position) throw new IOException("forward pointer");
                if (++jumps > MAX_JUMPS) throw new IOException("too many pointers");
                if (!jumped) at[0] = position + 2;
                jumped = true;
                position = target;
                continue;
            }
            if ((length & 0xc0) != 0) throw new IOException("label type");
            if (position + 1 + length > data.length) throw new IOException("cut label");
            if (name.length() > 0) name.append('.');
            for (int i = 0; i < length; i++) name.append((char) (data[position + 1 + i] & 0xff));
            if (name.length() > 255) throw new IOException("name too long");
            position += 1 + length;
        }
        return name.toString().toLowerCase(Locale.ROOT);
    }

    private static int u16(byte[] data, int at) {
        return ((data[at] & 0xff) << 8) | (data[at + 1] & 0xff);
    }

    private static String trimDot(String name) {
        return name.endsWith(".") ? name.substring(0, name.length() - 1) : name;
    }
}
