import type { AppInstance, Bookmark, Vfo } from './types';
import { BOOKMARK_CATEGORIES } from './constants';
import type { SweepCandidate } from '../worker/sweep-types';
import { groupAdjacentCandidates, type SweepCandidateBand } from './candidate-bands';
import type { ReceiverMarker } from './receiver-records-api';
import { sweepMarkerPositionRatio } from './sweep-marker-renderer';
import { markerName } from './marker-readout';

interface VisibleWaterfallMarker {
	marker: ReceiverMarker;
	name: string;
	/** Index into the eight marker colours, matching the spectrum chart. */
	tone: number;
	label: string;
	frequencyText: string;
	positionPercent: number;
	pinTopPx: number;
	connectorHeightPx: number;
	tooltipAlignRight: boolean;
}

function locallyFilteredCandidates(app: AppInstance): SweepCandidateBand[] {
	const threshold = Number(app.sweep.minimumPeakDb);
	let candidates = (app.sweep.candidates as SweepCandidate[])
		.filter(candidate => candidate.peakDb >= (Number.isFinite(threshold) ? threshold : -160));
	if (app.records?.markedOnly) {
		const markers = (app.records.markers || []) as Array<{ frequencyHz: number }>;
		candidates = candidates.filter(candidate => markers.some(marker =>
			marker.frequencyHz >= candidate.startHz - 50_000 && marker.frequencyHz <= candidate.endHz + 50_000));
	}
	const bands = groupAdjacentCandidates(candidates);
	switch (app.sweep.sortBy) {
		case 'frequency':
			return bands.sort((a, b) => a.peakRangeCenterHz - b.peakRangeCenterHz || a.id - b.id);
		case 'peak':
			return bands.sort((a, b) => b.peakDb - a.peakDb);
		case 'hits':
			return bands.sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen);
		case 'lastSeen':
			return bands.sort((a, b) => b.lastSeen - a.lastSeen);
		default:
			return bands.sort((a, b) => b.snrDb - a.snrDb);
	}
}

export const computedProperties = {
	isLocal(this: AppInstance) {
		const host = window.location.hostname;
		return host === 'localhost' || host === '127.0.0.1';
	},
	activeAudioVfos(this: AppInstance) {
		const active: Array<{ index: number; vfo: Vfo }> = [];
		for (let i = 0; i < this.vfos.length; i++) {
			const vfo = this.vfos[i];
			if (vfo.enabled) {
				if (!vfo.squelchEnabled || this.vfoSquelchOpen[i]) {
					active.push({ index: i, vfo });
				}
			}
		}
		return active;
	},
	// VFOs with squelch enabled, sorted by total squelch-open time (most active first)
	sortedVfoActivity(this: AppInstance) {
		const now = this.activityNow || Date.now();
		type ActivityItem = { index: number; vfo: Vfo; count: number; totalMs: number; isLive: boolean; pct?: number };
		const vfos = this.vfos as Vfo[];
		const items: ActivityItem[] = vfos.map((vfo, i) => {
			if (!vfo.squelchEnabled) return null;
			const stat = this.vfoActivityStats[i] || { count: 0, totalMs: 0, squelchOpenSince: null };
			const liveMs = stat.squelchOpenSince ? (now - stat.squelchOpenSince) : 0;
			const totalMs = stat.totalMs + liveMs;
			return { index: i, vfo, count: stat.count, totalMs, isLive: !!stat.squelchOpenSince };
		}).filter((item): item is ActivityItem => item !== null);
		items.sort((a, b) => b.totalMs - a.totalMs);
		const maxMs = items[0]?.totalMs || 1;
		return items.map(item => ({ ...item, pct: (item.totalMs / maxMs) * 100 }));
	},
	// Individual bookmarks grouped by category; group bookmarks as a flat sorted list
	bookmarkGroupsByCategory(this: AppInstance) {
		const search = (this.bookmarkSearch || '').toLowerCase().trim();
		const all = (this.bookmarks as Bookmark[]).map((bm, i) => ({ bm, i }));
		const filtered = search
			? all.filter(({ bm }) =>
				(bm.name || '').toLowerCase().includes(search) ||
				String(bm.freq || bm.centerFreq || '').includes(search)
			)
			: all;
		const flatGroups = filtered
			.filter(({ bm }) => (bm.type || 'group') === 'group')
			.sort((a, b) => (a.bm.centerFreq || 0) - (b.bm.centerFreq || 0));
		const cats: Record<string, Array<{ bm: Bookmark; i: number }>> = {};
		for (const entry of filtered) {
			if ((entry.bm.type || 'group') !== 'individual') continue;
			const cat = entry.bm.category || '';
			if (!cats[cat]) cats[cat] = [];
			cats[cat].push(entry);
		}
		for (const arr of Object.values(cats)) {
			arr.sort((a, b) => (a.bm.freq || 0) - (b.bm.freq || 0));
		}
		const categories = Object.keys(cats)
			.map(key => ({
				key,
				collKey: 'bm:' + (key || '__uncategorised__'),
				label: BOOKMARK_CATEGORIES.find(c => c.value === key)?.label || 'Uncategorised',
				items: cats[key],
			}))
			.sort((a, b) => {
				if (a.key === '' && b.key !== '') return 1;
				if (a.key !== '' && b.key === '') return -1;
				return a.label.localeCompare(b.label);
			});
		return { categories, flatGroups };
	},
	minFreq(this: AppInstance) {
		const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
		const baseSpan = this.radio.sampleRate / 1e6;
		return baseMin + (baseSpan * this.view.zoomOffset);
	},
	maxFreq(this: AppInstance) {
		const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
		const baseSpan = this.radio.sampleRate / 1e6;
		return baseMin + (baseSpan * (this.view.zoomOffset + (1.0 / this.view.zoomScale)));
	},
	sortedSweepCandidates(this: AppInstance): SweepCandidateBand[] {
		if (this.sweep.candidatePageFromStore) return this.sweep.candidates as SweepCandidateBand[];
		const candidates = locallyFilteredCandidates(this);
		const pageSize = Number(this.sweep.candidatePageSize);
		if (!Number.isInteger(pageSize) || pageSize < 1) return candidates;
		const page = Number.isInteger(this.sweep.candidatePage) ? this.sweep.candidatePage : 0;
		const start = page * pageSize;
		return candidates.slice(start, start + pageSize);
	},
	sweepCandidateFilteredTotal(this: AppInstance): number {
		return this.sweep.candidatePageFromStore
			? this.sweep.candidateTotal
			: locallyFilteredCandidates(this).length;
	},
	sweepCandidatePageCount(this: AppInstance): number {
		return Math.max(1, Math.ceil(this.sweepCandidateFilteredTotal / this.sweep.candidatePageSize));
	},
	sweepCandidateRangeStart(this: AppInstance): number {
		return this.sweepCandidateFilteredTotal === 0 ? 0 : this.sweep.candidatePage * this.sweep.candidatePageSize + 1;
	},
	sweepCandidateRangeEnd(this: AppInstance): number {
		return Math.min(this.sweepCandidateFilteredTotal, (this.sweep.candidatePage + 1) * this.sweep.candidatePageSize);
	},
	visibleWaterfallMarkers(this: AppInstance): VisibleWaterfallMarker[] {
		const startHz = this.sweep.viewportStartHz;
		const endHz = this.sweep.viewportEndHz;
		const span = endHz - startHz;
		const markers = this.records.markers as ReceiverMarker[];
		const visible: VisibleWaterfallMarker[] = [];
		if (!Number.isFinite(span) || span <= 0) return visible;
		for (let index = 0; index < markers.length; index++) {
			const marker = markers[index];
			const ratio = sweepMarkerPositionRatio(marker.frequencyHz, startHz, endHz);
			if (ratio === null) continue;
			visible.push({
				marker,
				name: markerName(index),
				tone: index % 8,
				label: marker.label.trim() || markerName(index),
				frequencyText: `${(marker.frequencyHz / 1_000_000).toFixed(6)} MHz`,
				positionPercent: ratio * 100,
				pinTopPx: 0,
				connectorHeightPx: 0,
				tooltipAlignRight: ratio >= 0.5,
			});
		}
		visible.sort((left, right) => left.marker.frequencyHz - right.marker.frequencyHz || left.marker.id.localeCompare(right.marker.id));
		for (let index = 0; index < visible.length; index++) {
			const marker = visible[index];
			marker.pinTopPx = index % 2 === 0 ? 2 : 10;
			marker.connectorHeightPx = 24 - marker.pinTopPx - 12 + 14;
		}
		return visible;
	},
};
