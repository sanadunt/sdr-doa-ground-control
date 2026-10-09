import assert from 'node:assert/strict';
import { test } from 'node:test';

const {
  assignLabelLanes,
  buildMarkerReadout,
  formatDeltaDb,
  formatDeltaFrequency,
  markerColor,
  nearestMarkerWithin,
  peakInRange,
  traceLevelAt,
} = await import('./browsdr_receiver_overlay/src/client/app/marker-readout.ts');

const frame = {
  startHz: 100_000_000,
  endHz: 110_000_000,
  resolutionHz: 1_000_000,
  sweepCount: 3,
  current: Float32Array.from([-90, -80, -30, -85, -90, -90, -40, -90, -90, -90]),
  average: Float32Array.from([-90, -82, -35, -86, -90, -90, -45, -90, -90, -90]),
  maxHold: Float32Array.from([-80, -70, -20, -75, -80, -80, -30, -80, -80, -80]),
};

const markers = [
  { id: 'a', frequencyHz: 102_500_000, powerDb: -33, label: 'Uplink' },
  { id: 'b', frequencyHz: 106_500_000, powerDb: null, label: 'Downlink' },
  { id: 'c', frequencyHz: 120_000_000, powerDb: -50, label: 'Out of band' },
];

test('trace level follows the bin under the frequency and rejects out-of-band input', () => {
  assert.equal(traceLevelAt(frame.current, frame.startHz, frame.endHz, 102_500_000), -30);
  assert.equal(traceLevelAt(frame.current, frame.startHz, frame.endHz, 110_000_000), -90);
  assert.equal(traceLevelAt(frame.current, frame.startHz, frame.endHz, 99_999_999), null);
  assert.equal(traceLevelAt(Float32Array.from([NaN]), 0, 1, 0.5), null);
});

test('readout reports live levels and deltas against the first marker by default', () => {
  const rows = buildMarkerReadout(markers, frame, 'current', null);
  assert.deepEqual(rows.map(row => row.name), ['M1', 'M2', 'M3']);
  assert.equal(rows[0].isReference, true);
  assert.equal(rows[0].deltaHz, null);
  assert.equal(rows[1].liveDb, -40);
  assert.equal(rows[1].deltaHz, 4_000_000);
  assert.equal(rows[1].deltaDb, -10);
  assert.equal(rows[1].savedDb, null);
  assert.equal(rows[2].liveDb, null, 'a marker outside the scanned band has no live level');
  assert.equal(rows[2].deltaDb, null);
});

test('readout uses the chosen reference marker and trace view', () => {
  const rows = buildMarkerReadout(markers, frame, 'max', 'b');
  assert.equal(rows[1].isReference, true);
  assert.equal(rows[0].deltaHz, -4_000_000);
  assert.equal(rows[0].deltaDb, 10);
});

test('readout without a frame keeps saved levels and leaves live values empty', () => {
  const rows = buildMarkerReadout(markers, null, 'average', null);
  assert.equal(rows[0].savedDb, -33);
  assert.equal(rows[0].liveDb, null);
  assert.equal(rows[1].deltaDb, null);
});

test('peak search returns the strongest bin inside the visible range', () => {
  assert.deepEqual(peakInRange(frame.current, frame.startHz, frame.endHz, frame.startHz, frame.endHz), { frequencyHz: 102_500_000, powerDb: -30 });
  assert.deepEqual(peakInRange(frame.current, frame.startHz, frame.endHz, 105_000_000, 110_000_000), { frequencyHz: 106_500_000, powerDb: -40 });
  assert.equal(peakInRange(frame.current, frame.startHz, frame.endHz, 200_000_000, 300_000_000), null);
});

test('nearest marker selection respects the tolerance', () => {
  assert.equal(nearestMarkerWithin(markers, 102_600_000, 200_000)?.id, 'a');
  assert.equal(nearestMarkerWithin(markers, 104_000_000, 200_000), null);
});

test('label lanes avoid overlap and report labels that do not fit', () => {
  assert.deepEqual(assignLabelLanes([{ x: 0, width: 50 }, { x: 20, width: 50 }, { x: 100, width: 50 }], 2), [0, 1, 0]);
  assert.deepEqual(assignLabelLanes([{ x: 0, width: 50 }, { x: 10, width: 50 }, { x: 20, width: 50 }], 2), [0, 1, -1]);
});

test('formatting keeps sign and unit explicit', () => {
  assert.equal(formatDeltaFrequency(4_000_000), '+4.000000 MHz');
  assert.equal(formatDeltaFrequency(-12_500), '−12.500 kHz');
  assert.equal(formatDeltaFrequency(0), '±0 Hz');
  assert.equal(formatDeltaDb(-10), '−10.0 dB');
  assert.equal(formatDeltaDb(3.25), '+3.3 dB');
});

test('marker colours cycle through eight hues per theme', () => {
  assert.equal(markerColor(0), markerColor(8));
  assert.notEqual(markerColor(0), markerColor(1));
  assert.notEqual(markerColor(0, true), markerColor(0, false));
});
