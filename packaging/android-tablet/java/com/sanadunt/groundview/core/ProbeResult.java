package com.sanadunt.groundview.core;

/** What one address answered on the LAN view port. */
public final class ProbeResult {
    public enum Kind {
        /** The Ground Console's LAN view: /api/capabilities with access "lan-view". */
        CONSOLE,
        /** A bare 403: the LAN view refused this tablet's address (allowed_clients). */
        NOT_ALLOWED,
        /** Something answered HTTP, but not the LAN view. */
        OTHER,
        UNREACHABLE,
    }

    public final String host;
    public final int port;
    public final Kind kind;
    /** The console version for CONSOLE, else null. */
    public final String version;
    /** A short reason for OTHER and UNREACHABLE (HTTP status or exception name). */
    public final String detail;

    public ProbeResult(String host, int port, Kind kind, String version, String detail) {
        this.host = host;
        this.port = port;
        this.kind = kind;
        this.version = version;
        this.detail = detail;
    }

    /** host:port, with brackets around an IPv6 address. */
    public String address() {
        return Probe.authority(host, port);
    }

    @Override
    public String toString() {
        return address() + " " + kind + (version != null ? " " + version : "") + (detail != null ? " (" + detail + ")" : "");
    }
}
