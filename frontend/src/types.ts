export type DataState =
  | 'LOADING'
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'STALE'
  | 'CONFLICT'
  | 'INVALID'
  | 'INCOMPLETE'
  | 'UNAVAILABLE'
  | 'ERROR';

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

export interface Freshness {
  timestamp_ms?: number;
  reference_ms?: number;
  reference_kind?: string;
  freshness_known?: boolean;
  age_ms?: number | null;
  raw_age_ms?: number | null;
  fresh?: boolean | null;
  future_skew?: boolean | null;
  max_age_ms?: number;
  node_stalled?: boolean;
}

export interface Candidate {
  [key: string]: unknown;
  available?: boolean;
  source_format?: string;
  freshness?: Freshness;
  canonical_angle_deg?: number;
  angular_power_db?: number[];
  angular_peak_index?: number;
  angular_peak_db?: number;
  angular_bins?: number;
  latitude?: number;
  longitude?: number;
  gps_heading?: number;
  compass_heading?: number;
  heading_source?: string;
  heading?: number;
  frequency_hz_normalized?: number;
  native_metrics_state?: string;
  contract_mapping_state?: string;
}

export interface NativeConsistency {
  [key: string]: unknown;
  comparable?: boolean;
  same_timestamp?: boolean;
  timestamp_delta_ms?: number | null;
  conflict?: boolean;
  circular_distance_deg?: number;
}

export interface StatusSnapshot {
  [key: string]: unknown;
  available?: boolean;
  safe?: Record<string, unknown>;
  daq_health?: string;
  failed_sync_flags?: string[];
  missing_sync_flags?: string[];
  freshness?: Freshness | null;
}

export interface PublicationGate {
  [key: string]: unknown;
  state?: string;
  checks?: Record<string, unknown>;
  reasons?: string[];
}

export interface SettingsSnapshot {
  [key: string]: unknown;
  available?: boolean;
  redacted?: boolean;
  fields?: Record<string, unknown>;
  raw_fields_omitted?: boolean;
  /** settings.json was not read in this collection; a recent copy was reused. */
  reused?: boolean;
  /** Console clock (ms) when the settings.json used here was read. */
  read_at_ms?: number | null;
}

export interface AuthoritySnapshot {
  [key: string]: unknown;
  selected?: string | null;
  selected_doa?: Candidate | null;
  canonical_angle_ready?: boolean;
}

/** Collector node-progress tracking across reads; values are unvalidated JSON. */
export interface NodeProgress {
  [key: string]: unknown;
  state?: string;
  stalled?: boolean;
  stalled_counters?: string[];
  max_stall_ms?: number;
}

/** Collection timing for one snapshot; values are unvalidated JSON. */
export interface CollectionInfo {
  [key: string]: unknown;
  elapsed_ms?: number;
  budget_ms?: number | null;
  deadline_exceeded?: boolean;
  status_transport_failed?: boolean;
  /** The shared Data Out read this answer came from; sent back as `seen`. */
  id?: string;
  /** Console clock (ms) when the collection completed. */
  collected_at_ms?: number;
  /** How long before this answer the collection completed. */
  age_ms?: number;
  /** The answer came from a collection another request started. */
  shared?: boolean;
  settings_reused?: boolean;
  /** Age of the settings.json used, at the time of the answer. */
  settings_age_ms?: number | null;
  /** The console's saved refresh interval when the answer was sent; it sets how long one read is shared. */
  refresh_seconds?: number | null;
  /** The console's Data Out URL when the answer was sent; a page on another URL re-reads the config. */
  console_base_url?: string | null;
  /** How the Data Out host became an address: literal (IP in the URL), system, mdns, proxy (no address), or null. */
  host_resolution?: { host?: string | null; method?: string | null; address?: string | null };
}

export interface ResourceInfo {
  [key: string]: unknown;
  ok?: boolean;
  http_status?: number;
  error?: string;
  error_kind?: string;
}

/** Which source answered /api/snapshot and why (issue #8); values are unvalidated JSON. */
export interface SnapshotSource {
  [key: string]: unknown;
  /** mqtt, data_out (the fallback) or none. */
  kind?: string;
  /** The first of `reasons`, or MQTT_FRESH for an MQTT answer. */
  reason?: string;
  /** Why MQTT is not the source, then DATA_OUT_UNAVAILABLE when Data Out failed too. */
  reasons?: string[];
  mqtt?: Record<string, unknown>;
  data_out?: Record<string, unknown>;
}

export interface TelemetrySnapshot {
  [key: string]: unknown;
  /** Absent from older servers, which always answered from Data Out. */
  source?: SnapshotSource;
  schema_version?: number;
  collector?: Record<string, unknown>;
  observed_at_ms?: number;
  completed_at_ms?: number;
  node_progress?: NodeProgress;
  collection?: CollectionInfo;
  resources?: Record<string, ResourceInfo>;
  status?: StatusSnapshot;
  settings?: SettingsSnapshot;
  doa_candidates?: Record<string, Candidate>;
  native_consistency?: NativeConsistency;
  authority?: AuthoritySnapshot;
  publication_gate?: PublicationGate;
  overall_state?: string;
  /** MQTT answers: what MQTT carries besides the LIVE DoA (UNVERIFIED and diagnostic topics). */
  mqtt?: Record<string, unknown>;
  /** MQTT answers: the light Data Out read (status.json, settings.json, doa.xml) for what MQTT never carries. */
  data_out_light?: Record<string, unknown>;
}

export type MqttTransport = 'tcp' | 'websockets';

/** Broker the local subscriber-only monitor connects to. */
export interface MqttTarget {
  host: string;
  port: number;
  /** Sent only when known; the server otherwise keeps its saved transport. */
  transport?: MqttTransport;
  /** Sent only with the WebSocket transport. */
  wsPath?: string;
}

export interface ConsoleConfig {
  version?: number;
  base_url: string;
  mqtt_host: string;
  mqtt_port: number;
  /** Absent when the server did not report it; a save without it keeps the stored value. */
  mqtt_transport?: MqttTransport;
  /** WebSocket path, used only with the websockets transport. */
  mqtt_ws_path?: string;
  /** Hosts Data Out may be read from (port 8081); base_url's host is one of them. Absent from older servers. */
  data_out_hosts?: string[];
  refresh_seconds: number;
}

export interface Branding {
  app_name: string;
  logo_data_url: string;
}

/** GET /api/mqtt: the one MQTT status, after lib/mqttMonitor normalization. */
export interface MqttSnapshot {
  [key: string]: unknown;
  enabled?: boolean;
  read_only?: boolean;
  publish_enabled?: boolean;
  host?: string;
  port?: number;
  transport?: MqttTransport;
  ws_path?: string;
  /** The RDF Node whose topics the monitor subscribes to, and their root (sdr/v2/<node>). */
  node_id?: string;
  root?: string;
  connection?: string;
  last_error?: string | null;
  /** Server clock when the snapshot was taken. */
  now_ms?: number;
  /** Browser clock when the snapshot was read; set by the API adapter for local ageing. */
  fetched_at_ms?: number;
  /** Messages on the subscribed RDF Node topics, the same counts as /api/mqtt/rdf-node. */
  received?: number;
  valid?: number;
  invalid?: number;
  /** Zero-length retained publishes that removed a value. */
  cleared?: number;
  last_received_at_ms?: number | null;
  last_age_ms?: number | null;
}

/** One RDF Node topic as reported by /api/mqtt/rdf-node, normalized: the status of its latest message. */
export interface RdfNodeTopic {
  /** LIVE, UNVERIFIED, FRESH, CONTEXT, STALE, INCONSISTENT, IGNORED, INVALID or UNAVAILABLE. */
  status: string;
  received_at_ms: number | null;
  qos: number | null;
  retained: boolean | null;
  error: string | null;
  /** The field that broke the contract, when the server named one. */
  field: string | null;
  /** A zero-length retained publish removed the broker's value. */
  cleared: boolean;
  /** Bounded, sanitized fields only; the 360-bin angular values are dropped. */
  payload: Record<string, unknown> | null;
}

/** One part of the node view: the latest accepted value of that role, never a rejected message. */
export interface RdfNodePart {
  /** LIVE, UNVERIFIED, FRESH, CONTEXT, STALE or INCONSISTENT, derived from the server's view. */
  status: string;
  received_at_ms: number | null;
  /** Why it is not LIVE, or why a candidate is UNVERIFIED (server codes). */
  reasons: string[];
  /** Bounded, sanitized display fields of the part. */
  fields: Record<string, unknown>;
}

export interface RdfNodeAck {
  topic: string;
  status: string;
  final: boolean;
  received_at_ms: number | null;
  error: string | null;
}

export interface RdfNodeView {
  parts: Record<string, RdfNodePart | null>;
  /** Newest first. */
  acks: RdfNodeAck[];
  /** config.get requests still waiting for settings/reported. */
  settings_requests: number;
}

export interface RdfNodeSnapshot {
  enabled: boolean;
  connection: string;
  last_error: string | null;
  now_ms: number | null;
  /** Browser clock when the snapshot was read. */
  fetched_at_ms: number;
  received: number | null;
  valid: number | null;
  invalid: number | null;
  last_received_at_ms: number | null;
  topic_counts: Record<string, number>;
  invalid_counts: Record<string, number>;
  topics: Record<string, RdfNodeTopic>;
  node: RdfNodeView;
}

export type GpsSourceMode = 'DATA_OUT' | 'MANUAL' | 'FALLBACK';
export type CompassSourceMode = 'DATA_OUT' | 'MANUAL' | 'FALLBACK';

export interface MapCoordinate {
  latitude: number;
  longitude: number;
  source: 'CSV' | 'XML' | 'DATA_OUT' | 'MANUAL' | 'FALLBACK' | 'SIMULATION';
}

export interface PolarSettings {
  figType: 'Polar' | 'Compass';
  compassOffset: number;
}

/** Local GPS source selection. It never writes to the remote node. */
export interface GpsConfig {
  source: GpsSourceMode;
  manualLatitude: number;
  manualLongitude: number;
}

/** Local Compass source selection. It only selects renderer settings. */
export interface CompassConfig {
  source: CompassSourceMode;
  manualFigType: PolarSettings['figType'];
  manualCompassOffset: number;
}

export interface GpsResolution {
  coordinate: MapCoordinate | null;
  selectedSource: GpsSourceMode;
  effectiveSource: Exclude<GpsSourceMode, 'DATA_OUT'> | 'DATA_OUT';
  label: string;
  detail: string;
}

export interface CompassResolution {
  settings: PolarSettings;
  selectedSource: CompassSourceMode;
  effectiveSource: Exclude<CompassSourceMode, 'DATA_OUT'> | 'DATA_OUT';
  label: string;
  detail: string;
}

/** Backward-compatible validated local coordinate payload. */
export interface ManualGpsOverride {
  enabled: boolean;
  latitude: number;
  longitude: number;
}

/** Backward-compatible renderer-only local axis/offset payload. */
export interface ManualCompassOverride {
  enabled: boolean;
  figType: PolarSettings['figType'];
  compassOffset: number;
}

export interface PolarView {
  settings: PolarSettings;
  values: number[] | null;
  canonicalAngle: number | null;
  fresh: boolean;
  peakIndex: number | null;
  peakValue: number | null;
  displayPeak: number | null;
  reason: string;
}
