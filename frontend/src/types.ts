export type DataState =
  | 'LOADING'
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'STALE'
  | 'CONFLICT'
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

export interface TelemetrySnapshot {
  [key: string]: unknown;
  schema_version?: number;
  collector?: Record<string, unknown>;
  observed_at_ms?: number;
  status?: StatusSnapshot;
  settings?: SettingsSnapshot;
  doa_candidates?: Record<string, Candidate>;
  native_consistency?: NativeConsistency;
  authority?: AuthoritySnapshot;
  publication_gate?: PublicationGate;
  overall_state?: string;
}

export interface ConsoleConfig {
  version?: number;
  base_url: string;
  mqtt_host: string;
  mqtt_port: number;
  mqtt_transport: 'tcp' | 'websockets';
  mqtt_ws_path: string;
  mqtt_username: string;
  mqtt_password_set: boolean;
  refresh_seconds: number;
  rdf_node_id: string;
}

export interface Branding {
  app_name: string;
  logo_data_url: string;
}

export interface MqttEntry {
  [key: string]: unknown;
  topic?: string;
  kind?: string;
  received_at_ms?: number;
  bytes?: number;
  qos?: number;
  retained?: boolean;
  valid?: boolean;
  latency_ms?: number | null;
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
  root?: string;
  connection?: string;
  last_error?: string | null;
  received?: number;
  valid?: number;
  invalid?: number;
  total_bytes?: number;
  last_received_at_ms?: number | null;
  last_age_ms?: number | null;
  last_latency_ms?: number | null;
  last_topic?: string | null;
  last_by_kind?: Record<string, MqttEntry>;
  topic_counts?: Record<string, number>;
}

export const RDF_NODE_MQTT_TOPICS = [
  'telemetry/doa',
  'telemetry/diagnostic/doa',
  'telemetry/diagnostic/angular',
  'telemetry/health',
  'telemetry/health/detail',
  'telemetry/angular',
  'state',
  'capabilities',
  'config/reported',
  'availability',
  'ack/config',
  'ack/operation',
] as const;

export type RdfNodeMqttTopic = typeof RDF_NODE_MQTT_TOPICS[number];
export type RdfNodeMqttConnection = 'disabled' | 'connecting' | 'ready' | 'disconnected' | 'error';
export type RdfNodeMqttTopicStatus =
  | 'UNAVAILABLE'
  | 'CONTEXT'
  | 'FRESH'
  | 'STALE'
  | 'INVALID'
  | 'INCONSISTENT';

export interface RdfNodeMqttAngularFrame {
  encoding: 'q16' | 'u8';
  sid: number;
  q: number;
  timestamp_ms: number;
  frequency_hz: number;
  revision: number | null;
  vfo: number;
  convention: number;
  raw_doa_deg: number | null;
  confidence_native_db: number | null;
  values: number[];
}

export interface RdfNodeMqttDiagnosticDoa {
  v: 2;
  sid: string;
  q: number;
  source: 'doa.xml';
  source_timestamp_ms: number;
  observed_timestamp_ms: number;
  raw_doa_deg: number;
  frequency_mhz: number;
  trust: 'UNVERIFIED';
  validation_reasons: string[];
}

export interface RdfNodeMqttDiagnosticAngularFrame {
  encoding: 'q16' | 'u8';
  sid: number;
  q: number;
  source_timestamp_ms: number;
  frequency_hz: number;
  revision: number | null;
  vfo: number;
  convention: number;
  raw_doa_deg: number | null;
  confidence_native_db: number | null;
  flags: number;
  trust: 'UNVERIFIED';
  validation_reasons: string[];
  values: number[];
}

export type RdfNodeMqttDiagnosticAngularStatus = 'UNAVAILABLE' | 'FRESH' | 'STALE' | 'INVALID';

export interface RdfNodeMqttDiagnosticAngularLatest {
  enabled: boolean;
  connection: RdfNodeMqttConnection;
  node_id: string;
  status: RdfNodeMqttDiagnosticAngularStatus;
  stale: boolean;
  trust: 'UNVERIFIED' | null;
  encoding: 'q16' | 'u8' | null;
  source_timestamp_ms: number | null;
  source_age_ms: number | null;
  received_age_ms: number | null;
  flags: number | null;
  validation_reasons: string[];
  values: number[] | null;
  error: string | null;
}

export interface RdfNodeMqttObservation {
  status: RdfNodeMqttTopicStatus;
  received_at_ms: number | null;
  qos: 0 | 1 | null;
  retained: boolean | null;
  payload: Record<string, unknown>
    | RdfNodeMqttAngularFrame
    | RdfNodeMqttDiagnosticDoa
    | RdfNodeMqttDiagnosticAngularFrame
    | null;
  candidate_payload: Record<string, unknown> | null;
  error: string | null;
}

export interface RdfNodeMqttSnapshot {
  enabled: boolean;
  connection: RdfNodeMqttConnection;
  node_id: string;
  last_error: string | null;
  received: number;
  valid: number;
  invalid: number;
  last_received_at_ms: number | null;
  topic_counts: Record<RdfNodeMqttTopic, number>;
  topics: Record<RdfNodeMqttTopic, RdfNodeMqttObservation>;
}

export interface SystemHealthSnapshot {
  checked_at_ms: number;
  usb_telemetry: 'PRESENT' | 'NOT_FOUND' | 'AMBIGUOUS' | 'UNKNOWN';
  ppp_interface: 'UP' | 'DOWN' | 'UNKNOWN';
  raspberry_peer: 'REACHABLE' | 'NO_REPLY' | 'NOT_PROBED' | 'UNKNOWN';
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
