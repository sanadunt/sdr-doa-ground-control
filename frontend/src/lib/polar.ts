import type { Candidate, CompassConfig, CompassResolution, ManualCompassOverride, PolarSettings, PolarView, TelemetrySnapshot } from '../types';
import { candidate, nativeViewsReady, numberOrNull, polarDataReady } from './telemetry';
import type { Translate } from './i18n';

export function polarSettings(figType: unknown, compassOffset: unknown): PolarSettings {
  const requested = String(figType ?? 'Polar').trim().toLowerCase();
  const safeType: PolarSettings['figType'] = requested === 'compass' ? 'Compass' : 'Polar';
  const numeric = finiteInput(compassOffset) ?? 0;
  return { figType: safeType, compassOffset: numeric };
}

export interface ManualCompassValidation {
  override: ManualCompassOverride | null;
  error: string | null;
}

function finiteInput(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validate the local renderer-only compass controls without touching telemetry. */
export function manualCompassOverrideFromInput(figTypeInput: unknown, compassOffsetInput: unknown): ManualCompassValidation {
  const requested = String(figTypeInput ?? '').trim().toLowerCase();
  if (requested !== 'polar' && requested !== 'compass') {
    return { override: null, error: 'Choose Polar or Compass for the local axis.' };
  }
  const compassOffset = finiteInput(compassOffsetInput);
  if (compassOffset === null) return { override: null, error: 'Compass offset must be a finite number.' };
  return {
    override: {
      enabled: true,
      figType: requested === 'compass' ? 'Compass' : 'Polar',
      compassOffset,
    },
    error: null,
  };
}

/** Return safe renderer settings for an enabled manual compass override. */
export const DEFAULT_COMPASS_CONFIG: CompassConfig = {
  source: 'DATA_OUT',
  manualFigType: 'Compass',
  manualCompassOffset: 0,
};

/** How long the last Data Out display settings stay usable when a read fails. */
export const DATA_OUT_SETTINGS_MAX_AGE_MS = 90_000;

/**
 * Display settings reported by one Data Out read. A field is null when the node
 * did not report a usable value: KrakenSDR's default `Linear` plot has no polar
 * axis, but its `compass_offset` still describes the array orientation.
 */
export interface DataOutCompassSettings {
  baseUrl: string | null;
  figType: PolarSettings['figType'] | null;
  compassOffset: number | null;
  observedAtMs: number | null;
}

export type CompassSourceCode =
  | 'DATA_OUT'
  | 'DATA_OUT_LOCAL_AXIS'
  | 'DATA_OUT_LOCAL_OFFSET'
  | 'DATA_OUT_UNAVAILABLE'
  | 'MANUAL'
  | 'FALLBACK';

export interface CompassSourceResolution extends CompassResolution {
  code: CompassSourceCode;
  /** The offset came from Data Out (current or last known) or from a manual entry. */
  offsetVerified: boolean;
  /** Age of reused Data Out settings when the current read had none; null otherwise. */
  lastKnownAgeMs: number | null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function snapshotBaseUrl(snapshot: TelemetrySnapshot | null | undefined): string | null {
  const baseUrl = recordOrNull(snapshot?.collector)?.base_url;
  return typeof baseUrl === 'string' && baseUrl.trim() ? baseUrl.trim() : null;
}

function nodeRestarted(snapshot: TelemetrySnapshot | null | undefined): boolean {
  const regressed = recordOrNull(snapshot?.node_progress)?.regressed_counters;
  return Array.isArray(regressed) && regressed.includes('uptime_ms');
}

/** Read the display settings of one live snapshot; simulation never counts as Data Out. */
export function dataOutCompassFromSnapshot(snapshot: TelemetrySnapshot | null | undefined): DataOutCompassSettings | null {
  if (!snapshot || snapshot.simulation === true || snapshot.status?.available !== true) return null;
  if (snapshot.settings?.available === false) return null;
  const fields = recordOrNull(snapshot.settings?.fields) ?? {};
  let figType: DataOutCompassSettings['figType'] = null;
  if (Object.prototype.hasOwnProperty.call(fields, 'doa_fig_type')) {
    const requested = String(fields.doa_fig_type ?? '').trim().toLowerCase();
    if (requested === 'polar') figType = 'Polar';
    if (requested === 'compass') figType = 'Compass';
  }
  const compassOffset = Object.prototype.hasOwnProperty.call(fields, 'compass_offset') ? finiteInput(fields.compass_offset) : null;
  if (figType === null && compassOffset === null) return null;
  return { baseUrl: snapshotBaseUrl(snapshot), figType, compassOffset, observedAtMs: numberOrNull(snapshot.observed_at_ms) };
}

/** Keep the latest usable Data Out display settings across reads that lack them. */
export function rememberDataOutCompass(
  previous: DataOutCompassSettings | null,
  snapshot: TelemetrySnapshot | null | undefined,
): DataOutCompassSettings | null {
  const current = dataOutCompassFromSnapshot(snapshot);
  if (current) return current;
  if (!previous || !snapshot || snapshot.simulation === true) return previous;
  const baseUrl = snapshotBaseUrl(snapshot);
  if ((baseUrl !== null && previous.baseUrl !== null && baseUrl !== previous.baseUrl) || nodeRestarted(snapshot)) return null;
  return previous;
}

function lastKnownAge(
  memory: DataOutCompassSettings | null,
  snapshot: TelemetrySnapshot | null | undefined,
  nowMs: number,
): number | null {
  if (!memory || memory.observedAtMs === null || nodeRestarted(snapshot)) return null;
  const baseUrl = snapshotBaseUrl(snapshot);
  if (baseUrl !== null && memory.baseUrl !== null && baseUrl !== memory.baseUrl) return null;
  const now = numberOrNull(snapshot?.observed_at_ms) ?? nowMs;
  const age = now - memory.observedAtMs;
  return Number.isFinite(age) && age >= 0 && age <= DATA_OUT_SETTINGS_MAX_AGE_MS ? age : null;
}

/**
 * Pick the renderer axis and compass offset. Data Out settings are validated
 * per field: a `Linear` (or unknown) plot type keeps the reported offset with
 * a local axis. When the current read has no usable settings, the last Data
 * Out settings of the same node are reused for a bounded time and labelled.
 */
export function resolveCompassSource(
  snapshot: TelemetrySnapshot | null | undefined,
  previousSettings: PolarSettings = { figType: 'Polar', compassOffset: 0 },
  config: CompassConfig = DEFAULT_COMPASS_CONFIG,
  memory: DataOutCompassSettings | null = null,
  nowMs: number = Date.now(),
): CompassSourceResolution {
  if (config.source === 'MANUAL') {
    const settings = manualCompassOverrideFromInput(config.manualFigType, config.manualCompassOffset).override;
    if (settings) {
      return {
        settings: { figType: settings.figType, compassOffset: settings.compassOffset },
        selectedSource: config.source,
        effectiveSource: 'MANUAL',
        label: 'MANUAL COMPASS',
        detail: 'Using local renderer settings; remote settings and telemetry remain untouched.',
        code: 'MANUAL',
        offsetVerified: true,
        lastKnownAgeMs: null,
      };
    }
  }
  if (config.source === 'FALLBACK') {
    return {
      settings: { figType: config.manualFigType, compassOffset: config.manualCompassOffset },
      selectedSource: config.source,
      effectiveSource: 'FALLBACK',
      label: 'DEFAULT FALLBACK',
      detail: 'Using the local renderer fallback; this is not a live Compass setting.',
      code: 'FALLBACK',
      offsetVerified: false,
      lastKnownAgeMs: null,
    };
  }
  const current = dataOutCompassFromSnapshot(snapshot);
  const age = current ? null : lastKnownAge(memory, snapshot, nowMs);
  const reported = current ?? (age !== null ? memory : null);
  if (reported) {
    const code: CompassSourceCode = reported.figType === null
      ? 'DATA_OUT_LOCAL_AXIS'
      : reported.compassOffset === null ? 'DATA_OUT_LOCAL_OFFSET' : 'DATA_OUT';
    const base = code === 'DATA_OUT_LOCAL_AXIS'
      ? 'DATA_OUT OFFSET · LOCAL AXIS'
      : code === 'DATA_OUT_LOCAL_OFFSET' ? 'DATA_OUT AXIS · LOCAL OFFSET' : 'DATA_OUT COMPASS';
    return {
      settings: {
        figType: reported.figType ?? previousSettings.figType,
        compassOffset: reported.compassOffset ?? previousSettings.compassOffset,
      },
      selectedSource: config.source,
      effectiveSource: 'DATA_OUT',
      label: age !== null ? `${base} · LAST KNOWN` : base,
      detail: age !== null
        ? 'This read had no usable Data Out display settings; reusing the last ones reported by this node.'
        : 'Using the renderer settings reported by Data Out.',
      code,
      offsetVerified: reported.compassOffset !== null,
      lastKnownAgeMs: age,
    };
  }
  return {
    settings: { figType: config.manualFigType, compassOffset: config.manualCompassOffset },
    selectedSource: config.source,
    effectiveSource: 'FALLBACK',
    label: 'DATA_OUT COMPASS · DEFAULT FALLBACK',
    detail: 'Data Out Compass settings are unavailable; using the configured local fallback.',
    code: 'DATA_OUT_UNAVAILABLE',
    offsetVerified: false,
    lastKnownAgeMs: null,
  };
}

/** Short source label for the compass offset in captions and the bearing readout. */
export function compassOffsetSourceLabel(resolution: CompassSourceResolution, t: Translate): string {
  if (!resolution.offsetVerified) return t('polar.offsetAssumed');
  const base = resolution.code === 'MANUAL' ? 'MANUAL' : resolution.code === 'DATA_OUT_LOCAL_AXIS' ? 'DATA_OUT · LOCAL AXIS' : 'DATA_OUT';
  if (resolution.lastKnownAgeMs === null) return base;
  return t('readout.sourceLastKnown', { source: base, age: `${Math.round(resolution.lastKnownAgeMs / 1000)} s` });
}

export function manualCompassSettings(override: ManualCompassOverride | null | undefined): PolarSettings | null {
  if (override?.enabled !== true) return null;
  if ((override.figType !== 'Polar' && override.figType !== 'Compass') || !Number.isFinite(override.compassOffset)) return null;
  return { figType: override.figType, compassOffset: override.compassOffset };
}

export function normalizeDegrees(degrees: number): number {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) return Number.NaN;
  return ((degrees % 360) + 360) % 360;
}

export function displayAngleForBin(bin: number, settings: PolarSettings): number {
  return normalizeDegrees(settings.figType === 'Compass' ? 360 - bin + settings.compassOffset : bin);
}

/**
 * Geographic bearing (degrees clockwise from north) for an upstream theta_0
 * array angle or angular bin. theta_0 runs counter-clockwise in the array
 * frame, so the map always applies the Compass conversion, independent of the
 * Polar/Compass choice for the polar plot.
 */
export function geographicBearingForBin(bin: number, compassOffset: number): number {
  return normalizeDegrees(360 - bin + (Number.isFinite(compassOffset) ? compassOffset : 0));
}

/** Geographic bearing of the view's canonical theta_0, or null when there is none. */
export function bearingForView(view: PolarView): number | null {
  return view.canonicalAngle === null ? null : geographicBearingForBin(view.canonicalAngle, view.settings.compassOffset);
}

/**
 * Plotly angular-axis direction. Compass labels run clockwise. Polar labels are
 * theta_0 and run counter-clockwise like the upstream KrakenSDR Polar plot, so
 * with offset 0 both modes put a bin at the same place on screen and differ
 * only in their labels.
 */
export function angularDirection(settings: PolarSettings): 'clockwise' | 'counterclockwise' {
  return settings.figType === 'Compass' ? 'clockwise' : 'counterclockwise';
}

/** Screen position of a bin in degrees clockwise from the top, before Head Up. */
export function screenAngleForBin(bin: number, settings: PolarSettings): number {
  return settings.figType === 'Compass' ? displayAngleForBin(bin, settings) : normalizeDegrees(360 - bin);
}

/** Round first, then wrap, so 359.96° reads 0.0° instead of 360.0°. */
export function formatDegrees(degrees: number, digits = 0): string {
  if (!Number.isFinite(degrees)) return 'N/A';
  return normalizeDegrees(Number(degrees.toFixed(digits))).toFixed(digits);
}

export function signedPeak(values: number[]): { index: number; value: number } | null {
  if (values.length !== 360 || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
  const numeric = values;
  // Source values are shifted dB. Preserve their sign and choose the greatest
  // signed value; do not apply abs() or a second log10() normalization.
  const value = Math.max(...numeric);
  return { index: numeric.indexOf(value), value };
}

export function polarView(
  snapshot: TelemetrySnapshot | null | undefined,
  previousSettings: PolarSettings = { figType: 'Polar', compassOffset: 0 },
  localFresh = true,
  manualCompassOverride: ManualCompassOverride | null | undefined = null,
  resolvedSettings: PolarSettings | null = null,
): PolarView {
  const settingsFields = snapshot?.settings?.fields ?? {};
  const liveSettings = polarSettings(
    Object.prototype.hasOwnProperty.call(settingsFields, 'doa_fig_type') ? settingsFields.doa_fig_type : previousSettings.figType,
    Object.prototype.hasOwnProperty.call(settingsFields, 'compass_offset') ? settingsFields.compass_offset : previousSettings.compassOffset,
  );
  const settings = resolvedSettings ?? manualCompassSettings(manualCompassOverride) ?? liveSettings;
  const csv = candidate(snapshot, 'csv');
  const canonicalAngle = numberOrNull(csv.canonical_angle_deg);
  const values = Array.isArray(csv.angular_power_db) && csv.angular_power_db.length === 360 && csv.angular_power_db.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? csv.angular_power_db
    : null;
  const fresh = localFresh && polarDataReady(snapshot) && canonicalAngle !== null && Boolean(values);
  if (!fresh || !values) {
    return {
      settings,
      values: null,
      canonicalAngle,
      fresh: false,
      peakIndex: null,
      peakValue: null,
      displayPeak: null,
      reason: 'Curve cleared: DoA data is stale, conflicting, or incomplete.',
    };
  }
  const peak = signedPeak(values);
  // Display metadata and canvas must derive the identical signed vector peak.
  const peakIndex = peak?.index ?? null;
  const peakValue = peak?.value ?? null;
  return {
    settings,
    values,
    canonicalAngle,
    fresh: true,
    peakIndex,
    peakValue,
    displayPeak: peakIndex === null ? null : displayAngleForBin(peakIndex, settings),
    reason: 'Data available; source vector preserved as shifted dB.',
  };
}

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Draw the local 360-bin renderer with 0° at the top. Compass labels run
 * clockwise; Polar labels are theta_0 and run counter-clockwise, as in the
 * Plotly renderer and the upstream KrakenSDR Polar plot.
 */
export function drawPolarCanvas(
  canvas: HTMLCanvasElement,
  values: number[] | null,
  fresh: boolean,
  settings: PolarSettings,
): void {
  const frame = canvas.closest('.polar-frame') ?? canvas.parentElement;
  if (!frame) return;
  const rect = frame.getBoundingClientRect();
  const cssSize = Math.max(1, Math.floor(rect.width || frame.clientWidth || 420));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.max(1, Math.floor(cssSize * dpr));
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size;
    canvas.height = size;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(size / cssSize, 0, 0, size / cssSize, 0, 0);
  context.clearRect(0, 0, cssSize, cssSize);

  const line = cssVar('--line', '#274766');
  const muted = cssVar('--muted', '#9ab0c7');
  const subtle = cssVar('--subtle', '#68819e');
  const accent = cssVar('--accent', '#35d8c4');
  const blue = cssVar('--blue', '#76a9ff');
  const cx = cssSize / 2;
  const cy = cssSize / 2;
  const maxRadius = cssSize * 0.365;
  const radiansFor = (degrees: number) => (degrees - 90) * Math.PI / 180;

  context.save();
  context.translate(cx, cy);
  context.lineWidth = 1;
  context.strokeStyle = line;
  context.globalAlpha = 0.92;
  [0.25, 0.5, 0.75, 1].forEach((factor) => {
    context.beginPath();
    context.arc(0, 0, maxRadius * factor, 0, Math.PI * 2);
    context.stroke();
  });
  for (let degrees = 0; degrees < 360; degrees += 45) {
    const radians = radiansFor(degrees);
    context.beginPath();
    context.moveTo(0, 0);
    context.lineTo(Math.cos(radians) * maxRadius, Math.sin(radians) * maxRadius);
    context.stroke();
  }

  context.globalAlpha = 1;
  context.fillStyle = muted;
  context.font = '700 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const perimeterInset = Math.max(9, cssSize * 0.035);
  const cardinalRadius = Math.min(maxRadius + Math.min(23, Math.max(15, cssSize * 0.06)), cssSize / 2 - perimeterInset);
  const degreeRadius = Math.min(maxRadius + Math.min(18, Math.max(12, cssSize * 0.045)), cssSize / 2 - perimeterInset);
  const compass = settings.figType === 'Compass';
  // Polar labels are theta_0 values; label a sits at 360 - a clockwise from the top.
  const labelPosition = (label: number) => (compass ? label : normalizeDegrees(360 - label));
  const cardinalLabels: ReadonlyArray<readonly [string, number]> = compass
    ? [['N', 0], ['E', 90], ['S', 180], ['W', 270]]
    : [['0°', 0], ['90°', 90], ['180°', 180], ['270°', 270]];
  for (const [label, degrees] of cardinalLabels) {
    const radians = radiansFor(labelPosition(degrees));
    context.fillText(label, Math.cos(radians) * cardinalRadius, Math.sin(radians) * cardinalRadius);
  }
  context.fillStyle = subtle;
  context.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
  const diagonalDegrees = new Set([45, 135, 225, 315]);
  for (let degrees = 0; degrees < 360; degrees += 45) {
    const radians = radiansFor(degrees);
    context.beginPath();
    context.moveTo(Math.cos(radians) * maxRadius, Math.sin(radians) * maxRadius);
    context.lineTo(Math.cos(radians) * (maxRadius + 6), Math.sin(radians) * (maxRadius + 6));
    context.stroke();
    if (diagonalDegrees.has(degrees)) {
      const labelRadians = radiansFor(labelPosition(degrees));
      context.fillText(`${degrees}°`, Math.cos(labelRadians) * degreeRadius, Math.sin(labelRadians) * degreeRadius);
    }
  }

  const finite = Array.isArray(values) && values.length === 360 && values.every((value) => typeof value === 'number' && Number.isFinite(value)) ? values : null;
  const validData = Boolean(fresh && finite);
  if (validData && finite) {
    // This is intentionally a source-shifted dB range. No abs/log10 pass.
    const floor = Math.min(...finite);
    const peakValue = Math.max(...finite);
    const span = peakValue - floor;
    const yFor = (value: number) => span > 0 ? Math.max(0, Math.min(1, (value - floor) / span)) : 1;
    context.textAlign = 'left';
    context.fillStyle = subtle;
    context.font = '9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
    const precision = span < 5 ? 1 : 0;
    [0.25, 0.5, 0.75, 1].forEach((factor) => {
      const label = `${(floor + span * factor).toFixed(precision)} dB`;
      const radialLabelY = -maxRadius + maxRadius * 2 * factor;
      const labelWidth = context.measureText(label).width;
      const rightEdge = Math.max(0, cssSize / 2 - 4);
      const radialLabelX = Math.min(maxRadius + 8, rightEdge - labelWidth);
      context.fillText(label, radialLabelX, radialLabelY);
    });
    const point = (value: number, index: number): [number, number] => {
      const radians = radiansFor(screenAngleForBin(index, settings));
      const radius = maxRadius * yFor(value);
      return [Math.cos(radians) * radius, Math.sin(radians) * radius];
    };
    const drawCurve = () => {
      finite.forEach((value, index) => {
        const [x, y] = point(value, index);
        if (index) context.lineTo(x, y); else context.moveTo(x, y);
      });
      const [x0, y0] = point(finite[0], 0);
      context.lineTo(x0, y0);
    };
    context.beginPath();
    drawCurve();
    context.closePath();
    context.fillStyle = cssVar('--plot-fill', 'rgba(229,180,91,.12)');
    context.fill();
    context.beginPath();
    drawCurve();
    context.closePath();
    context.strokeStyle = accent;
    context.lineWidth = 2;
    context.shadowColor = 'transparent';
    context.shadowBlur = 8;
    context.stroke();

    const peak = signedPeak(finite);
    if (peak) {
      const displayPeak = displayAngleForBin(peak.index, settings);
      const peakScreen = screenAngleForBin(peak.index, settings);
      const [px, py] = point(finite[peak.index], peak.index);
      context.shadowBlur = 0;
      context.fillStyle = accent;
      context.beginPath();
      context.arc(px, py, 3.5, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = blue;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(px, py);
      context.lineTo(Math.cos(radiansFor(peakScreen)) * (maxRadius + 12), Math.sin(radiansFor(peakScreen)) * (maxRadius + 12));
      context.stroke();
      context.fillStyle = accent;
      context.font = '700 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      context.textAlign = 'center';
      context.fillText(`PLOT ${formatDegrees(displayPeak)}°`, px, py < -maxRadius * 0.45 ? py + 15 : py - 11);
    }
  }
  context.restore();
}

export function polarMetadata(view: PolarView): {
  peak: string;
  canonical: string;
  peakDb: string;
  bins: string;
} {
  return {
    peak: view.displayPeak === null || view.peakIndex === null ? 'N/A' : `${formatDegrees(view.displayPeak)}° · bin ${view.peakIndex}`,
    canonical: view.canonicalAngle === null ? 'N/A' : `${formatDegrees(view.canonicalAngle, 1)}° · θ₀`,
    peakDb: view.peakValue === null ? 'N/A' : `${view.peakValue.toFixed(1)} dB`,
    bins: view.fresh ? '360' : 'N/A',
  };
}

export function polarSourceLabel(snapshot: TelemetrySnapshot | null | undefined, view: PolarView): string {
  const csv = candidate(snapshot, 'csv');
  if (!nativeViewsReady(snapshot) || !view.fresh) return 'Data Out · unavailable';
  const age = csv.freshness?.age_ms;
  return `Data Out · ${view.settings.figType} display axis · ${age === null || age === undefined ? 'clock unverified' : `${(age / 1000).toFixed(1)} s`}`;
}

export function canonicalLabel(view: PolarView): string {
  return view.canonicalAngle === null ? 'N/A°' : `${formatDegrees(view.canonicalAngle, 1)}°`;
}

export function displayLabel(view: PolarView): string {
  return view.displayPeak === null ? 'plot peak · display N/A°' : `plot peak · display ${formatDegrees(view.displayPeak)}° · bin ${view.peakIndex ?? 'N/A'}`;
}
