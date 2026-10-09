import * as Comlink from 'comlink';
import type { AppInstance, Vfo } from './types';
import { drawSweepCanvas } from './sweep-canvas';
import type { SweepCanvasOptions } from './sweep-canvas';
import { exportSweepCandidatesCsv, parseSweepSession, serializeSweepSession } from './sweep-session';
import { exportMarkerSetCsv as markerSetCsv, serializeMarkerSet } from './marker-export';
import type { SweepSessionSnapshot } from './sweep-session';
import { SweepWaterfallHistory, SweepWaterfallRenderer, SWEEP_WATERFALL_BINS, SWEEP_WATERFALL_ROWS } from './sweep-waterfall';
import type { SweepCandidate, SweepConfig, SweepProgress, SweepSource, SweepSpectrumFrame } from '../worker/sweep-types';
import { groupAdjacentCandidates, type SweepCandidateBand } from './candidate-bands';
import { receiverRecordsApi } from './receiver-records-api';
import type { ReceiverMarker, ReceiverTraceRecord } from './receiver-records-api';
import { buildMarkerReadout, formatDeltaDb, formatDeltaFrequency, formatMarkerFrequency, nearestMarkerWithin, peakInRange, traceLevelAt, traceValues } from './marker-readout';
import type { MarkerReadoutRow } from './marker-readout';

interface ListenRestore {
	centerFreq: number;
	activeVfoIndex: number;
	vfo: Vfo;
	resumeReceiver: boolean;
}

interface SweepRuntime {
	frame: SweepSpectrumFrame | null;
	config: SweepConfig | null;
	source: SweepSource | null;
	spectrumCanvas: HTMLCanvasElement | null;
	waterfallCanvas: HTMLCanvasElement | null;
	waterfallHistory: SweepWaterfallHistory;
	waterfallRenderer: SweepWaterfallRenderer | null;
	resizeObserver: ResizeObserver | null;
	drawFrame: number | null;
	dragStartX: number | null;
	dragStartY: number | null;
	dragMoved: boolean;
	dragStartHz: number;
	dragEndHz: number;
	stopRequested: boolean;
	stopResume: boolean;
	pendingCandidates: Map<number, SweepCandidate> | null;
	pendingCandidateScanId: string | null;
	candidateMap: Map<number, SweepCandidate>;
	candidateRequestId: number;
	lastSavedTraceSweep: number;
	candidatePersistQueue: Promise<void>;
	tracePersistQueue: Promise<void>;
	candidateUpdateTimer: number | null;
	listenRestore: ListenRestore | null;
}

const sweepRuntime = new WeakMap<object, SweepRuntime>();
const CANDIDATE_PERSIST_BATCH_SIZE = 500;

function runtimeFor(app: object): SweepRuntime {
	let runtime = sweepRuntime.get(app);
	if (!runtime) {
		runtime = {
			frame: null,
			config: null,
			source: null,
			spectrumCanvas: null,
			waterfallCanvas: null,
			waterfallHistory: new SweepWaterfallHistory(),
			waterfallRenderer: null,
			resizeObserver: null,
			dragStartX: null,
			dragStartY: null,
			dragMoved: false,
			dragStartHz: 0,
			dragEndHz: 0,
			stopRequested: false,
			stopResume: true,
			drawFrame: null,
			pendingCandidates: null,
			pendingCandidateScanId: null,
			candidateMap: new Map(),
			candidateRequestId: 0,
			lastSavedTraceSweep: 0,
			candidatePersistQueue: Promise.resolve(),
			tracePersistQueue: Promise.resolve(),
			candidateUpdateTimer: null,
			listenRestore: null,
		};
		sweepRuntime.set(app, runtime);
	}
	return runtime;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

const MAX_SESSION_FILE_BYTES = 8 * 1024 * 1024;

function downloadFile(filename: string, content: string, mimeType: string): void {
	const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function restoreListeningState(app: AppInstance): ListenRestore | null {
	const runtime = runtimeFor(app);
	const previous = runtime.listenRestore;
	if (!previous) return null;
	app.radio.centerFreq = previous.centerFreq;
	app.vfos[previous.activeVfoIndex] = { ...previous.vfo };
	app.activeVfoIndex = previous.activeVfoIndex;
	app.sweep.listening = false;
	app.sweep.listenFrequencyHz = 0;
	runtime.listenRestore = null;
	return previous;
}
const CANDIDATE_UPDATE_INTERVAL_MS = 1_000;

function filterAndSortCandidateHistory(app: AppInstance, candidates: SweepCandidate[]): SweepCandidateBand[] {
	const threshold = Number(app.sweep.minimumPeakDb);
	let filtered = candidates.filter(candidate => candidate.peakDb >= (Number.isFinite(threshold) ? threshold : -160));
	if (app.records.markedOnly) {
		const markers = app.records.markers as Array<{ frequencyHz: number }>;
		filtered = filtered.filter(candidate => markers.some(marker =>
			marker.frequencyHz >= candidate.startHz - 50_000 && marker.frequencyHz <= candidate.endHz + 50_000));
	}
	const bands = groupAdjacentCandidates(filtered);
	const compareId = (a: SweepCandidate, b: SweepCandidate) => a.id - b.id;
	switch (app.sweep.sortBy) {
		case 'frequency':
			return bands.sort((a, b) => a.peakRangeCenterHz - b.peakRangeCenterHz || compareId(a, b));
		case 'peak':
			return bands.sort((a, b) => b.peakDb - a.peakDb || compareId(a, b));
		case 'hits':
			return bands.sort((a, b) => b.hits - a.hits || b.lastSeen - a.lastSeen || compareId(a, b));
		case 'lastSeen':
			return bands.sort((a, b) => b.lastSeen - a.lastSeen || compareId(a, b));
		default:
			return bands.sort((a, b) => b.snrDb - a.snrDb || compareId(a, b));
	}
}

function refreshLocalCandidatePage(app: AppInstance): void {
	const runtime = runtimeFor(app);
	const filtered = filterAndSortCandidateHistory(app, Array.from(runtime.candidateMap.values()));
	const pageSize = Math.max(1, Number(app.sweep.candidatePageSize) || 100);
	const lastPage = Math.max(0, Math.ceil(filtered.length / pageSize) - 1);
	app.sweep.candidatePage = clamp(Number(app.sweep.candidatePage) || 0, 0, lastPage);
	app.sweep.candidateHistoryTotal = runtime.candidateMap.size;
	app.sweep.candidateTotal = filtered.length;
	const start = app.sweep.candidatePage * pageSize;
	app.sweep.candidates = filtered.slice(start, start + pageSize);
	app.sweep.candidatePageFromStore = true;
	app.sweep.candidatesLoading = false;
}
async function persistCandidateUpdates(scanId: string, updates: SweepCandidate[]): Promise<void> {
	for (let offset = 0; offset < updates.length; offset += CANDIDATE_PERSIST_BATCH_SIZE) {
		await receiverRecordsApi.upsertCandidates(
			scanId,
			updates.slice(offset, offset + CANDIDATE_PERSIST_BATCH_SIZE),
		);
	}
}

function applyCandidateUpdate(app: AppInstance, updates: SweepCandidate[], scanId: string | null): void {
	const runtime = runtimeFor(app);
	if (scanId && app.sweep.scanId !== scanId) {
		runtime.candidatePersistQueue = runtime.candidatePersistQueue.then(async () => {
			try {
				await persistCandidateUpdates(scanId, updates);
			} catch (error) {
				app.records.error = `Could not persist sweep candidates: ${error instanceof Error ? error.message : String(error)}`;
			}
		});
		return;
	}
	const selectedId = (app.sweep.selectedCandidate as SweepCandidate | null)?.id;
	for (const candidate of updates) runtime.candidateMap.set(candidate.id, candidate);
	app.sweep.candidateHistoryTotal = runtime.candidateMap.size;
	app.sweep.progress.detectedCount = runtime.candidateMap.size;
	app.sweep.selectedCandidate = selectedId === undefined ? null : runtime.candidateMap.get(selectedId) || null;
	if (!scanId) {
		refreshLocalCandidatePage(app);
		return;
	}
	runtime.candidatePersistQueue = runtime.candidatePersistQueue.then(async () => {
		try {
			await persistCandidateUpdates(scanId, updates);
			if (app.sweep.scanId === scanId) {
				app.sweep.candidatePageFromStore = true;
				void app.refreshSweepCandidates();
			}
		} catch (error) {
			app.records.error = `Could not persist sweep candidates: ${error instanceof Error ? error.message : String(error)}`;
			if (app.sweep.scanId === scanId) refreshLocalCandidatePage(app);
		}
	});
}


function flushCandidateUpdate(app: AppInstance): void {
	const runtime = runtimeFor(app);
	if (runtime.candidateUpdateTimer !== null) {
		clearTimeout(runtime.candidateUpdateTimer);
		runtime.candidateUpdateTimer = null;
	}
	const pending = runtime.pendingCandidates;
	const scanId = runtime.pendingCandidateScanId;
	runtime.pendingCandidates = null;
	runtime.pendingCandidateScanId = null;
	if (pending?.size) applyCandidateUpdate(app, Array.from(pending.values()), scanId);
}

function queueCandidateUpdate(app: AppInstance, candidates: SweepCandidate[], scanId: string | null): void {
	const runtime = runtimeFor(app);
	if (runtime.pendingCandidateScanId !== null && runtime.pendingCandidateScanId !== scanId) flushCandidateUpdate(app);
	runtime.pendingCandidateScanId = scanId;
	runtime.pendingCandidates ||= new Map();
	for (const candidate of candidates) runtime.pendingCandidates.set(candidate.id, candidate);
	if (!app.sweep.active && !app.sweep.starting && !app.sweep.stopping) {
		flushCandidateUpdate(app);
		return;
	}
	if (runtime.candidateUpdateTimer !== null) return;
	runtime.candidateUpdateTimer = window.setTimeout(() => {
		runtime.candidateUpdateTimer = null;
		flushCandidateUpdate(app);
	}, CANDIDATE_UPDATE_INTERVAL_MS);
}


function compactAverageTrace(frame: SweepSpectrumFrame): Uint8Array<ArrayBuffer> {
	const trace = new Uint8Array(2_048);
	const values = frame.average;
	if (values.length === 0) return trace;
	for (let bin = 0; bin < trace.length; bin++) {
		const sourceIndex = Math.min(values.length - 1, Math.floor(bin * values.length / trace.length));
		const db = Number.isFinite(values[sourceIndex]) ? clamp(values[sourceIndex], -160, 0) : -160;
		trace[bin] = Math.round((db + 160) * 255 / 160);
	}
	return trace;
}

async function finishRecordedScan(app: AppInstance, status: 'complete' | 'stopped' | 'failed'): Promise<void> {
	const scanId = app.sweep.scanId as string | null;
	if (!scanId) return;
	const runtime = runtimeFor(app);
	await runtime.candidatePersistQueue;
	await runtime.tracePersistQueue;
	await receiverRecordsApi.finishScan(scanId, status);
}

async function loadAllCandidates(app: AppInstance): Promise<SweepCandidate[]> {
	const runtime = runtimeFor(app);
	const scanId = app.sweep.scanId as string | null;
	if (!scanId || runtime.candidateMap.size > 0) return Array.from(runtime.candidateMap.values());
	const pageSize = 250;
	const query = {
		offset: 0,
		limit: pageSize,
		sort: 'frequency' as const,
		minimumPeakDb: -160,
		markedOnly: false,
		markerSetId: null,
	};
	const first = await receiverRecordsApi.getCandidates(scanId, query);
	const candidates = first.items.slice();
	for (let offset = first.items.length; offset < first.total; offset += pageSize) {
		const page = await receiverRecordsApi.getCandidates(scanId, { ...query, offset });
		if (page.items.length === 0) throw new Error(`Candidate history stopped at row ${offset} of ${first.total}.`);
		candidates.push(...page.items);
	}
	return candidates;
}
// A click within this many pixels of an existing marker selects it instead of adding another.
const MARKER_PICK_TOLERANCE_PX = 8;
const MARKER_SAVE_DELAY_MS = 400;
const markerSaveTimers = new WeakMap<object, number>();

async function addSweepMarkerAt(app: AppInstance, canvas: HTMLCanvasElement, clientX: number, clientY: number): Promise<void> {
	const rect = canvas.getBoundingClientRect();
	const x = clientX - rect.left;
	const y = clientY - rect.top;
	if (x < 54 || x > rect.width - 12 || y < 14 || y > rect.height - 28) return;
	const ratio = (x - 54) / Math.max(1, rect.width - 66);
	const viewSpan = app.sweep.viewportEndHz - app.sweep.viewportStartHz;
	const frequencyHz = app.sweep.viewportStartHz + ratio * viewSpan;
	const toleranceHz = viewSpan / Math.max(1, rect.width - 66) * MARKER_PICK_TOLERANCE_PX;
	const existing = nearestMarkerWithin(app.records.markers as ReceiverMarker[], frequencyHz, toleranceHz);
	if (existing) {
		app.selectReceiverMarker(existing.id);
		return;
	}
	const frame = runtimeFor(app).frame;
	let powerDb: number | null = null;
	if (frame && frequencyHz >= frame.startHz && frequencyHz < frame.endHz) {
		const values = app.sweep.view === 'current' ? frame.current : app.sweep.view === 'max' ? frame.maxHold : frame.average;
		if (values.length > 0) {
			const index = Math.min(values.length - 1, Math.floor((frequencyHz - frame.startHz) / (frame.endHz - frame.startHz) * values.length));
			if (Number.isFinite(values[index])) powerDb = values[index];
		}
	}
	await app.addReceiverMarker(frequencyHz, powerDb);
}

export const sweepMethods = {
	initSweepCanvas(this: AppInstance) {
		const runtime = runtimeFor(this);
		runtime.spectrumCanvas = this.$refs.sweepSpectrum || null;
		runtime.waterfallCanvas = this.$refs.sweepWaterfall || null;
		if (!runtime.resizeObserver && typeof ResizeObserver !== 'undefined') {
			runtime.resizeObserver = new ResizeObserver(() => this.drawSweepSpectrum());
			if (runtime.spectrumCanvas) runtime.resizeObserver.observe(runtime.spectrumCanvas);
			if (runtime.waterfallCanvas) runtime.resizeObserver.observe(runtime.waterfallCanvas);
		}
		this.drawSweepSpectrum();
	},

	async refreshSweepCandidates(this: AppInstance) {
		const runtime = runtimeFor(this);
		const requestId = ++runtime.candidateRequestId;
		const scanId = this.sweep.scanId as string | null;
		this.sweep.candidatesLoading = true;
		if (scanId) {
			try {
				const page = await receiverRecordsApi.getCandidates(scanId, {
					offset: this.sweep.candidatePage * this.sweep.candidatePageSize,
					limit: this.sweep.candidatePageSize,
					sort: this.sweep.sortBy,
					minimumPeakDb: Number(this.sweep.minimumPeakDb),
					markedOnly: Boolean(this.records.markedOnly),
					markerSetId: this.records.selectedMarkerSetId || null,
					markerFrequencies: (this.records.markers as Array<{ frequencyHz: number }>).map(marker => marker.frequencyHz),
					groupAdjacent: true,
				});
				if (requestId !== runtime.candidateRequestId || scanId !== this.sweep.scanId) return;
				this.sweep.candidates = page.items;
				this.sweep.candidateTotal = page.total;
				this.sweep.candidatePageFromStore = true;
				const selectedId = (this.sweep.selectedCandidate as SweepCandidate | null)?.id;
				if (selectedId !== undefined) {
					this.sweep.selectedCandidate = page.items.find(candidate => candidate.id === selectedId)
						|| runtime.candidateMap.get(selectedId)
						|| null;
				}
			} catch (error) {
				if (requestId !== runtime.candidateRequestId) return;
				this.records.error = `Could not load candidate history: ${error instanceof Error ? error.message : String(error)}`;
				refreshLocalCandidatePage(this);
			}
		} else {
			refreshLocalCandidatePage(this);
		}
		if (requestId === runtime.candidateRequestId) this.sweep.candidatesLoading = false;
	},

	candidateFilterChanged(this: AppInstance) {
		this.sweep.candidatePage = 0;
		void this.refreshSweepCandidates();
	},

	setCandidatePage(this: AppInstance, page: number) {
		const lastPage = Math.max(0, this.sweepCandidatePageCount - 1);
		this.sweep.candidatePage = clamp(Math.floor(page), 0, lastPage);
		void this.refreshSweepCandidates();
	},

	setCandidatePageSize(this: AppInstance, event: Event) {
		const size = Number((event.target as HTMLSelectElement).value);
		if (![25, 50, 100, 250].includes(size)) return;
		this.sweep.candidatePageSize = size;
		this.sweep.candidatePage = 0;
		void this.refreshSweepCandidates();
	},

	setMinimumPeakPreset(this: AppInstance, event: Event) {
		const value = (event.target as HTMLSelectElement).value;
		if (value === 'custom') return;
		const threshold = Number(value);
		if (!Number.isFinite(threshold)) return;
		this.sweep.minimumPeakDb = threshold;
		this.candidateFilterChanged();
	},

	setMinimumPeakCustom(this: AppInstance, event: Event) {
		const input = event.target as HTMLInputElement;
		const threshold = input.valueAsNumber;
		if (!Number.isFinite(threshold) || threshold < -160 || threshold > 0) {
			input.value = String(this.sweep.minimumPeakDb);
			return;
		}
		this.sweep.minimumPeakDb = threshold;
		this.candidateFilterChanged();
	},

	async startHardwareSweep(this: AppInstance): Promise<boolean> {
		if (!this.connected || this.remoteMode !== 'none' || !this.backend) return false;
		const capabilities = this.deviceCapabilities;
		const source: SweepSource | null = capabilities?.supportsNativeSweep
			? 'native'
			: capabilities?.supportsManualSweep ? 'manual' : null;
		if (!source) {
			this.showMsg('Connected device does not support hardware wide spectrum scanning.');
			this.sweep.returnToRx = false;
			return false;
		}
		this.sweep.source = source;
		await this.startSweep();
		return this.sweep.active || this.sweep.starting;
	},

	async selectWorkspace(this: AppInstance, workspace: 'spectrum' | 'listener' | 'records') {
		if (workspace === this.activeWorkspace || this.sweep.listenStarting || this.sweep.starting || this.sweep.stopping) return;
		if (workspace === 'listener') {
			if (this.sweep.active && !await this.stopSweep(false)) return;
			this.activeWorkspace = 'listener';
			await this.$nextTick();
			if (this.running) this.resizeFftCanvas();
			return;
		}

		if (workspace === 'records') {
			this.activeWorkspace = 'records';
			await this.$nextTick();
			await this.loadReceiverRecords();
			return;
		}

		if (this.sweep.listening) {
			await this.stopSweepListening(false);
			return;
		}
		try {
			if (this.running) await this.togglePlay(false, true);
			if (this.running) throw new Error('Receiver remained active after stopping audio.');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showMsg(`Could not stop Listener audio before opening Spectrum: ${message}`);
			return;
		}
		this.sweep.returnToRx = false;
		this.activeWorkspace = 'spectrum';
		await this.$nextTick();
		this.initSweepCanvas();
	},

	onWorkspaceTabsKeydown(this: AppInstance, event: KeyboardEvent) {
		const tabs = ['spectrum', 'listener', 'records'] as const;
		const currentIndex = tabs.indexOf(this.activeWorkspace);
		let nextIndex = currentIndex;
		if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
		else if (event.key === 'ArrowUp') nextIndex = (currentIndex + tabs.length - 1) % tabs.length;
		else if (event.key === 'Home') nextIndex = 0;
		else if (event.key === 'End') nextIndex = tabs.length - 1;
		else return;
		event.preventDefault();
		const workspace = tabs[nextIndex];
		const tab = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[aria-controls="${workspace}-workspace"]`);
		tab?.focus();
		void this.selectWorkspace(workspace);
	},

	async stopSweepListening(this: AppInstance, startNewScan: boolean): Promise<boolean> {
		if (this.sweep.listenStarting || !this.sweep.listening) return false;
		try {
			if (this.running) await this.togglePlay(false, true);
			if (this.running) throw new Error('Receiver remained active after stopping audio.');
			const previous = restoreListeningState(this);
			if (!previous) return false;
			this.sweep.returnToRx = startNewScan && previous.resumeReceiver;
			this.activeWorkspace = 'spectrum';
			await this.$nextTick();
			this.initSweepCanvas();
			if (startNewScan) {
				const started = await this.startHardwareSweep();
				if (started) this.showMsg('Listening stopped. A fresh wide spectrum scan has started.');
				else if (!this.connected) this.showMsg('Listening stopped. Device disconnected; no scan started.');
			} else {
				this.sweep.returnToRx = false;
				this.showMsg('Listening stopped. Select Start scan to acquire Spectrum data.');
			}
			return true;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showMsg(`Could not return to Spectrum: ${message}`);
			return false;
		}
	},

	async returnToSpectrum(this: AppInstance) {
		if (this.sweep.listenStarting) return;
		if (!this.sweep.listening) {
			await this.selectWorkspace('spectrum');
			return;
		}
		await this.stopSweepListening(true);
	},


	async startSweep(this: AppInstance) {
		if (this.sweep.active || this.sweep.starting || this.sweep.stopping || this.sweep.listening || this.sweep.listenStarting) return;
		if (!this.backend) {
			this.showMsg('Receiver backend is still initializing. Wait a moment, then try again.');
			return;
		}
		if (this.remoteMode !== 'none') {
			this.showMsg('Advanced Scan is unavailable while using remote mode.');
			return;
		}
		const source = this.sweep.source as SweepSource;
		if (source !== 'simulated' && !this.connected) {
			this.showMsg('Connect a HackRF before selecting a hardware sweep source.');
			return;
		}
		if (source === 'native' && !this.deviceCapabilities?.supportsNativeSweep) {
			this.showMsg('This HackRF firmware does not support native sweep. Select Manual or Simulated.');
			return;
		}
		if (source === 'manual' && !this.deviceCapabilities?.supportsManualSweep) {
			this.showMsg('This device does not support manual sweep. Select an available source.');
			return;
		}

		const runtime = runtimeFor(this);
		runtime.stopRequested = false;
		runtime.stopResume = true;
		this.sweep.starting = true;
		this.sweep.error = '';
		this.sweep.returnToRx = this.sweep.returnToRx || this.running;
		let scanId: string | null = null;
		try {
			if (this.running) await this.togglePlay(false, true);
			if (runtime.stopRequested) {
				const shouldResume = runtime.stopResume && this.sweep.returnToRx && this.connected;
				this.sweep.active = false;
				this.sweep.returnToRx = false;
				runtime.stopRequested = false;
				if (shouldResume) await this.startStream();
				return;
			}
			this.clearSweepData();
			this.resetSweepViewport();
			const config: SweepConfig = {
				startHz: Number(this.sweep.startMHz) * 1_000_000,
				endHz: Number(this.sweep.endMHz) * 1_000_000,
				fftSize: this.sweep.fftSize as 4096 | 8192,
				minSnrDb: Number(this.sweep.minSnrDb),
				averageAlpha: Number(this.sweep.averageAlpha),
				lnaGain: Number(this.sweep.lnaGain),
				vgaGain: Number(this.sweep.vgaGain),
				ampEnabled: Boolean(this.sweep.ampEnabled),
				iqCorrection: Boolean(this.radio.iqCorrection),
			};
			runtime.config = config;
			runtime.source = source;
			runtime.lastSavedTraceSweep = 0;
			runtime.tracePersistQueue = Promise.resolve();
			if (!this.records.settingsLoaded) await this.loadReceiverSettings();
			this.sweep.scanId = null;
			this.sweep.archive = false;
			if (this.records.autoSpectrumRecording) {
				try {
					const record = await receiverRecordsApi.createScan({ source, config, archive: true });
					scanId = record.id;
					this.sweep.scanId = scanId;
					this.sweep.archive = record.archive;
				} catch (error) {
					this.records.error = `Local scan archive unavailable: ${error instanceof Error ? error.message : String(error)}`;
					throw error;
				}
			}
			if (runtime.stopRequested) {
				const shouldResume = runtime.stopResume && this.sweep.returnToRx && this.connected;
				if (scanId) await finishRecordedScan(this, 'stopped');
				this.sweep.active = false;
				this.sweep.returnToRx = false;
				runtime.stopRequested = false;
				if (shouldResume) await this.startStream();
				return;
			}
			this.sweep.active = true;
			await this.backend.startSweep(
				source,
				config,
				Comlink.proxy((frame: SweepSpectrumFrame) => {
					const currentRuntime = runtimeFor(this);
					currentRuntime.frame = frame;
					this.sweep.hasResults = true;
					this.sweep.progress.sweepCount = frame.sweepCount;
					const addedWaterfallRow = currentRuntime.waterfallHistory.appendCompletedSweep(frame);
					this.sweep.waterfallRows = currentRuntime.waterfallHistory.rowCount;
					const traceScanId = scanId;
					if (traceScanId && frame.sweepCount > currentRuntime.lastSavedTraceSweep) {
						currentRuntime.lastSavedTraceSweep = frame.sweepCount;
						const trace = compactAverageTrace(frame);
						currentRuntime.tracePersistQueue = currentRuntime.tracePersistQueue.then(async () => {
							try {
								await receiverRecordsApi.saveTrace(traceScanId, frame.sweepCount, trace);
							} catch (error) {
								this.records.error = `Could not archive sweep trace ${frame.sweepCount}: ${error instanceof Error ? error.message : String(error)}`;
							}
						});
					}
					if (this.sweep.visualization === 'spectrum' || addedWaterfallRow) this.drawSweepSpectrum();
				}),
				Comlink.proxy((progress: SweepProgress) => { this.sweep.progress = progress; }),
				Comlink.proxy((candidates: SweepCandidate[]) => {
					queueCandidateUpdate(this, candidates, scanId);
				}),
				Comlink.proxy((error: string) => { void this.handleSweepError(error); }),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const shouldResume = runtime.stopResume && this.sweep.returnToRx && this.connected;
			this.sweep.error = message;
			this.showMsg(`Sweep error: ${message}`);
			try {
				await this.backend.stopSweep();
			} catch (stopError) {
				const detail = stopError instanceof Error ? stopError.message : String(stopError);
				this.sweep.error = `${message}; stopping also failed: ${detail}`;
			}
			this.sweep.active = false;
			this.sweep.returnToRx = false;
			flushCandidateUpdate(this);
			try {
				await finishRecordedScan(this, 'failed');
			} catch (finishError) {
				this.records.error = `Could not finalize failed scan: ${finishError instanceof Error ? finishError.message : String(finishError)}`;
			}
			if (shouldResume) await this.startStream();
		} finally {
			this.sweep.starting = false;
		}
	},


	async stopSweep(this: AppInstance, resumeReceiver = true, finalStatus: 'complete' | 'stopped' | 'failed' = 'stopped'): Promise<boolean> {
		const runtime = runtimeFor(this);
		if (this.sweep.starting && !this.sweep.active) {
			runtime.stopRequested = true;
			runtime.stopResume = resumeReceiver;
			return false;
		}
		if (!this.sweep.active && !this.sweep.starting) return !this.sweep.stopping;
		if (this.sweep.stopping) return false;
		const shouldResume = resumeReceiver && this.sweep.returnToRx;
		const wasActive = this.sweep.active;
		let stopped = true;
		this.sweep.active = false;
		this.sweep.stopping = true;
		this.sweep.stopPhase = 'rf';
		try {
			await this.backend?.stopSweep();
			this.sweep.stopPhase = this.sweep.scanId ? 'archive' : 'finalize';
			flushCandidateUpdate(this);
			try {
				await finishRecordedScan(this, finalStatus);
			} catch (error) {
				this.records.error = `Could not finalize scan record: ${error instanceof Error ? error.message : String(error)}`;
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sweep.error = message;
			this.showMsg(`Error stopping sweep: ${message}`);
			stopped = false;
		} finally {
			this.sweep.stopping = false;
			this.sweep.stopPhase = '';
			this.sweep.starting = false;
			this.sweep.active = !stopped && wasActive;
			if (stopped) this.sweep.returnToRx = false;
			runtime.stopRequested = false;
			flushCandidateUpdate(this);
		}
		if (stopped && shouldResume && this.connected && this.remoteMode === 'none') await this.startStream();
		return stopped;
	},

	async handleSweepError(this: AppInstance, error: string) {
		this.sweep.error = error;
		this.showMsg(`Sweep stopped: ${error}`);
		await this.stopSweep(false, 'failed');
	},

	clearSweepData(this: AppInstance) {
		if (this.sweep.listening || this.sweep.listenStarting) return;
		const runtime = runtimeFor(this);
		if (runtime.candidateUpdateTimer !== null) {
			clearTimeout(runtime.candidateUpdateTimer);
			runtime.candidateUpdateTimer = null;
		}
		runtime.pendingCandidates = null;
		runtime.pendingCandidateScanId = null;
		runtime.candidateMap.clear();
		runtime.candidateRequestId++;
		runtime.lastSavedTraceSweep = 0;
		this.backend?.clearSweep();
		runtime.frame = null;
		runtime.config = null;
		runtime.source = null;
		runtime.waterfallHistory.clear();
		this.sweep.waterfallRows = 0;
		this.sweep.hasResults = false;
		this.sweep.offlineSessionName = '';
		this.sweep.scanId = null;
		this.sweep.candidateHistoryTotal = 0;
		this.sweep.candidateTotal = 0;
		this.sweep.candidatePage = 0;
		this.sweep.candidatePageFromStore = false;
		this.sweep.candidatesLoading = false;
		this.sweep.candidates = [];
		this.sweep.selectedCandidate = null;
		this.sweep.progress = {
			sweepCount: 0,
			sweepsPerSecond: 0,
			currentFrequencyHz: 0,
			bytesPerSecond: 0,
			detectedCount: 0,
			discardedBytes: 0,
		};
		this.sweep.error = '';
		this.drawSweepSpectrum();
	},
	async openArchivedSweep(this: AppInstance, scanId: string) {
		if (this.sweep.starting || this.sweep.stopping || this.sweep.listening || this.sweep.listenStarting) {
			this.showMsg('Stop the current Receiver transition before opening an archived scan.');
			return;
		}
		if (this.sweep.active && !await this.stopSweep(false)) return;
		if (this.running) await this.togglePlay(false, true);
		try {
			const details = await receiverRecordsApi.getScan(scanId);
			const traceLimit = Math.min(details.trace_count, SWEEP_WATERFALL_ROWS);
			const traceMetadata: ReceiverTraceRecord[] = [];
			for (let offset = 0; offset < traceLimit;) {
				const limit = Math.min(100, traceLimit - offset);
				const page = await receiverRecordsApi.getTraces(scanId, offset, limit, 'desc');
				traceMetadata.push(...page.items);
				offset += page.items.length;
				if (page.items.length < limit) break;
			}
			traceMetadata.sort((left, right) => left.sweep - right.sweep);
			const traceBytes: Uint8Array[] = [];
			for (let offset = 0; offset < traceMetadata.length; offset += 16) {
				const batch = await Promise.all(traceMetadata.slice(offset, offset + 16)
					.map(trace => receiverRecordsApi.getTrace(scanId, trace.sweep)));
				traceBytes.push(...batch);
			}
			const latestTrace = traceMetadata[traceMetadata.length - 1] || null;
			const bytes = traceBytes[traceBytes.length - 1] || null;
			this.clearSweepData();
			const runtime = runtimeFor(this);
			if (traceBytes.length > 0 && latestTrace) {
				const archivedRows = new Uint8Array(traceBytes.length * SWEEP_WATERFALL_BINS);
				traceBytes.forEach((trace, index) => archivedRows.set(trace, index * SWEEP_WATERFALL_BINS));
				runtime.waterfallHistory.restore(archivedRows, traceBytes.length, latestTrace.sweep);
			}
			runtime.config = details.config;
			runtime.source = details.source === 'native' || details.source === 'manual' || details.source === 'simulated'
				? details.source
				: 'simulated';
			if (bytes) {
				const average = new Float32Array(bytes.length);
				for (let index = 0; index < bytes.length; index++) average[index] = bytes[index] * 160 / 255 - 160;
				runtime.frame = {
					startHz: details.config.startHz,
					endHz: details.config.endHz,
					resolutionHz: (details.config.endHz - details.config.startHz) / bytes.length,
					sweepCount: latestTrace?.sweep || 0,
					current: average,
					average,
					maxHold: average,
				};
			}
			this.sweep.source = runtime.source;
			this.sweep.startMHz = details.config.startHz / 1_000_000;
			this.sweep.endMHz = details.config.endHz / 1_000_000;
			this.sweep.fftSize = details.config.fftSize;
			this.sweep.minSnrDb = details.config.minSnrDb;
			this.sweep.averageAlpha = details.config.averageAlpha;
			this.sweep.lnaGain = details.config.lnaGain;
			this.sweep.vgaGain = details.config.vgaGain;
			this.sweep.ampEnabled = details.config.ampEnabled;
			this.sweep.view = 'average';
			this.sweep.visualization = 'spectrum';
			this.sweep.viewportStartHz = details.config.startHz;
			this.sweep.viewportEndHz = details.config.endHz;
			this.sweep.scanId = scanId;
			this.sweep.archive = details.archive;
			this.sweep.candidateHistoryTotal = details.candidate_count;
			this.sweep.candidateTotal = details.candidate_count;
			this.sweep.candidatePageFromStore = true;
			this.sweep.selectedCandidate = null;
			this.sweep.progress = {
				sweepCount: latestTrace?.sweep || 0,
				sweepsPerSecond: 0,
				currentFrequencyHz: 0,
				bytesPerSecond: 0,
				detectedCount: details.candidate_count,
				discardedBytes: 0,
			};
			this.sweep.waterfallRows = runtime.waterfallHistory.rowCount;
			this.sweep.hasResults = Boolean(bytes) || details.candidate_count > 0;
			this.sweep.offlineSessionName = latestTrace
				? `Archived · sweep ${latestTrace.sweep}`
				: 'Archived · candidate history only';
			this.activeWorkspace = 'spectrum';
			await this.$nextTick();
			this.initSweepCanvas();
			await this.refreshSweepCandidates();
			this.showMsg(`Opened archived scan with ${details.candidate_count} candidates and ${details.trace_count} traces.`);
		} catch (error) {
			this.records.error = `Could not open archived scan: ${error instanceof Error ? error.message : String(error)}`;
			this.showMsg(this.records.error);
		}
	},
	async saveSweepSession(this: AppInstance) {
		const runtime = runtimeFor(this);
		if (!runtime.frame || !runtime.config) {
			this.showMsg('There are no sweep results to save.');
			return;
		}
		flushCandidateUpdate(this);
		await runtime.candidatePersistQueue;
		try {
			const candidates = await loadAllCandidates(this);
			const rows = runtime.waterfallHistory.exportChronologicalRows();
			const snapshot: SweepSessionSnapshot = {
				source: runtime.source || this.sweep.source as SweepSource,
				config: runtime.config,
				frame: runtime.frame,
				candidates,
				display: {
					view: this.sweep.view,
					minimumPeakDb: this.sweep.minimumPeakDb,
					displayMinDb: this.sweep.displayMinDb,
					displayMaxDb: this.sweep.displayMaxDb,
					viewportStartHz: this.sweep.viewportStartHz,
					viewportEndHz: this.sweep.viewportEndHz,
					sortBy: this.sweep.sortBy,
					visualization: this.sweep.visualization,
					selectedCandidatePeakHz: this.sweep.selectedCandidate?.peakFrequencyHz ?? null,
				},
				waterfall: {
					rowCount: runtime.waterfallHistory.rowCount,
					latestSweepCount: runtime.waterfallHistory.latestCompletedSweepCount,
					data: Array.from(rows),
				},
			};
			const content = serializeSweepSession(snapshot);
			if (new TextEncoder().encode(content).length > MAX_SESSION_FILE_BYTES) {
				throw new RangeError('Sweep JSON exceeds the 8 MiB import limit; use CSV export or the local Records archive.');
			}
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadFile(`browsdr-sweep-${timestamp}.json`, content, 'application/json');
			this.showMsg('Sweep session saved.');
		} catch (error) {
			this.showMsg(`Could not save sweep session: ${error instanceof Error ? error.message : String(error)}`);
		}
	},

	async exportSweepCandidates(this: AppInstance) {
		if (!this.sweep.hasResults) {
			this.showMsg('There are no sweep results to export.');
			return;
		}
		flushCandidateUpdate(this);
		await runtimeFor(this).candidatePersistQueue;
		try {
			const candidates = await loadAllCandidates(this);
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
			downloadFile(`browsdr-candidates-${timestamp}.csv`, exportSweepCandidatesCsv(candidates), 'text/csv;charset=utf-8');
			this.showMsg(`${candidates.length} candidates exported as CSV.`);
		} catch (error) {
			this.showMsg(`Could not export candidate history: ${error instanceof Error ? error.message : String(error)}`);
		}
	},

	exportMarkerSetJson(this: AppInstance) {
		const markers = this.records.markers as ReceiverMarker[];
		if (!markers.length) {
			this.showMsg('There are no markers to export.');
			return;
		}
		const exportedAt = new Date();
		const timestamp = exportedAt.toISOString().replace(/[:.]/g, '-');
		downloadFile(
			`freq-spectrum-markers-${timestamp}.json`,
			serializeMarkerSet(String(this.records.markerSetName || ''), markers, exportedAt.toISOString()),
			'application/json',
		);
		this.showMsg(`${markers.length} marker${markers.length === 1 ? '' : 's'} exported as JSON.`);
	},

	exportMarkerSetCsv(this: AppInstance) {
		const markers = this.records.markers as ReceiverMarker[];
		if (!markers.length) {
			this.showMsg('There are no markers to export.');
			return;
		}
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		downloadFile(`freq-spectrum-markers-${timestamp}.csv`, markerSetCsv(markers), 'text/csv;charset=utf-8');
		this.showMsg(`${markers.length} marker${markers.length === 1 ? '' : 's'} exported as CSV.`);
	},

	sweepMarkerRows(this: AppInstance): MarkerReadoutRow[] {
		return buildMarkerReadout(this.records.markers as ReceiverMarker[], runtimeFor(this).frame, this.sweep.view, this.records.referenceMarkerId);
	},

	formatMarkerFrequency,
	formatDeltaFrequency,
	formatDeltaDb,

	selectReceiverMarker(this: AppInstance, markerId: string | null) {
		this.records.selectedMarkerId = markerId;
		this.drawSweepSpectrum();
	},

	setReferenceMarker(this: AppInstance, markerId: string) {
		this.records.referenceMarkerId = markerId;
	},

	centerOnReceiverMarker(this: AppInstance, markerId: string) {
		const marker = (this.records.markers as ReceiverMarker[]).find(item => item.id === markerId);
		if (!marker) return;
		const totalStart = Number(this.sweep.startMHz) * 1_000_000;
		const totalEnd = Number(this.sweep.endMHz) * 1_000_000;
		const span = Math.min(this.sweep.viewportEndHz - this.sweep.viewportStartHz, totalEnd - totalStart);
		const start = clamp(marker.frequencyHz - span / 2, totalStart, totalEnd - span);
		this.sweep.viewportStartHz = start;
		this.sweep.viewportEndHz = start + span;
		this.records.selectedMarkerId = markerId;
		this.drawSweepSpectrum();
	},

	async addPeakMarker(this: AppInstance) {
		const frame = runtimeFor(this).frame;
		if (!frame) {
			this.showMsg('No spectrum yet. Start a scan or open a session first.');
			return;
		}
		const peak = peakInRange(traceValues(frame, this.sweep.view), frame.startHz, frame.endHz, this.sweep.viewportStartHz, this.sweep.viewportEndHz);
		if (!peak) {
			this.showMsg('No measured power in the visible range.');
			return;
		}
		const existing = nearestMarkerWithin(this.records.markers as ReceiverMarker[], peak.frequencyHz, frame.resolutionHz);
		if (existing) {
			this.selectReceiverMarker(existing.id);
			return;
		}
		await this.addReceiverMarker(peak.frequencyHz, peak.powerDb, 'Peak');
	},

	async markSweepCandidate(this: AppInstance, candidate: SweepCandidateBand) {
		const toleranceHz = Math.max(runtimeFor(this).frame?.resolutionHz ?? 0, 1_000);
		const existing = nearestMarkerWithin(this.records.markers as ReceiverMarker[], candidate.peakFrequencyHz, toleranceHz);
		if (existing) {
			this.selectReceiverMarker(existing.id);
			return;
		}
		await this.addReceiverMarker(candidate.peakFrequencyHz, candidate.peakDb);
	},

	/** Arrow keys move the selected marker by one bin (Shift: ten), Delete removes it, Escape deselects. */
	sweepCanvasKeydown(this: AppInstance, event: KeyboardEvent) {
		const marker = (this.records.markers as ReceiverMarker[]).find(item => item.id === this.records.selectedMarkerId);
		if (event.key === 'Escape' && marker) {
			event.preventDefault();
			this.selectReceiverMarker(null);
			return;
		}
		if ((event.key === 'Delete' || event.key === 'Backspace') && marker) {
			event.preventDefault();
			void this.removeReceiverMarker(marker.id);
			return;
		}
		if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || !marker) return;
		event.preventDefault();
		const frame = runtimeFor(this).frame;
		const viewSpan = this.sweep.viewportEndHz - this.sweep.viewportStartHz;
		const stepHz = frame ? (frame.endHz - frame.startHz) / traceValues(frame, this.sweep.view).length : viewSpan / 500;
		const direction = event.key === 'ArrowLeft' ? -1 : 1;
		const frequencyHz = Math.max(1, marker.frequencyHz + direction * stepHz * (event.shiftKey ? 10 : 1));
		marker.frequencyHz = frequencyHz;
		marker.powerDb = frame ? traceLevelAt(traceValues(frame, this.sweep.view), frame.startHz, frame.endHz, frequencyHz) : null;
		this.records.markerFrequencyDrafts[marker.id] = String(frequencyHz / 1_000_000);
		this.drawSweepSpectrum();
		// Persist once the operator stops nudging instead of once per key press.
		const pending = markerSaveTimers.get(this);
		if (pending !== undefined) window.clearTimeout(pending);
		markerSaveTimers.set(this, window.setTimeout(() => {
			markerSaveTimers.delete(this);
			void this.updateReceiverMarker(marker.id);
		}, MARKER_SAVE_DELAY_MS));
	},


	async openSweepSession(this: AppInstance, event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			if (this.sweep.active || this.sweep.starting || this.sweep.stopping || this.sweep.listening || this.sweep.listenStarting) {
				throw new Error('Stop the scan or listening before opening a saved session.');
			}
			if (file.size > MAX_SESSION_FILE_BYTES) throw new RangeError('Sweep session file exceeds the 8 MiB limit.');
			const text = await file.text();
			if (this.sweep.active || this.sweep.starting || this.sweep.stopping || this.sweep.listening || this.sweep.listenStarting) {
				throw new Error('Stop the scan or listening before opening a saved session.');
			}
			const session = parseSweepSession(text);
			const runtime = runtimeFor(this);
			if (runtime.candidateUpdateTimer !== null) {
				clearTimeout(runtime.candidateUpdateTimer);
				runtime.candidateUpdateTimer = null;
			}
			runtime.pendingCandidates = null;
			runtime.pendingCandidateScanId = null;
			runtime.candidateMap.clear();
			for (const candidate of session.candidates) runtime.candidateMap.set(candidate.id, candidate);
			runtime.candidateRequestId++;
			runtime.frame = session.frame;
			runtime.config = session.config;
			runtime.source = session.source;
			runtime.waterfallHistory.restore(
				Uint8Array.from(session.waterfall.data),
				session.waterfall.rowCount,
				session.waterfall.latestSweepCount,
			);
			this.sweep.source = session.source;
			this.sweep.startMHz = session.config.startHz / 1_000_000;
			this.sweep.endMHz = session.config.endHz / 1_000_000;
			this.sweep.fftSize = session.config.fftSize;
			this.sweep.minSnrDb = session.config.minSnrDb;
			this.sweep.averageAlpha = session.config.averageAlpha;
			this.sweep.lnaGain = session.config.lnaGain;
			this.sweep.vgaGain = session.config.vgaGain;
			this.sweep.ampEnabled = session.config.ampEnabled;
			this.sweep.view = session.display.view;
			this.sweep.minimumPeakDb = session.display.minimumPeakDb;
			this.sweep.displayMinDb = session.display.displayMinDb;
			this.sweep.displayMaxDb = session.display.displayMaxDb;
			this.sweep.viewportStartHz = session.display.viewportStartHz;
			this.sweep.viewportEndHz = session.display.viewportEndHz;
			this.sweep.sortBy = session.display.sortBy;
			this.sweep.visualization = session.display.visualization;
			this.sweep.scanId = null;
			this.sweep.archive = false;
			this.sweep.candidateHistoryTotal = session.candidates.length;
			this.sweep.candidateTotal = session.candidates.length;
			this.sweep.candidatePage = 0;
			this.sweep.candidatePageFromStore = false;
			this.sweep.candidatesLoading = false;
			this.sweep.candidates = session.candidates;
			this.sweep.selectedCandidate = session.display.selectedCandidatePeakHz === null
				? null
				: session.candidates.find(candidate => candidate.peakFrequencyHz === session.display.selectedCandidatePeakHz) || null;
			this.sweep.progress = {
				sweepCount: session.frame.sweepCount,
				sweepsPerSecond: 0,
				currentFrequencyHz: 0,
				bytesPerSecond: 0,
				detectedCount: session.candidates.length,
				discardedBytes: 0,
			};
			this.sweep.waterfallRows = session.waterfall.rowCount;
			this.sweep.hasResults = true;
			this.sweep.offlineSessionName = file.name;
			this.sweep.error = '';
			this.drawSweepSpectrum();
			this.showMsg(`Opened offline sweep session: ${file.name}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showMsg(`Could not open sweep session: ${message}`);
		} finally {
			input.value = '';
		}
	},

	async listenToSweepCandidate(this: AppInstance, candidate: SweepCandidate) {
		if (this.sweep.starting || this.sweep.stopping || this.sweep.listening || this.sweep.listenStarting) return;
		if (!this.connected || this.remoteMode !== 'none' || !this.backend) {
			this.showMsg('Connect a local SDR before listening to a sweep candidate.');
			return;
		}
		const vfoIndex = this.activeVfoIndex;
		const currentVfo = this.vfos[vfoIndex] as Vfo | undefined;
		if (!currentVfo) return;
		this.selectSweepCandidate(candidate);
		const runtime = runtimeFor(this);
		runtime.listenRestore = {
			centerFreq: this.radio.centerFreq,
			activeVfoIndex: vfoIndex,
			vfo: { ...currentVfo },
			resumeReceiver: this.running || this.sweep.returnToRx,
		};
		this.sweep.listenStarting = true;
		try {
			this._initAudioCtx();
			if (this.sweep.active || this.sweep.starting || this.sweep.stopping) {
				const stopped = await this.stopSweep(false);
				if (!stopped) {
					runtime.listenRestore = null;
					this.showMsg('Sweep must stop successfully before listening.');
					return;
				}
			}
			if (this.running) await this.togglePlay(false, true);
			const frequencyMHz = candidate.peakFrequencyHz / 1_000_000;
			this.radio.centerFreq = frequencyMHz;
			currentVfo.freq = frequencyMHz;
			currentVfo.displayFreq = this.formatFreq(frequencyMHz);
			if (this.sweep.listenMode) {
				currentVfo.mode = this.sweep.listenMode;
				this.applyModeDefaults(vfoIndex);
			}
			this.sweep.listenFrequencyHz = candidate.peakFrequencyHz;
			await this.startStream(true);
			if (!this.running) {
				const previous = restoreListeningState(this);
				if (previous?.resumeReceiver && this.connected && this.remoteMode === 'none') await this.startStream(true);
				this.showMsg('Could not start Receiver at the selected sweep frequency.');
				return;
			}
			this.sweep.listening = true;
			this.activeWorkspace = 'listener';
			await this.$nextTick();
			this.resizeFftCanvas();
			this.showMsg(`Listening at ${(candidate.peakFrequencyHz / 1_000_000).toFixed(6)} MHz.`);
		} catch (error) {
			const previous = restoreListeningState(this);
			if (!this.running && previous?.resumeReceiver && this.connected && this.remoteMode === 'none') {
				await this.startStream(true);
			}
			const message = error instanceof Error ? error.message : String(error);
			this.showMsg(`Could not listen to sweep candidate: ${message}`);
		} finally {
			this.sweep.listenStarting = false;
		}
	},



	setSweepVisualization(this: AppInstance, visualization: 'spectrum' | 'waterfall') {
		this.sweep.visualization = visualization;
		this.drawSweepSpectrum();
	},


	resetSweepViewport(this: AppInstance) {
		this.sweep.viewportStartHz = Number(this.sweep.startMHz) * 1_000_000;
		this.sweep.viewportEndHz = Number(this.sweep.endMHz) * 1_000_000;
		this.drawSweepSpectrum();
	},

	zoomSweepSpectrum(this: AppInstance, factor: number) {
		const totalStart = Number(this.sweep.startMHz) * 1_000_000;
		const totalEnd = Number(this.sweep.endMHz) * 1_000_000;
		const totalSpan = totalEnd - totalStart;
		const oldStart = this.sweep.viewportStartHz;
		const oldSpan = this.sweep.viewportEndHz - oldStart;
		const frame = runtimeFor(this).frame;
		const minimumSpan = frame
			? Math.max(frame.resolutionHz, (frame.endHz - frame.startHz) / frame.average.length)
			: 1_000;
		const nextSpan = clamp(oldSpan * factor, minimumSpan, totalSpan);
		const center = oldStart + oldSpan / 2;
		const start = clamp(center - nextSpan / 2, totalStart, totalEnd - nextSpan);
		this.sweep.viewportStartHz = start;
		this.sweep.viewportEndHz = start + nextSpan;
		this.drawSweepSpectrum();
	},

	updateSweepDisplayRange(this: AppInstance, changed: 'min' | 'max') {
		const minimum = Number(this.sweep.displayMinDb);
		const maximum = Number(this.sweep.displayMaxDb);
		if (changed === 'min') {
			const nextMaximum = clamp(Number.isFinite(maximum) ? maximum : 0, -155, 0);
			this.sweep.displayMaxDb = nextMaximum;
			this.sweep.displayMinDb = clamp(Number.isFinite(minimum) ? minimum : -120, -160, nextMaximum - 5);
		} else {
			const nextMinimum = clamp(Number.isFinite(minimum) ? minimum : -120, -160, -5);
			this.sweep.displayMinDb = nextMinimum;
			this.sweep.displayMaxDb = clamp(Number.isFinite(maximum) ? maximum : 0, nextMinimum + 5, 0);
		}
		this.drawSweepSpectrum();
	},

	selectSweepCandidate(this: AppInstance, candidate: SweepCandidate) {
		this.sweep.selectedCandidate = candidate;
		const totalStart = Number(this.sweep.startMHz) * 1_000_000;
		const totalEnd = Number(this.sweep.endMHz) * 1_000_000;
		const totalSpan = totalEnd - totalStart;
		const currentSpan = this.sweep.viewportEndHz - this.sweep.viewportStartHz;
		const peakRangeStartHz = candidate.peakRangeStartHz ?? candidate.peakFrequencyHz;
		const peakRangeEndHz = candidate.peakRangeEndHz ?? candidate.peakFrequencyHz;
		const peakRangeCenterHz = candidate.peakRangeCenterHz ?? candidate.centerHz;
		const peakRangeSpanHz = peakRangeEndHz - peakRangeStartHz;
		const span = Math.min(totalSpan, Math.max(currentSpan, candidate.bandwidthHz * 5, peakRangeSpanHz * 1.5, 250_000));
		const center = peakRangeCenterHz;
		const start = clamp(center - span / 2, totalStart, totalEnd - span);
		this.sweep.viewportStartHz = start;
		this.sweep.viewportEndHz = start + span;
		this.drawSweepSpectrum();
	},

	sweepCanvasPointerDown(this: AppInstance, event: PointerEvent) {
		if (event.button !== 0) return;
		const canvas = event.currentTarget as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		const x = event.clientX - rect.left;
		if (x < 54 || x > rect.width - 12) return;
		const runtime = runtimeFor(this);
		runtime.dragStartX = event.clientX;
		runtime.dragStartY = event.clientY;
		runtime.dragMoved = false;
		runtime.dragStartHz = this.sweep.viewportStartHz;
		runtime.dragEndHz = this.sweep.viewportEndHz;
		canvas.setPointerCapture(event.pointerId);
	},

	sweepCanvasPointerMove(this: AppInstance, event: PointerEvent) {
		const canvas = event.currentTarget as HTMLCanvasElement;
		const rect = canvas.getBoundingClientRect();
		const runtime = runtimeFor(this);
		if (runtime.dragStartX !== null) {
			const deltaX = event.clientX - runtime.dragStartX;
			const deltaY = event.clientY - (runtime.dragStartY ?? event.clientY);
			if (!runtime.dragMoved && Math.hypot(deltaX, deltaY) > 5) runtime.dragMoved = true;
			if (runtime.dragMoved) {
				const span = runtime.dragEndHz - runtime.dragStartHz;
				const shift = -deltaX / Math.max(1, rect.width - 66) * span;
				const totalStart = Number(this.sweep.startMHz) * 1_000_000;
				const totalEnd = Number(this.sweep.endMHz) * 1_000_000;
				const start = clamp(runtime.dragStartHz + shift, totalStart, totalEnd - span);
				this.sweep.viewportStartHz = start;
				this.sweep.viewportEndHz = start + span;
				this.drawSweepSpectrum();
				return;
			}
		}
		const x = event.clientX - rect.left;
		if (x < 54 || x > rect.width - 12) return;
		const ratio = (x - 54) / Math.max(1, rect.width - 66);
		const frequencyHz = this.sweep.viewportStartHz + ratio * (this.sweep.viewportEndHz - this.sweep.viewportStartHz);
		this.sweep.hoverFrequencyHz = frequencyHz;
		const frame = runtime.frame;
		if (frame && frequencyHz >= frame.startHz && frequencyHz < frame.endHz) {
			const values = this.sweep.view === 'current' ? frame.current : this.sweep.view === 'max' ? frame.maxHold : frame.average;
			const index = Math.min(values.length - 1, Math.floor((frequencyHz - frame.startHz) / (frame.endHz - frame.startHz) * values.length));
			this.sweep.hoverPowerDb = values[index];
		} else {
			this.sweep.hoverPowerDb = null;
		}
		this.drawSweepSpectrum();
	},

	sweepCanvasPointerUp(this: AppInstance, event: PointerEvent) {
		const runtime = runtimeFor(this);
		const canvas = event.currentTarget as HTMLCanvasElement;
		const wasClick = runtime.dragStartX !== null && !runtime.dragMoved && event.type === 'pointerup';
		runtime.dragStartX = null;
		runtime.dragStartY = null;
		runtime.dragMoved = false;
		if (wasClick) void addSweepMarkerAt(this, canvas, event.clientX, event.clientY);
		if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
	},

	sweepCanvasPointerLeave(this: AppInstance) {
		const runtime = runtimeFor(this);
		if (runtime.dragStartX !== null) return;
		this.sweep.hoverFrequencyHz = null;
		this.sweep.hoverPowerDb = null;
		this.drawSweepSpectrum();
	},

	sweepCanvasWheel(this: AppInstance, event: WheelEvent) {
		const viewport = event.currentTarget as HTMLElement;
		const rect = viewport.getBoundingClientRect();
		const x = clamp(event.clientX - rect.left, 54, rect.width - 12);
		const ratio = (x - 54) / Math.max(1, rect.width - 66);
		const totalStart = Number(this.sweep.startMHz) * 1_000_000;
		const totalEnd = Number(this.sweep.endMHz) * 1_000_000;
		const totalSpan = totalEnd - totalStart;
		const oldStart = this.sweep.viewportStartHz;
		const oldSpan = this.sweep.viewportEndHz - oldStart;
		const anchor = oldStart + ratio * oldSpan;
		const frame = runtimeFor(this).frame;
		const minimumSpan = frame
			? Math.max(frame.resolutionHz, (frame.endHz - frame.startHz) / frame.average.length)
			: 1_000;
		const nextSpan = clamp(oldSpan * Math.exp(event.deltaY * 0.001), minimumSpan, totalSpan);
		const start = clamp(anchor - ratio * nextSpan, totalStart, totalEnd - nextSpan);
		this.sweep.viewportStartHz = start;
		this.sweep.viewportEndHz = start + nextSpan;
		this.drawSweepSpectrum();
	},

	drawSweepSpectrum(this: AppInstance) {
		if (this.activeWorkspace !== 'spectrum') return;
		const runtime = runtimeFor(this);
		if (runtime.drawFrame !== null) return;
		runtime.drawFrame = requestAnimationFrame(() => {
			runtime.drawFrame = null;
			if (this.activeWorkspace !== 'spectrum') return;
			if (this.sweep.visualization === 'waterfall') {
				const canvas = runtime.waterfallCanvas || this.$refs.sweepWaterfall;
				if (!canvas) return;
				runtime.waterfallCanvas = canvas;
				runtime.waterfallRenderer ||= new SweepWaterfallRenderer();
				runtime.waterfallRenderer.draw(canvas, runtime.waterfallHistory, runtime.frame, {
					viewportStartHz: this.sweep.viewportStartHz,
					viewportEndHz: this.sweep.viewportEndHz,
					minDb: this.sweep.displayMinDb,
					maxDb: this.sweep.displayMaxDb,
					selectedCandidate: this.sweep.selectedCandidate,
				});
				return;
			}
			const canvas = runtime.spectrumCanvas || this.$refs.sweepSpectrum;
			if (!canvas) return;
			runtime.spectrumCanvas = canvas;
			const options: SweepCanvasOptions = {
				view: this.sweep.view,
				startHz: this.sweep.viewportStartHz,
				endHz: this.sweep.viewportEndHz,
				selectedCandidate: this.sweep.selectedCandidate,
				hoverFrequencyHz: this.sweep.hoverFrequencyHz,
				minDb: this.sweep.displayMinDb,
				maxDb: this.sweep.displayMaxDb,
				markers: this.records.markers,
				selectedMarkerId: this.records.selectedMarkerId,
			};
			drawSweepCanvas(canvas, runtime.frame, options);
		});
	},

	disposeSweepCanvas(this: AppInstance) {
		const runtime = runtimeFor(this);
		if (runtime.drawFrame !== null) cancelAnimationFrame(runtime.drawFrame);
		runtime.drawFrame = null;
		runtime.resizeObserver?.disconnect();
		runtime.resizeObserver = null;
		runtime.spectrumCanvas = null;
		runtime.waterfallCanvas = null;
		runtime.waterfallRenderer = null;
	},
};
