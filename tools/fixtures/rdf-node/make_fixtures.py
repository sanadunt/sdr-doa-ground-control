#!/usr/bin/env python3
"""Write RDF Node MQTT fixtures with the edge's own code.

Not a test and never shipped. It imports the ``rdf_node`` package of an RDF
Node checkout (``git archive <commit> rdf-node`` into a scratch directory; the
edge repository itself is never modified), builds an ``Agent`` over a
temporary KrakenSDR share directory, runs the agent's own scheduler and command
manager once per case, and stores every payload the agent hands to
``Agent._offer`` byte for byte (``util.compact``, as the MQTT client sends it).
Only the MQTT clients, the host monitor and the root helper are replaced, as the
edge's own tests do.

    python3 make_fixtures.py --edge SCRATCH/rdf-node --commit 8691ad0 --set full
    python3 make_fixtures.py --edge SCRATCH-HEAD/rdf-node --commit 20713ff --set detail-ppp
    python3 make_fixtures.py --edge SCRATCH/rdf-node --commit 8691ad0 --set commands

The first command writes every topic; the second adds the newer
``telemetry/health/detail`` with the PPP fields and the ``state`` of its own
session. ``manifest.json`` lists each file with its topic, QoS, retain flag and
expiry as the agent offered it.

The third writes ``commands.json``: Kontrol's ``config.get`` and
``config.patch`` envelopes, built by the console's own
``tools/rdf_node_commands.py``, each handed to the edge's real
``CommandManager.submit`` (on the topic the console publishes to) with the
edge's real root helper ``Controller`` writing the scratch ``settings.json``,
and every ACK and settings report the edge answered with. Cases the console
refuses itself are built without its checks, so the file also records that
the edge refuses them for the same reason.
"""

from __future__ import annotations

import argparse
import inspect
import json
import math
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _settings_text() -> bytes:
    # A KrakenSDR settings.json shape; indentation and key order are kept so
    # settings/reported carries this exact text.
    settings = {
        "center_freq": 433.92,
        "uniform_gain": 15.7,
        "data_interface": "shmem",
        "en_doa": True,
        "doa_method": "MUSIC",
        "doa_decorrelation_method": "Off",
        "ant_arrangement": "UCA",
        "ant_spacing_meters": 0.21,
        "active_vfos": 1,
        "output_vfo": 0,
        "vfo_mode": "Standard",
        "vfo_freq_0": 433920000,
        "vfo_bw_0": 12500,
        "vfo_squelch_0": -80,
        "doa_fig_type": "Compass",
        "compass_offset": 0,
        "location_source": "None",
        "latitude": 0.0,
        "longitude": 0.0,
        "station_id": "fixture-station",
        "en_remote_control": False,
    }
    return (json.dumps(settings, indent=2) + "\n").encode("utf-8")


def _values(peak_index: int) -> list:
    values = []
    for index in range(360):
        distance = min(abs(index - peak_index), 360 - abs(index - peak_index))
        values.append(round(-24.0 + 22.5 * math.exp(-((distance / 11.0) ** 2)), 2))
    return values


def _record(timestamp_ms: int, raw_doa_deg: float, frequency_hz: int = 433920000) -> bytes:
    row = [timestamp_ms, raw_doa_deg, 8.27, -54.2, frequency_hz, "UCA", 436, "fixture-station",
           0, 0, 0, 0, "None", "R", "R", "R", "R"] + _values(int(raw_doa_deg))
    return (",".join(map(str, row)) + "\n").encode("utf-8")


def _status(timestamp_ms: int, frame_index: int, daq_ok: bool,
            center_hz: int = 433920000, gain_db: float = 15.7) -> bytes:
    return json.dumps({
        "timestamp_ms": timestamp_ms,
        "daq_ok": daq_ok,
        "daq_num_dropped_frames": 2,
        "daq_status": {
            "data_frame_index": frame_index,
            "frame_sync": True,
            "sample_delay_sync": True,
            "iq_sync": daq_ok,
            "rf_center_frequency_hz": center_hz,
            "gain_db": gain_db,
        },
    }).encode("utf-8")


def _doa_xml(timestamp_ms: int, raw_doa_deg: float) -> bytes:
    return (f"<DATA><TIME>{timestamp_ms}</TIME><DOA>{raw_doa_deg}</DOA>"
            f"<FREQUENCY>433.92</FREQUENCY></DATA>").encode("utf-8")


class Run:
    """One Agent over a scratch share directory, with every offer captured."""

    def __init__(self, edge: Path, workdir: Path) -> None:
        sys.path[:0] = [str(edge / "src"), str(edge / "vendor")]
        from rdf_node import __version__
        from rdf_node.agent import Agent
        from rdf_node.config import load_config
        from rdf_node.monitor import Monitor
        from rdf_node.mqtt import Client
        from rdf_node.util import compact, now_ms

        self.version = __version__
        self.compact = compact
        self.now_ms = now_ms
        self.client_class = Client
        self.share = workdir / "share"
        self.share.mkdir()
        cfg = load_config()
        cfg["state_dir"] = str(workdir / "state")
        cfg["source"]["share_dir"] = str(self.share)
        cfg["source"].update(authority_verified=True, angle_verified=True)
        cfg["api"]["admin_hash_file"] = str(workdir / "admin.json")
        self.raw_doa = 200.0
        (self.share / "settings.json").write_bytes(_settings_text())
        time.sleep(0.01)
        self.frame = 1
        self.write_source(daq_ok=True)
        agent = Agent(cfg)

        class HostMonitor:
            def __init__(self, cfg: dict) -> None:
                self.data = Monitor(cfg).snapshot()
                self.data.update(
                    clock_trusted=True, clock_state="SYNCED", service_state="ACTIVE",
                    generation="fixture-generation", cgroup_empty=False, cpu_percent=23.5,
                    memory_percent=41.2, temperature_c=52.3, disk_free_percent=71.8,
                    usb_count=2, usb="OK", tx_kbit_s=6.21, rx_kbit_s=1.37, throttled=False,
                    undervoltage=False, ppp="UP", interface="ppp0", ppp_probe="REPLY",
                    ppp_service={"state": "ACTIVE", "substate": "running", "restarts": 0, "since": 1})

            def start(self) -> None:
                return None

            def stop(self) -> None:
                return None

            def snapshot(self) -> dict:
                return dict(self.data)

        agent.monitor = HostMonitor(cfg)
        agent.helper_status = {
            "allow_config": False, "allow_lifecycle": False, "allow_reboot": False,
            "allow_shutdown": False, "allow_ppp_restart": False, "allow_remote_control": False,
            "settings_target_available": False, "lifecycle_target_available": False,
        }
        self.agent = agent
        self.offers: list = []
        signature = inspect.signature(Agent._offer)

        def offer(*args, **kwargs):
            bound = signature.bind(agent, *args, **kwargs)
            bound.apply_defaults()
            values = bound.arguments
            payload = values["payload"]
            data = payload if isinstance(payload, bytes) else compact(payload)
            self.offers.append({
                "key": values["key"], "suffix": values["suffix"], "data": data,
                "qos": values["qos"], "retain": values["retain"], "expiry": values["expiry"],
            })
            return True

        agent._offer = offer
        agent.source.poll(force=True)
        self.frame = 2
        self.write_source(daq_ok=True, records=False)
        agent.source.poll(force=True)
        agent._snapshot()
        agent.commands.start()

    def write_source(self, *, daq_ok: bool, records: bool = True) -> None:
        now = self.now_ms()
        (self.share / "status.json").write_bytes(_status(now, self.frame, daq_ok))
        if records:
            (self.share / "DOA_value.html").write_bytes(_record(now, self.raw_doa))
            (self.share / "doa.xml").write_bytes(_doa_xml(now, self.raw_doa))

    def refresh(self, *, daq_ok: bool = True, verified: bool = True) -> None:
        self.agent.cfg["source"].update(authority_verified=verified, angle_verified=verified)
        self.frame += 1
        self.write_source(daq_ok=daq_ok)
        self.agent.source.poll(force=True)
        self.frame += 1
        self.write_source(daq_ok=daq_ok, records=False)
        self.agent.source.poll(force=True)
        self.agent._snapshot()

    def schedule_once(self, *, bulk_ready: bool = True, hello: bool = False) -> list:
        agent = self.agent
        control = self.client_class(cfg={}, client_id="fixture-control")
        bulk = self.client_class(cfg={}, client_id="fixture-bulk")
        control.ready = True
        bulk.ready = bulk_ready
        agent.clients = {"control": control, "bulk": bulk}
        agent._generation = -1 if hello else 0
        agent.profile = "balanced"
        agent.bulk_resume_after = 0
        agent.last_doa_q = 0
        agent.last_angular_q = 0
        agent.stop_event.clear()
        snapshot = agent.snapshot()
        real = agent.snapshot

        def one_snapshot():
            agent.stop_event.set()
            return snapshot

        start = len(self.offers)
        agent.snapshot = one_snapshot
        try:
            agent._schedule()
        finally:
            agent.snapshot = real
            agent.stop_event.clear()
        return self.offers[start:]

    def request(self, op: str, **fields) -> dict:
        now = self.now_ms()
        request = dict(v=2, id="g01-" + uuid.uuid4().hex[:12], sid=self.agent.sid, boot=self.agent.boot,
                       issued_ms=now, expires_ms=now + 15000, base_rev=self.agent.source.revision, op=op)
        request.update(fields)
        return request

    def command(self, op: str, *, wait: bool = False, **fields) -> list:
        from rdf_node.control import OPS

        agent = self.agent
        agent.commands.last_rate.clear()
        start = len(self.offers)
        request = self.request(op, **fields)
        agent.commands.submit(request, "ground-controller", topic=agent.prefix + "/" + OPS[op])
        if wait:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with agent.commands.lock:
                    if not agent.commands.busy:
                        break
                time.sleep(0.02)
        return [item for item in self.offers[start:] if item["suffix"].startswith("ack/")]


def _pick(offers: list, suffix: str) -> dict:
    found = [item for item in offers if item["suffix"] == suffix]
    if len(found) != 1:
        raise SystemExit(f"expected one {suffix} offer, got {len(found)}")
    return found[0]


def full_set(run: Run) -> list:
    fixtures = []

    def add(name: str, offer: dict, note: str) -> None:
        fixtures.append((name, offer, note))

    live = run.schedule_once(hello=True)
    add("availability.online.json", _pick(live, "availability"), "Control ready, retained online")
    add("capabilities.json", _pick(live, "capabilities"), "Control connection generation changed")
    add("state.json", _pick(live, "state"), "first state of the session")
    add("telemetry-health.json", _pick(live, "telemetry/health"), "run=1, daq=1")
    add("telemetry-health-detail.json", _pick(live, "telemetry/health/detail"), "fields of 8691ad0, no PPP fields")
    add("telemetry-doa.ok1.json", _pick(live, "telemetry/doa"), "authority and angle verified: ok=1, relative angle (theta_mirror)")
    add("telemetry-diagnostic-doa.json", _pick(live, "telemetry/diagnostic/doa"), "doa.xml read while the DoA gate passes")
    add("telemetry-diagnostic-angular.wait-stable.json", _pick(live, "telemetry/diagnostic/angular"),
        "source valid, Bulk still waiting for a stable link after the connect (flags 63, still UNVERIFIED)")
    bulk = run.schedule_once()
    add("telemetry-angular.live.json", _pick(bulk, "telemetry/angular"), "flags 63 on the Bulk client")
    will_topic, will_payload = run.agent._will()
    add("availability.offline-will.json",
        {"suffix": "availability", "data": will_payload, "qos": 1, "retain": True, "expiry": None},
        "Last Will in CONNECT, published by the broker when the connection is lost")

    run.refresh(verified=False)
    trust_only = run.schedule_once()
    add("telemetry-doa.ok0.json", _pick(trust_only, "telemetry/doa"), "authority and angle not verified (edge default): ok=0, raw angle")
    add("telemetry-angular.unverified.json", _pick(trust_only, "telemetry/angular"), "flags 23: convention and authority bits missing")

    run.refresh(daq_ok=False, verified=True)
    degraded = run.schedule_once()
    add("telemetry-health.daq-degraded.json", _pick(degraded, "telemetry/health"), "daq=0")
    add("telemetry-diagnostic-doa.degraded.json", _pick(degraded, "telemetry/diagnostic/doa"), "doa.xml read while DAQ is not healthy")
    add("telemetry-diagnostic-angular.json", _pick(degraded, "telemetry/diagnostic/angular"), "source not eligible: DAQ bit missing")

    run.refresh(daq_ok=True, verified=True)
    acks = run.command("config.get")
    add("ack-config.config-get-applied.json", _pick(acks, "ack/config"), "config.get accepted and answered")
    report = run.schedule_once()
    add("settings-reported.json", _pick(report, "settings/reported"), "answer to that config.get (TLS link)")
    acks = run.command("config.patch", changes={"vfo0_frequency_hz": 433920000},
                       base_rev=run.agent.source.revision + 1)
    add("ack-config.config-patch-rejected.json", _pick(acks, "ack/config"),
        "config.patch with a base_rev that is not the current revision")
    acks = run.command("stream.set", wait=True, profile="balanced")
    stream_id = json.loads(acks[0]["data"])["id"]
    add("ack-operation.stream-set-accepted.json", acks[0], "stream.set queued")
    add("ack-operation.stream-set-applied.json", acks[1], "stream.set done")
    acks = run.command("operation.get", target_id=stream_id)
    add("ack-operation.operation-get.json", _pick(acks, "ack/operation"), "public record of the stream.set above")
    acks = run.command("service.restart", wait=True)
    add("ack-operation.service-restart-unknown.json", acks[-1], "no root helper socket: OUTCOME_UNKNOWN")

    from rdf_node.helper import DEFAULT_POLICY, Controller
    import pwd

    policy = dict(DEFAULT_POLICY)
    policy.update(state_dir=str(Path(run.agent.cfg["state_dir"]) / "helper"),
                  allowed_user=pwd.getpwuid(os.getuid()).pw_name, engine_service="rdfsdr.service")
    controller = Controller(policy)
    run.agent.commands._helper = lambda request, timeout=8: controller.dispatch(request, os.getuid())
    acks = run.command("system.reboot.prepare", wait=True)
    add("ack-operation.reboot-prepare-applied.json", acks[-1], "real helper Controller: result carries the one-time challenge")
    # ppp.restart only checks that the helper answered exactly this.
    run.agent.commands._helper = lambda request, timeout=8: {"requested": True, "service": "t900-ppp.service"}
    acks = run.command("ppp.restart", wait=True)
    add("ack-operation.ppp-restart-requested.json", acks[-1], "systemd accepted the restart (helper answer stubbed)")
    return fixtures


COMMAND_IDS = iter(f"gc-{index:024x}" for index in range(1, 1000))


def _console_commands():
    sys.path.insert(0, str(HERE.parents[1]))
    import rdf_node_commands

    return rdf_node_commands


class NodeWriter:
    """Writes the KrakenSDR files the way the running engine would after a patch.

    While the edge verifies a patch it polls the scratch share; this thread
    writes a new status.json (centre and gain of settings.json) and a new
    DoA record (VFO0 of settings.json) and polls, so a field with runtime
    evidence gets it, as on a real node.
    """

    def __init__(self, run: "Run") -> None:
        import threading

        self.run = run
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.loop, daemon=True)

    def loop(self) -> None:
        run = self.run
        while not self.stop.wait(0.2):
            settings = json.loads((run.share / "settings.json").read_text())
            now = run.now_ms()
            run.frame += 1
            (run.share / "status.json").write_bytes(_status(
                now, run.frame, True, center_hz=int(round(settings["center_freq"] * 1e6)),
                gain_db=settings["uniform_gain"]))
            (run.share / "DOA_value.html").write_bytes(_record(now, run.raw_doa, int(settings["vfo_freq_0"])))
            run.agent.source.poll(force=True)

    def __enter__(self) -> "NodeWriter":
        self.thread.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.stop.set()
        self.thread.join(5)


def commands_set(run: Run) -> dict:
    """Console-built commands through the edge's own CommandManager and helper."""
    from rdf_node.control import OPS
    from rdf_node.helper import DEFAULT_POLICY, Controller
    from rdf_node.util import strict_json
    import pwd

    cmds = _console_commands()
    agent = run.agent
    agent.cfg["control"]["verify_seconds"] = 2
    policy = dict(DEFAULT_POLICY)
    policy.update(state_dir=str(Path(agent.cfg["state_dir"]) / "helper"),
                  allowed_user=pwd.getpwuid(os.getuid()).pw_name,
                  settings_path=str(run.share / "settings.json"), single_writer_confirmed=True)
    controller = Controller(policy)
    agent.commands._helper = lambda request, timeout=8: controller.dispatch(request, os.getuid())
    agent.helper_status = controller.state_info()
    session = run.schedule_once(hello=True)
    state = _pick(session, "state")
    health = _pick(session, "telemetry/health")
    node_id = agent.cfg["node_id"]
    cases = []

    def send(name: str, op: str, changes, note: str, *, check: bool = True, base_rev="current",
             expect=None) -> None:
        agent.commands.last_rate.clear()
        refused = None
        normalized = changes
        if op == cmds.OP_CONFIG_PATCH:
            try:
                normalized = cmds.validate_patch_changes(changes)
            except cmds.CommandRefused as exc:
                refused = exc.code
                normalized = dict(changes)
        if check and refused is not None:
            raise SystemExit(f"{name}: the console refused {changes}: {refused}")
        if not check and refused is None:
            raise SystemExit(f"{name}: the console accepted {changes}")
        revision = agent.source.revision if base_rev == "current" else base_rev
        command = cmds.build_command(
            op, command_id=next(COMMAND_IDS), sid=agent.sid, boot=agent.boot, base_rev=revision,
            issued_ms=run.now_ms(), changes=normalized if op == cmds.OP_CONFIG_PATCH else None)
        if check:
            cmds.validate_command(command, now_ms=command["issued_ms"])
        raw = cmds.encode_command(command)
        topic = cmds.command_topic(node_id, op)
        if topic != agent.prefix + "/" + OPS[op]:
            raise SystemExit(f"{name}: console topic {topic} is not the edge's")
        start = len(run.offers)
        with NodeWriter(run):
            agent.commands.submit(strict_json(raw), "ground-controller", topic=topic)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                with agent.commands.lock:
                    if not agent.commands.busy:
                        break
                time.sleep(0.05)
        agent.source.poll(force=True)
        acks = [item for item in run.offers[start:] if item["suffix"] == "ack/config"]
        report = None
        if op == cmds.OP_CONFIG_GET:
            reports = [item for item in run.schedule_once() if item["suffix"] == "settings/reported"]
            report = reports[0]["data"].decode("utf-8") if reports else None
        if not acks:
            raise SystemExit(f"{name}: no ack/config")
        final = json.loads(acks[-1]["data"])
        if expect is not None and (final["status"], final["result"].get("error")) != expect:
            raise SystemExit(f"{name}: edge answered {final['status']} {final['result']}, expected {expect}")
        cases.append({
            "name": name,
            "note": note,
            "op": op,
            "changes": changes,
            "console": {
                "accepted": refused is None,
                "code": refused,
                "topic": topic,
                "qos": cmds.COMMAND_QOS,
                "retain": False,
                "payload": raw.decode("utf-8"),
            },
            "edge": {
                "acks": [{"qos": item["qos"], "retain": item["retain"], "expiry_s": item["expiry"],
                          "payload": item["data"].decode("utf-8")} for item in acks],
                "settings_reported": report,
            },
        })

    send("config-get", cmds.OP_CONFIG_GET, None, "settings read over a TLS link: APPLIED, then settings/reported",
         expect=("APPLIED", None))
    agent.cfg["mqtt"]["tls"] = False
    send("config-get-tls-off", cmds.OP_CONFIG_GET, None, "the edge's link to the broker is not TLS",
         expect=("REJECTED", "TLS_REQUIRED_FOR_SETTINGS_REPORT"))
    agent.cfg["mqtt"]["tls"] = True
    send("retune", cmds.OP_CONFIG_PATCH, {"center_frequency_hz": 434000000, "vfo0_frequency_hz": 434000000},
         "centre and VFO0 together; fresh DAQ centre and DoA frequency prove both", expect=("APPLIED", None))
    send("gain", cmds.OP_CONFIG_PATCH, {"gain_db": 20.7}, "a gain table value; fresh DAQ gain proves it",
         expect=("APPLIED", None))
    send("vfo-only", cmds.OP_CONFIG_PATCH, {"vfo0_frequency_hz": 434010000},
         "VFO0 alone inside the band; a fresh DoA frequency proves it", expect=("APPLIED", None))
    send("bandwidth-squelch", cmds.OP_CONFIG_PATCH, {"vfo0_bandwidth_hz": 25000, "vfo0_squelch_db": -70},
         "no runtime evidence exists for these fields", expect=("PERSISTED_UNVERIFIED", None))
    stale = agent.source.revision - 1
    send("stale-base-rev", cmds.OP_CONFIG_PATCH, {"gain_db": 15.7},
         "base_rev of the previous revision (another writer changed the settings)", base_rev=stale,
         expect=("REJECTED", "CONFIG_REVISION_CONFLICT"))
    send("center-without-vfo0", cmds.OP_CONFIG_PATCH, {"center_frequency_hz": 433000000},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "CENTER_CHANGE_REQUIRES_VFO0_TARGET"))
    send("center-not-vfo0", cmds.OP_CONFIG_PATCH, {"center_frequency_hz": 433000000, "vfo0_frequency_hz": 433010000},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "MVP_CENTER_MUST_EQUAL_VFO0"))
    send("gain-not-in-table", cmds.OP_CONFIG_PATCH, {"gain_db": 20.0},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "GAIN_NOT_IN_APPROVED_TABLE"))
    send("frequency-too-high", cmds.OP_CONFIG_PATCH, {"center_frequency_hz": 1800000000, "vfo0_frequency_hz": 1800000000},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "INTEGER_OUT_OF_RANGE"))
    send("frequency-fraction", cmds.OP_CONFIG_PATCH, {"vfo0_frequency_hz": 434000000.5},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "INTEGER_OUT_OF_RANGE"))
    send("bandwidth-too-wide", cmds.OP_CONFIG_PATCH, {"vfo0_bandwidth_hz": 2500000},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "INTEGER_OUT_OF_RANGE"))
    send("squelch-too-high", cmds.OP_CONFIG_PATCH, {"vfo0_squelch_db": 60},
         "refused by the console; the edge's helper refuses it too", check=False,
         expect=("FAILED", "NUMBER_OUT_OF_RANGE"))
    send("old-field-name", cmds.OP_CONFIG_PATCH, {"vfo_frequency_hz": 434000000},
         "the console's former name; refused by both", check=False, expect=("REJECTED", "INVALID_PATCH"))
    return {
        "edge_version": run.version,
        "node_id": node_id,
        "session": {
            "state": state["data"].decode("utf-8"),
            "health": health["data"].decode("utf-8"),
        },
        "cases": cases,
    }


def detail_ppp_set(run: Run) -> list:
    offers = run.schedule_once()
    return [
        ("state.ppp-session.json", _pick(offers, "state"), "state of the session that sent the PPP detail"),
        ("telemetry-health-detail.ppp.json", _pick(offers, "telemetry/health/detail"),
         "newer edge: PPP fields ppp, peer, ppp_svc, ppp_restarts"),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--edge", required=True, type=Path, help="rdf-node directory of an RDF Node checkout")
    parser.add_argument("--commit", required=True, help="the commit that checkout was taken from")
    parser.add_argument("--set", required=True, choices=("full", "detail-ppp", "commands"))
    parser.add_argument("--out", type=Path, default=HERE)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp:
        run = Run(args.edge.resolve(), Path(tmp))
        if args.set == "commands":
            result = commands_set(run)
            run.agent.commands.stop()
            run.agent.journal.close()
            result.update(edge_commit=args.commit, generated_at_ms=int(time.time() * 1000))
            (args.out / "commands.json").write_text(json.dumps(result, indent=2) + "\n")
            print(f"wrote {len(result['cases'])} command cases to {args.out / 'commands.json'}")
            return 0
        fixtures = full_set(run) if args.set == "full" else detail_ppp_set(run)
        run.agent.commands.stop()
        run.agent.journal.close()
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"fixtures": []}
    names = {name for name, _offer, _note in fixtures}
    entries = [entry for entry in manifest["fixtures"] if entry["file"] not in names]
    for name, offer, note in fixtures:
        (args.out / name).write_bytes(offer["data"])
        entries.append({
            "file": name,
            "topic": offer["suffix"],
            "qos": offer["qos"],
            "retain": offer["retain"],
            "expiry_s": offer["expiry"],
            "edge_commit": args.commit,
            "edge_version": run.version,
            "note": note,
        })
    if args.set == "full":
        manifest["edge_commit"] = args.commit
        manifest["generated_at_ms"] = int(time.time() * 1000)
    manifest["fixtures"] = sorted(entries, key=lambda entry: entry["file"])
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    print(f"wrote {len(fixtures)} fixtures to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
