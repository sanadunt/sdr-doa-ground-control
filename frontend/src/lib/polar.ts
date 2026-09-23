import type { Candidate, CompassConfig, CompassResolution, ManualCompassOverride, PolarSettings, PolarView, TelemetrySnapshot } from '../types';
import { candidate, nativeViewsReady, numberOrNull, polarDataReady } from './telemetry';

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

function compassSettingsFromSnapshot(snapshot: TelemetrySnapshot | null | undefined, previousSettings: PolarSettings): PolarSettings {
  const settingsFields = snapshot?.settings?.fields ?? {};
  return polarSettings(
    Object.prototype.hasOwnProperty.call(settingsFields, 'doa_fig_type') ? settingsFields.doa_fig_type : previousSettings.figType,
    Object.prototype.hasOwnProperty.call(settingsFields, 'compass_offset') ? settingsFields.compass_offset : previousSettings.compassOffset,
  );
}

function hasUsableDataOutCompassSettings(snapshot: TelemetrySnapshot | null | undefined): boolean {
  if (!snapshot || snapshot.status?.available !== true) return false;
  const fields = snapshot.settings?.fields ?? {};
  const hasFigType = Object.prototype.hasOwnProperty.call(fields, 'doa_fig_type');
  const hasOffset = Object.prototype.hasOwnProperty.call(fields, 'compass_offset');
  if (!hasFigType && !hasOffset) return false;
  if (hasFigType) {
    const requested = String(fields.doa_fig_type ?? '').trim().toLowerCase();
    if (requested !== 'polar' && requested !== 'compass') return false;
  }
  if (hasOffset && finiteInput(fields.compass_offset) === null) return false;
  return true;
}

export function resolveCompassSource(
  snapshot: TelemetrySnapshot | null | undefined,
  previousSettings: PolarSettings = { figType: 'Polar', compassOffset: 0 },
  config: CompassConfig = DEFAULT_COMPASS_CONFIG,
): CompassResolution {
  if (config.source === 'MANUAL') {
    const settings = manualCompassOverrideFromInput(config.manualFigType, config.manualCompassOffset).override;
    if (settings) {
      return {
        settings: { figType: settings.figType, compassOffset: settings.compassOffset },
        selectedSource: config.source,
        effectiveSource: 'MANUAL',
        label: 'MANUAL COMPASS',
        detail: 'Using local renderer settings; remote settings and telemetry remain untouched.',
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
    };
  }
  const dataOutSettings = compassSettingsFromSnapshot(snapshot, previousSettings);
  if (hasUsableDataOutCompassSettings(snapshot)) {
    return {
      settings: dataOutSettings,
      selectedSource: config.source,
      effectiveSource: 'DATA_OUT',
      label: 'DATA_OUT COMPASS',
      detail: 'Using the renderer settings reported by Data Out.',
    };
  }
  return {
    settings: { figType: config.manualFigType, compassOffset: config.manualCompassOffset },
    selectedSource: config.source,
    effectiveSource: 'FALLBACK',
    label: 'DATA_OUT COMPASS · DEFAULT FALLBACK',
    detail: 'Data Out Compass settings are unavailable; using the configured local fallback.',
  };
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

/** Draw the local 360-bin renderer: 0° at top, clockwise orientation. */
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
  const cardinalLabels: ReadonlyArray<readonly [string, number]> = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
  for (const [label, degrees] of cardinalLabels) {
    const radians = radiansFor(degrees);
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
      context.fillText(`${degrees}°`, Math.cos(radians) * degreeRadius, Math.sin(radians) * degreeRadius);
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
      const radians = radiansFor(displayAngleForBin(index, settings));
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
      context.lineTo(Math.cos(radiansFor(displayPeak)) * (maxRadius + 12), Math.sin(radiansFor(displayPeak)) * (maxRadius + 12));
      context.stroke();
      context.fillStyle = accent;
      context.font = '700 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
      context.textAlign = 'center';
      context.fillText(`PLOT ${displayPeak.toFixed(0)}°`, px, py < -maxRadius * 0.45 ? py + 15 : py - 11);
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
    peak: view.displayPeak === null || view.peakIndex === null ? '—' : `${view.displayPeak.toFixed(0)}° · bin ${view.peakIndex}`,
    canonical: view.canonicalAngle === null ? '—' : `${view.canonicalAngle.toFixed(1)}° · θ₀`,
    peakDb: view.peakValue === null ? '—' : `${view.peakValue.toFixed(1)} dB`,
    bins: view.fresh ? '360' : '—',
  };
}

export function polarSourceLabel(snapshot: TelemetrySnapshot | null | undefined, view: PolarView): string {
  const csv = candidate(snapshot, 'csv');
  if (!nativeViewsReady(snapshot) || !view.fresh) return 'Data Out · unavailable';
  const age = csv.freshness?.age_ms;
  return `Data Out · ${view.settings.figType} display axis · ${age === null || age === undefined ? 'clock unverified' : `${(age / 1000).toFixed(1)} s`}`;
}

export function canonicalLabel(view: PolarView): string {
  return view.canonicalAngle === null ? '—°' : `${view.canonicalAngle.toFixed(1)}°`;
}

export function displayLabel(view: PolarView): string {
  return view.displayPeak === null ? 'plot peak · display —°' : `plot peak · display ${view.displayPeak.toFixed(0)}° · bin ${view.peakIndex ?? '—'}`;
}
