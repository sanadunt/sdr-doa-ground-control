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
}

export interface ResourceInfo {
  [key: string]: unknown;
  ok?: boolean;
  http_status?: number;
  error?: string;
  error_kind?: string;
}

export interface TelemetrySnapshot {
  [key: string]: unknown;
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

/** Latest v1 message of one kind, after lib/mqttMonitor normalization. */
export interface MqttEntry {
  [key: string]: unknown;
  kind?: string;
  /** Server clock when the console received it. */
  received_at_ms?: number;
  /** Server-side receive age at snapshot time. */
  age_ms?: number | null;
  /** The payload's own ts_ms (edge clock). */
  source_ts_ms?: number | null;
  bytes?: number;
  qos?: number;
  /** True only for a broker replay from the retained store. */
  retained?: boolean;
  /** Decoded against the v1 contract (not the payload's own flags). */
  valid?: boolean;
  /** Zero-length publish: the retained value was removed. */
  cleared?: boolean;
  /** The payload's own boolean flags: valid, doa_valid, settings_valid. */
  validity_flags?: Record<string, boolean>;
  /** Payload source marker, e.g. "synthetic". */
  source?: string;
  latency_ms?: number | null;
  /** Sanitized payload: identifiers and secrets are redacted. */
  payload?: unknown;
  error?: string;
}

export interface MqttSnapshot {
  [key: string]: unknown;
  enabled?: boolean;
  read_only?: boolean;
  publish_enabled?: boolean;
  host?: string;
  port?: number;
  transport?: MqttTransport;
  ws_path?: string;
  connection?: string;
  last_error?: string | null;
  /** Server clock when the snapshot was taken. */
  now_ms?: number;
  /** Browser clock when the snapshot was read; set by the API adapter for local ageing. */
  fetched_at_ms?: number;
  received?: number;
  valid?: number;
  invalid?: number;
  cleared?: number;
  total_bytes?: number;
  last_received_at_ms?: number | null;
  last_age_ms?: number | null;
  last_latency_ms?: number | null;
  last_topic?: string | null;
  last_by_kind?: Record<string, MqttEntry>;
  kind_counts?: Record<string, number>;
}

/** One RDF Node v2 topic as reported by /api/mqtt/rdf-node, normalized. */
export interface RdfNodeTopic {
  status: string;
  received_at_ms: number | null;
  qos: number | null;
  retained: boolean | null;
  error: string | null;
  /** A zero-length retained publish removed the broker's value. */
  cleared: boolean;
  /** Bounded, sanitized fields only; the 360-bin angular values are dropped. */
  payload: Record<string, unknown> | null;
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
  topics: Record<string, RdfNodeTopic>;
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
