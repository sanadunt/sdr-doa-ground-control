import type { SweepCandidate } from '../worker/sweep-types';

export interface SweepCandidateBand extends SweepCandidate {
	peakRangeStartHz: number;
	peakRangeEndHz: number;
	peakRangeCenterHz: number;
}

function strongerRepresentative(a: SweepCandidate, b: SweepCandidate): SweepCandidate {
	if (a.peakDb !== b.peakDb) return a.peakDb > b.peakDb ? a : b;
	if (a.peakFrequencyHz !== b.peakFrequencyHz) return a.peakFrequencyHz < b.peakFrequencyHz ? a : b;
	return a.id <= b.id ? a : b;
}

function toBand(members: SweepCandidate[]): SweepCandidateBand {
	let representative = members[0];
	let id = members[0].id;
	let peakRangeStartHz = members[0].peakFrequencyHz;
	let peakRangeEndHz = members[0].peakFrequencyHz;
	for (const member of members) {
		representative = strongerRepresentative(representative, member);
		id = Math.min(id, member.id);
		peakRangeStartHz = Math.min(peakRangeStartHz, member.peakFrequencyHz);
		peakRangeEndHz = Math.max(peakRangeEndHz, member.peakFrequencyHz);
	}
	return {
		...representative,
		id,
		peakRangeStartHz,
		peakRangeEndHz,
		peakRangeCenterHz: peakRangeStartHz + (peakRangeEndHz - peakRangeStartHz) / 2,
	};
}

// Rows group candidates whose occupied bands overlap or touch. Peaks are never
// chained by distance, so separate carriers keep separate rows. The archive
// query in tools/receiver_record_store.py applies the same rule.
export function groupAdjacentCandidates(candidates: SweepCandidate[]): SweepCandidateBand[] {
	const ordered = candidates.slice().sort((a, b) => a.startHz - b.startHz || a.id - b.id);
	const bands: SweepCandidateBand[] = [];
	let members: SweepCandidate[] = [];
	let runningEndHz = Number.NEGATIVE_INFINITY;
	for (const candidate of ordered) {
		if (members.length > 0 && candidate.startHz > runningEndHz) {
			bands.push(toBand(members));
			members = [];
		}
		members.push(candidate);
		runningEndHz = members.length === 1 ? candidate.endHz : Math.max(runningEndHz, candidate.endHz);
	}
	if (members.length > 0) bands.push(toBand(members));
	return bands;
}

// A selected row is a peak group. Updates replace the group objects, so the
// selection follows the group that now holds the same identity or peak range and
// is never swapped for one of its raw member candidates.
export function reselectCandidateBand(previous: SweepCandidate | null, rows: SweepCandidate[]): SweepCandidate | null {
	if (!previous) return null;
	const startHz = previous.peakRangeStartHz ?? previous.peakFrequencyHz;
	const endHz = previous.peakRangeEndHz ?? previous.peakFrequencyHz;
	return rows.find(row => row.id === previous.id)
		?? rows.find(row => (row.peakRangeStartHz ?? row.peakFrequencyHz) <= endHz
			&& (row.peakRangeEndHz ?? row.peakFrequencyHz) >= startHz)
		?? null;
}
