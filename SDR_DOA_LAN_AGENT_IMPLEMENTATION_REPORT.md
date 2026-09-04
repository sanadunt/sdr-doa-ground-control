# Laporan Implementasi LAN Edge Agent SDR-DoA

## 1. Status dan scope

```text
Scope          : LAN management path only
Data source    : http://doasdr.local:8081 or http://192.168.100.100:8081
MQTT test      : broker staging Ground 127.0.0.1:18884
MQTT production: not used
PPP/T900      : not used
Remote write   : none during this stage
Raspberry      : no file/service/config change
Real DoA      : blocked by health/freshness/authority gates
```

The agent implementation is currently staged locally. It has not been copied to Raspberry or enabled as a system service. The LAN implementation gate remains `BLOCKED_PENDING_REVIEW` until an independent reviewer returns a terminal verdict.

## 2. Artefacts

```text
tools/sdr_doa_lan_agent.py
tools/sdr_doa_mqtt_stdlib.py
tools/test_sdr_doa_lan_agent.py
tools/test_sdr_doa_config_apply.py
tools/test_sdr_doa_mqtt_stdlib.py

Latest hardening:

```text
MAX_PENDING_COMMANDS : 32
MAX_COMMAND_JOURNAL : 128
incoming patch       : schema + allowlist + finite/range/revision/expiry validation
duplicate command    : bounded journal + replayed ACK, no re-apply
```
```

`tools/sdr_doa_lan_agent.py` supports:

- bounded collector GET;
- health/state/config-reported payload construction;
- DoA publication gate;
- event-driven state/config;
- bounded latest-value-wins queue;
- reconnect backoff;
- standard-library MQTT 3.1.1 transport;
- config command handling disabled unless explicitly enabled;
- atomic local settings apply path for a separately authorized deployment.

The standard-library MQTT client exists because the Raspberry system and `sdr` environment did not expose `paho-mqtt` in the read-only check.

## 3. Live LAN verification before implementation

The latest read-only check showed:

```text
doasdr.local       : resolves to 192.168.100.100
/status.json       : HTTP 200
/settings.json     : HTTP 200
/DOA_value.html   : HTTP 200
/doa.xml           : HTTP 200
Ground 192.168.100.173:1883: reachable from Raspberry
services          : active, active, active at latest probe
```

Live data remained degraded:

```text
daq_ok            : false
frame_sync        : true
iq_sync           : false
sample_delay_sync : false
GPS               : Disabled
DoA output        : stale in the sampling window
```

The agent therefore emits health/state/config-reported only. It does not emit numeric DoA while the gate is blocked.

## 4. Local tests

```text
3 LAN-agent tests passed
5 collector tests passed
4 MQTT contract tests passed
PASS stdlib MQTT CONNECT/SUBSCRIBE/PUBLISH QoS0/QoS1
2 stdlib MQTT integration assertions passed
7 stage-3 tests passed
```

The agent's unit policy checks include:

```text
unhealthy source → health/state/config only
valid fixture     → authority/angle gate still blocks DoA
raw settings      → omitted
raw angular array → omitted
```

## 5. LAN E2E staging result

Command shape:

```bash
/usr/bin/python3 tools/sdr_doa_lan_agent.py \
  --base-url http://192.168.100.100:8081 \
  --clock-source remote_unverified \
  --mqtt-host 127.0.0.1 \
  --mqtt-port 18884 \
  --publish \
  --duration 3 \
  --health-interval 1 \
  --doa-rate 2 \
  --state-interval 30 \
  --json-events
```

Observed result:

```text
iterations      : 45
last_error      : null
overall_state   : DEGRADED
gate_state      : BLOCKED
message kinds   : config_reported, health, state
DoA message     : absent by policy
```

Ground Console read-back from its subscriber-only monitor showed:

```text
connection      : connected
received        : 12
valid           : 12
invalid         : 0
publish_enabled : false
```

The broker log showed the LAN agent client publishing health, state, and config-reported to the staging broker. No DoA topic was published because the live gate failed.

## 6. Safety boundary

The local Ground Console remains:

```text
read_only       : true
mqtt_publish    : false
remote_post     : false
config_apply    : false
```

The LAN agent's `--publish` test was directed only at the explicit loopback staging broker. It was not installed or run on Raspberry. The `--enable-config` path was not used in the E2E test.

No command was sent to the Raspberry settings endpoint and no settings file was changed.

## 7. Deployment blockers

Before copying or enabling the agent on Raspberry, an independent review and explicit deployment approval are required. Remaining blockers include:

```text
[ ] reviewer approval for changed artefacts
[ ] production broker authentication/ACL/TLS
[ ] single-writer coordination with GUI/settings watcher
[ ] service unit and rollback plan
[ ] config path resolved from actual runtime CWD
[ ] config patch apply/read-back test on a disposable copy
[ ] command authorization and operator audit
[ ] DAQ daq_ok=true
[ ] DoA output fresh under controlled RF stimulus
[ ] DoA authority and canonical angle convention
[ ] wire-rate measurement on LAN/PPP path
```

The presence of a reachable broker on LAN does not make it a production broker. The presence of an active SDR process does not make the DAQ healthy.

## 8. Next LAN step

The rollout procedure is documented in:

```text
 deploy/LAN_HEALTH_ONLY_ROLLOUT_PLAN.md
```

It remains `PLAN ONLY / NOT EXECUTED` until an independent reviewer returns a terminal verdict and the user approves the separate remote-mutation step. The first rollout would be manual health-only with `--doa-rate 0`, no `--enable-config`, a dedicated staging broker, and a recorded rollback. Real DoA and settings apply remain separate gates.
