import type { SweepCandidate } from '../worker/sweep-types';

export const PEAK_GROUP_ADJACENCY_HZ = 100_000;

export interface SweepCandidateBand extends SweepCandidate {
	peakRangeStartHz: number;
	peakRangeEndHz: number;
	peakRangeCenterHz: number;
}

export function groupAdjacentCandidates(candidates: SweepCandidate[]): SweepCandidateBand[] {
	const ordered = candidates.slice().sort((a, b) => a.peakFrequencyHz - b.peakFrequencyHz || a.id - b.id);
	const bands: SweepCandidateBand[] = [];

	for (const candidate of ordered) {
		const current = bands[bands.length - 1];
		if (!current || candidate.peakFrequencyHz - current.peakRangeEndHz > PEAK_GROUP_ADJACENCY_HZ) {
			bands.push({
				...candidate,
				peakRangeStartHz: candidate.peakFrequencyHz,
				peakRangeEndHz: candidate.peakFrequencyHz,
				peakRangeCenterHz: candidate.peakFrequencyHz,
			});
			continue;
		}

		const peakRangeStartHz = Math.min(current.peakRangeStartHz, candidate.peakFrequencyHz);
		const peakRangeEndHz = Math.max(current.peakRangeEndHz, candidate.peakFrequencyHz);
		const representative = candidate.peakDb > current.peakDb ? candidate : current;
		bands[bands.length - 1] = {
			...representative,
			id: Math.min(current.id, candidate.id),
			peakRangeStartHz,
			peakRangeEndHz,
			peakRangeCenterHz: peakRangeStartHz + (peakRangeEndHz - peakRangeStartHz) / 2,
		};
	}

	return bands;
}
