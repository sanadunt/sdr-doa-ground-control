/**
 * Frame side of the Ground Console bridge. When the Receiver runs inside the
 * console's same-origin iframe, the Overview dashboard starts and stops RX,
 * tunes, picks the listen mode, sets the Dengar dB scale, the Listener's gains
 * and sample rate, and draws a cropped spectrum through window.postMessage.
 * Its Spektrum mode also starts and stops the wide scan, sets the scan's
 * range, resolution, gains and Graph min./max., and draws the scan trace
 * (receiver:sweep). The protocol is in console-bridge-protocol.ts.
 *
 * The bridge only answers its parent window on the page's own origin. It
 * never opens the device picker, the VFO conflict dialog or a confirm(),
 * which would be invisible in the hidden frame; the console asks the operator
 * in its own page (console:radio confirmRecording). It sends codes, not text.
 *
 * Gains apply live through the Receiver's gains watcher (no RX restart). A
 * sample rate change restarts RX through the Receiver's own watcher, as the
 * Listener select does: console:radio takes only a rate of the device, never
 * during a scan, an armed recording only with confirmRecording, re-centres an
 * active VFO the new rate would leave out of band (raw VFOs take the new
 * rate as bandwidth), and answers once RX runs again and has drawn a frame.
 *
 * One RadioSpectrum cannot run RX and a scan at once, so SWEEP_BUSY follows
 * one rule:
 * - during a scan listen every radio command is refused, sweep-start,
 *   sweep-stop and sweep-config included;
 * - during a wide scan start, stop, listen and radio are refused, while tune,
 *   vfo and gains only change the stopped Listener's settings, with no
 *   backend call (RX uses them when it starts again); a scan start that has
 *   not stopped RX yet refuses them too;
 * - the scan itself is started and stopped only by sweep-start and
 *   sweep-stop, through the same queue and connect path as console:start
 *   (never connect(), requestWorkspace or selectWorkspace, which can open a
 *   dialog); sweep-start is answered OK while a scan already runs;
 * - sweep-config is refused while a scan starts, runs or stops: like the
 *   Receiver page, the scan settings are read-only until it has stopped;
 * - display and sweep-display (the dB scales) and marker commands are never
 *   refused because of a scan.
 *
 * Every console write of the centre or the active VFO goes through
 * writeTuning(), which stamps the change with the command id. Any other change
 * is the Receiver page's. receiver:status carries the stamp (tune), so the
 * console can tell a Receiver-page retune from its own.
 *
 * Markers: the Receiver's "Penanda spektrum" list (records.markers) is the one
 * store. receiver:markers sends it in displayed Hz (at most MARKER_LIMITS.maxSent,
 * nearest the RX centre or the running scan) on every change, at once after a
 * quiet spell and then at most every MARKERS_THROTTLE_MS. console:marker-add and
 * console:marker-remove run one after another on their own queue, never behind a
 * start, and only through addReceiverMarker and removeReceiverMarker, which save
 * to a marker set the operator selected on the Receiver page (never a new one,
 * so no name conflict asks). The bridge never calls saveMarkerSet,
 * deleteMarkerSet, selectMarkerSet or requestWorkspace, whose confirm() would be
 * invisible here. A marker result follows the receiver:markers that shows it.
 */
import type { AppInstance } from './types';
import { lookupDevice } from '../device-catalog';
import { RADIO_LOST_PREFIX, RX_STREAM_FAILED_PREFIX, WEBUSB_UNAVAILABLE_MESSAGE } from './connection';
import { LISTENER_DB_DEFAULT } from './listener-display';
import {
	BRIDGE_CHANNEL,
	BRIDGE_VERSION,
	STATUS_DEBOUNCE_MS,
	STATUS_HEARTBEAT_MS,
	STATUS_URGENT_MIN_MS,
	clampDisplayRange,
	clampSubscription,
	createFrameThrottle,
	cropSpectrum,
	decimateMaxHold,
	GAIN_LIMITS,
	isCommandId,
	inMarkerRange,
	inSweepRange,
	inTuneRange,
	MARKER_LIMITS,
	MARKERS_THROTTLE_MS,
	markersForConsole,
	onGainStep,
	parseConsoleMessage,
	SAMPLE_RATES_HZ,
	SWEEP_SOURCES,
	SWEEP_SPAN_LIMITS,
	VOLUME_LIMITS,
	type AudioState,
	type BusyState,
	type CommandOf,
	type ConsoleCommand,
	type ReceiverStatus,
	type ResultCode,
	type ResultTune,
	type StatusErrorCode,
	type StatusSweep,
	type Subscription,
	type SweepFftSize,
	type SweepPhase,
	type SweepView,
	type TuneSource,
	type TuneStamp,
	type Workspace,
} from './console-bridge-protocol';

/** What sweepFrame reads from a wide-scan frame (worker/sweep-types.ts SweepSpectrumFrame). */
export interface SweepFrameLike {
	startHz: number;
	endHz: number;
	resolutionHz: number;
	sweepCount: number;
	current: ArrayLike<number>;
	average: ArrayLike<number>;
	maxHold: ArrayLike<number>;
}

export interface ConsoleBridge {
	/**
	 * Called with every FFT frame the Listener draws, with the device Hz the
	 * worker took it at (worker/spectrum-tuning.ts): null while the radio
	 * retunes or its smoothing settles, undefined when unknown (then the
	 * Receiver's centre).
	 */
	spectrum(data: ArrayLike<number>, deviceHz?: number | null): void;
	/** Called with every frame of a running wide scan (sweep.ts). */
	sweepFrame(frame: SweepFrameLike): void;
	/** Whether a fresh RX start unmutes VFO 1: false while a console start without listen runs, as before a scan start that resumes RX. */
	initialVfoEnabled(): boolean;
	/** A device connection that started outside the bridge; console starts wait for it. */
	trackConnect(pending: Promise<unknown>): void;
	dispose(): void;
}

interface BridgeMessageEvent {
	origin: string;
	source: unknown;
	data: unknown;
}

type MessageListener = (event: BridgeMessageEvent) => void;

interface BridgeParent {
	location: { origin: string };
	postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void;
}

interface BridgeWindow {
	parent: BridgeParent | null;
	location: { origin: string };
	addEventListener(type: 'message', listener: MessageListener): void;
	removeEventListener(type: 'message', listener: MessageListener): void;
}

interface BridgeUsb {
	getDevices(): Promise<USBDevice[]>;
	addEventListener?(type: 'connect' | 'disconnect', listener: () => void): void;
	removeEventListener?(type: 'connect' | 'disconnect', listener: () => void): void;
}

interface BridgeNavigator {
	usb?: BridgeUsb;
	userActivation?: { isActive: boolean };
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ConsoleBridgeEnvironment {
	window: BridgeWindow;
	navigator: BridgeNavigator;
	/** Epoch milliseconds for tMs. */
	now(): number;
	/** Monotonic milliseconds for the spectrum throttle. */
	monotonicNow(): number;
	setTimeout(callback: () => void, ms: number): TimerHandle;
	clearTimeout(handle: TimerHandle): void;
	setInterval(callback: () => void, ms: number): TimerHandle;
	clearInterval(handle: TimerHandle): void;
}

/**
 * How long a command waits for AudioContext.resume() before reporting
 * AUDIO_BLOCKED. Without a user gesture resume() never settles; with one it can
 * take a few hundred milliseconds on some audio outputs.
 */
export const AUDIO_RESUME_WAIT_MS = 1000;
/** How long console:radio waits for RX to run again at the new rate and draw a frame. */
export const RADIO_RESTART_WAIT_MS = 10_000;
/** How often console:radio checks the restart. */
export const RADIO_POLL_MS = 50;
/** Status lists at most this many device sample rates. */
const MAX_SAMPLE_RATES = 16;
/** How long console:sweep-stop waits for a scan start or a stop already under way to end. */
export const SWEEP_STOP_WAIT_MS = 15_000;
/** The Receiver's Graph min./max. before anything is set (state.ts). */
const SWEEP_DISPLAY_DEFAULT = { minDb: -60, maxDb: 0 } as const;
/** Marker commands waiting on their queue; more are answered NOT_READY. */
export const MAX_QUEUED_MARKER_COMMANDS = 16;
/** receiver:markers names the selected marker set in at most this many characters. */
const MAX_SET_TEXT_CHARS = 80;

function browserEnvironment(): ConsoleBridgeEnvironment {
	return {
		window: window as unknown as BridgeWindow,
		navigator: navigator as unknown as BridgeNavigator,
		now: () => Date.now(),
		monotonicNow: () => performance.now(),
		setTimeout: (callback, ms) => setTimeout(callback, ms),
		clearTimeout: handle => clearTimeout(handle),
		setInterval: (callback, ms) => setInterval(callback, ms),
		clearInterval: handle => clearInterval(handle),
	};
}

/** The parent window when it is a different window on this page's origin, otherwise null. */
function sameOriginParent(win: BridgeWindow): BridgeParent | null {
	const parent = win.parent;
	if (!parent || (parent as unknown) === win) return null;
	try {
		return parent.location.origin === win.location.origin ? parent : null;
	} catch {
		// A cross-origin parent throws on location access.
		return null;
	}
}

function mhzToHz(mhz: unknown): number | null {
	return typeof mhz === 'number' && Number.isFinite(mhz) ? Math.round(mhz * 1e6) : null;
}

function finiteOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isHackRf(device: USBDevice): boolean {
	return lookupDevice(device)?.type === 'hackrf';
}

interface GainControlLike {
	name: string;
	min: number;
	max: number;
	step: number;
}

function gainControlLike(value: unknown): GainControlLike | null {
	if (!value || typeof value !== 'object') return null;
	const control = value as Record<string, unknown>;
	const numbers = [control.min, control.max, control.step];
	if (typeof control.name !== 'string' || !numbers.every(number => typeof number === 'number' && Number.isFinite(number))) return null;
	return { name: control.name, min: control.min as number, max: control.max as number, step: control.step as number };
}

/**
 * Installs the bridge when the Receiver is framed by the console on the same
 * origin. Returns null, and does nothing, in a standalone /receiver/ tab or
 * under a foreign parent.
 */
export function installConsoleBridge(app: AppInstance, environment: ConsoleBridgeEnvironment = browserEnvironment()): ConsoleBridge | null {
	const env = environment;
	const win = env.window;
	const parent = sameOriginParent(win);
	if (!parent) return null;
	const origin = win.location.origin;

	let disposed = false;
	let subscription: Subscription | null = null;
	const throttle = createFrameThrottle();
	const sweepThrottle = createFrameThrottle();
	let statusSeq = 0;
	// Shared by receiver:spectrum and receiver:sweep.
	let spectrumSeq = 0;
	let statusTimer: TimerHandle | null = null;
	let statusDueAt = 0;
	let lastStatusAt = -Infinity;
	let sentUrgentKey: string | null = null;
	let heartbeat: TimerHandle | null = null;
	// Tune attribution: see writeTuning() and noteTune().
	let tuneRev = 0;
	let tuneBy: TuneSource = 'receiver';
	let tuneId: string | null = null;
	let receiverRev = 0;
	let lastTuneKey = '';
	let pairedCount: number | null = null;
	let pairedGeneration = 0;
	let startsPending = 0;
	let pendingListen = true;
	// console:sweep-start commands received and not answered yet; sweep-config waits for them.
	let sweepStartsPending = 0;
	// While a sweep-start runs over a running RX: whether VFO 1 played, for the Receiver's resume of that RX.
	let resumeVfoEnabled: boolean | null = null;
	let connectInFlight: Promise<void> | null = null;
	let lifecycle: Promise<void> = Promise.resolve();
	// FFT frames drawn by a running Listener outside an RX restart; console:radio waits for the next one.
	let rxFrames = 0;
	// Markers: see noteMarkers() and scheduleMarkers().
	let markerRev = 0;
	let lastMarkersKey = '';
	let markersTimer: TimerHandle | null = null;
	let lastMarkersAt = -Infinity;
	let markerChain: Promise<void> = Promise.resolve();
	let markersQueued = 0;

	function post(message: Record<string, unknown>, transfer: Transferable[] = []): void {
		if (disposed) return;
		try {
			parent!.postMessage({ ch: BRIDGE_CHANNEL, v: BRIDGE_VERSION, ...message }, origin, transfer);
		} catch (error) {
			// The console page is going away; nothing to tell it.
			console.error('Receiver console bridge could not post a message:', error);
		}
	}

	function hasWebUsb(): boolean {
		return Boolean(env.navigator.usb);
	}

	function activeIndex(): number {
		const index = Number(app.activeVfoIndex);
		const count = Array.isArray(app.vfos) ? app.vfos.length : 0;
		return Number.isInteger(index) && index >= 0 && index < count ? index : 0;
	}

	function busyState(): BusyState {
		const sweep = app.sweep ?? {};
		if (sweep.active || sweep.starting || sweep.stopping) return 'sweep';
		if (sweep.listening || sweep.listenStarting) return 'scan-listen';
		return 'none';
	}

	function workspace(): Workspace {
		const value = app.activeWorkspace;
		return value === 'listener' || value === 'records' ? value : 'spectrum';
	}

	function audioState(): AudioState {
		const state = app.audioCtx?.state;
		return state === 'running' || state === 'suspended' ? state : 'none';
	}

	function statusError(): { code: StatusErrorCode } | null {
		const error = typeof app.sweep?.error === 'string' ? app.sweep.error as string : '';
		if (error === WEBUSB_UNAVAILABLE_MESSAGE) return { code: 'NO_WEBUSB' };
		if (!app.connected && error.startsWith(RADIO_LOST_PREFIX)) return { code: 'USB_LOST' };
		if (!app.running && error.startsWith(RX_STREAM_FAILED_PREFIX)) return { code: 'RX_ERROR' };
		return null;
	}

	function gains(): ReceiverStatus['gains'] {
		const values = (app.gains ?? {}) as Record<string, unknown>;
		const amp = Object.entries(values).some(([name, value]) => name.startsWith('Amp') && Number(value) > 0);
		return { lnaDb: finiteOrNull(values.LNA), vgaDb: finiteOrNull(values.VGA), amp };
	}

	/** The Dengar dB scale: Auto, and the manual range kept for Manual. */
	function displayState(): ReceiverStatus['display'] {
		const display = (app.display ?? {}) as Record<string, unknown>;
		const range = clampDisplayRange(display.minDB, display.maxDB) ?? LISTENER_DB_DEFAULT;
		return { auto: display.auto !== false, minDb: range.minDb, maxDb: range.maxDb };
	}

	function frequencyShiftHz(): number {
		return mhzToHz(app.radio?.frequencyShift) ?? 0;
	}

	function sweepPhase(): SweepPhase {
		const sweep = app.sweep ?? {};
		if (sweep.stopping) return 'stopping';
		if (sweep.starting) return 'starting';
		return sweep.active ? 'active' : 'idle';
	}

	function sweepView(): SweepView {
		const view = app.sweep?.view;
		return view === 'current' || view === 'max' ? view : 'average';
	}

	/** The wide scan: its state, the range in displayed Hz (frequency shift added) and its settings. */
	function sweepState(): StatusSweep {
		const sweep = (app.sweep ?? {}) as Record<string, unknown>;
		const fftSize: SweepFftSize = sweep.fftSize === 4096 ? 4096 : 8192;
		const shift = frequencyShiftHz();
		const display = clampDisplayRange(sweep.displayMinDb, sweep.displayMaxDb) ?? SWEEP_DISPLAY_DEFAULT;
		const source = (SWEEP_SOURCES as readonly unknown[]).includes(sweep.source) ? sweep.source as StatusSweep['source'] : 'simulated';
		const startHz = mhzToHz(sweep.startMHz);
		const stopHz = mhzToHz(sweep.endMHz);
		return {
			phase: sweepPhase(),
			source,
			startHz: startHz === null ? 0 : startHz + shift,
			stopHz: stopHz === null ? 0 : stopHz + shift,
			fftSize,
			resolutionHz: SWEEP_SPAN_LIMITS.sampleRateHz / fftSize,
			lnaDb: finiteOrNull(sweep.lnaGain),
			vgaDb: finiteOrNull(sweep.vgaGain),
			amp: sweep.ampEnabled === true,
			displayMinDb: display.minDb,
			displayMaxDb: display.maxDb,
			view: sweepView(),
		};
	}

	/** The connected device's sample rates, positive integers in its order; [] while none is connected. */
	function deviceSampleRates(): number[] {
		const rates: unknown = app.deviceCapabilities?.sampleRates;
		if (!Array.isArray(rates)) return [];
		return rates.filter((rate): rate is number => typeof rate === 'number' && Number.isInteger(rate) && rate > 0).slice(0, MAX_SAMPLE_RATES);
	}

	/** Everything a status reports except its sequence, time and tune stamp (sendStatusNow adds them). */
	function snapshot(): Omit<ReceiverStatus, 'seq' | 'tMs' | 'tune'> {
		const index = activeIndex();
		const vfo = Array.isArray(app.vfos) ? app.vfos[index] : null;
		const connected = Boolean(app.connected);
		const mock = connected && Boolean(app.mockDevice);
		const notice = app.snackbar?.show && typeof app.snackbar.message === 'string' && app.snackbar.message
			? (typeof app.tm === 'function' ? app.tm(app.snackbar.message) as string : app.snackbar.message as string)
			: null;
		return {
			webusb: hasWebUsb(),
			mockAvailable: Boolean(app.mockSdrEnabled),
			pairedCount,
			connected,
			mock,
			deviceName: connected ? (mock ? 'Mock SDR' : (String(app.info?.boardName ?? '') || null)) : null,
			running: Boolean(app.running),
			busy: busyState(),
			workspace: workspace(),
			centerHz: mhzToHz(app.radio?.centerFreq),
			sampleRateHz: finiteOrNull(app.radio?.sampleRate),
			frequencyShiftHz: mhzToHz(app.radio?.frequencyShift) ?? 0,
			gains: gains(),
			vfo: vfo ? {
				index,
				enabled: Boolean(vfo.enabled),
				mode: String(vfo.mode),
				frequencyHz: mhzToHz(vfo.freq),
				bandwidthHz: finiteOrNull(vfo.bandwidth),
				squelchEnabled: Boolean(vfo.squelchEnabled),
				squelchDb: finiteOrNull(vfo.squelchLevel),
				volume: finiteOrNull(vfo.volume),
			} : null,
			squelchOpen: Boolean(app.running && app.vfoSquelchOpen?.[index]),
			audio: audioState(),
			recording: Boolean(app.audioRecording?.armed),
			error: statusError(),
			notice,
			display: displayState(),
			sampleRatesHz: deviceSampleRates(),
			sweep: sweepState(),
		};
	}

	/** What a tune rev counts: the centre, the active VFO index and that VFO's frequency. */
	function tuneKey(): string {
		const index = activeIndex();
		const vfo = Array.isArray(app.vfos) ? app.vfos[index] : null;
		return `${mhzToHz(app.radio?.centerFreq)}|${index}|${vfo ? mhzToHz(vfo.freq) : ''}`;
	}

	/** Counts a tuning change once: id is the console command that wrote it, null for the Receiver page. */
	function noteTune(id: string | null): void {
		const key = tuneKey();
		if (key === lastTuneKey) return;
		lastTuneKey = key;
		tuneRev++;
		tuneBy = id === null ? 'receiver' : 'console';
		tuneId = id;
		if (id === null) receiverRev = tuneRev;
	}

	function tuneStamp(): TuneStamp {
		noteTune(null);
		return { rev: tuneRev, by: tuneBy, id: tuneId, receiverRev };
	}

	function resultTune(): ResultTune {
		const stamp = tuneStamp();
		const vfo = Array.isArray(app.vfos) ? app.vfos[activeIndex()] : null;
		return { ...stamp, centerHz: mhzToHz(app.radio?.centerFreq), vfoHz: vfo ? mhzToHz(vfo.freq) : null };
	}

	function urgentKey(status: Pick<ReceiverStatus, 'running' | 'connected' | 'busy' | 'error' | 'recording' | 'sweep'>): string {
		return `${status.running}|${status.connected}|${status.busy}|${status.error?.code ?? ''}|${status.recording}|${status.sweep.phase}`;
	}

	function sendStatusNow(): void {
		if (statusTimer !== null) {
			env.clearTimeout(statusTimer);
			statusTimer = null;
		}
		const stamp = tuneStamp();
		const current = snapshot();
		sentUrgentKey = urgentKey(current);
		lastStatusAt = env.monotonicNow();
		post({ type: 'receiver:status', seq: ++statusSeq, tMs: env.now(), ...current, tune: stamp });
	}

	/** Sends a status after delayMs; a status already due sooner covers this one. */
	function scheduleStatus(delayMs: number = STATUS_DEBOUNCE_MS): void {
		if (disposed) return;
		const due = env.monotonicNow() + delayMs;
		if (statusTimer !== null) {
			if (statusDueAt <= due) return;
			env.clearTimeout(statusTimer);
		}
		statusDueAt = due;
		statusTimer = env.setTimeout(() => {
			statusTimer = null;
			if (!disposed) sendStatusNow();
		}, delayMs);
	}

	/**
	 * Something the status reports changed. Typed frequencies and other edits are
	 * coalesced for STATUS_DEBOUNCE_MS; a running, connected, busy, error,
	 * recording or scan phase change is sent at once, at most every STATUS_URGENT_MIN_MS.
	 */
	function onReceiverChange(): void {
		noteTune(null);
		if (urgentKey(snapshot()) === sentUrgentKey) {
			scheduleStatus();
			return;
		}
		const waitMs = lastStatusAt + STATUS_URGENT_MIN_MS - env.monotonicNow();
		if (waitMs <= 0) sendStatusNow();
		else scheduleStatus(waitMs);
	}

	function sendHello(): void {
		post({ type: 'receiver:hello', protocol: BRIDGE_VERSION, mockAvailable: Boolean(app.mockSdrEnabled), webusb: hasWebUsb() });
	}

	/**
	 * withTune: the reply of console:tune, console:vfo, console:start and console:radio, which carries the
	 * tuning after it. fields: more result fields (markerId).
	 */
	function reply(id: string, code: ResultCode, message?: string, withTune = false, fields: Record<string, unknown> = {}): void {
		post({
			type: 'receiver:result',
			id,
			ok: code === 'OK',
			code,
			...(message ? { message } : {}),
			...(withTune ? { tune: resultTune() } : {}),
			...fields,
		});
		scheduleStatus();
	}

	function markerList(): unknown[] {
		const list: unknown = app.records?.markers;
		return Array.isArray(list) ? list : [];
	}

	/** What the sent markers are nearest to, in displayed Hz: the middle of a running scan, otherwise the RX centre. */
	function markerReferenceHz(): number | null {
		if (app.sweep?.active) {
			const sweep = sweepState();
			return (sweep.startHz + sweep.stopHz) / 2;
		}
		return mhzToHz(app.radio?.centerFreq);
	}

	function setText(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_SET_TEXT_CHARS) : null;
	}

	/** Everything receiver:markers reports, as one string; the view position only when the list is cut around it. */
	function markersKey(): string {
		const records = (app.records ?? {}) as Record<string, unknown>;
		const list = markerList();
		let key = `${String(records.selectedMarkerSetId ?? '')}|${String(records.markerSetName ?? '')}|${frequencyShiftHz()}|${list.length}`;
		for (const entry of list) {
			const marker = (entry ?? {}) as Record<string, unknown>;
			key += `|${String(marker.id)}:${String(marker.frequencyHz)}:${String(marker.powerDb)}:${String(marker.label)}`;
		}
		if (list.length > MARKER_LIMITS.maxSent) key += `|@${markerReferenceHz()}`;
		return key;
	}

	/** Counts a change of the markers once; true when there was one. */
	function noteMarkers(): boolean {
		const key = markersKey();
		if (key === lastMarkersKey) return false;
		lastMarkersKey = key;
		markerRev++;
		return true;
	}

	function sendMarkersNow(): void {
		if (markersTimer !== null) {
			env.clearTimeout(markersTimer);
			markersTimer = null;
		}
		// A change Vue has not reported to the watcher yet (a hello in between) still gets its own rev.
		noteMarkers();
		const records = (app.records ?? {}) as Record<string, unknown>;
		const shift = frequencyShiftHz();
		lastMarkersAt = env.monotonicNow();
		post({
			type: 'receiver:markers',
			rev: markerRev,
			setId: setText(records.selectedMarkerSetId),
			setName: setText(records.markerSetName),
			frequencyShiftHz: shift,
			...markersForConsole(markerList(), shift, markerReferenceHz()),
		});
	}

	/** At once after a quiet MARKERS_THROTTLE_MS, otherwise once more at its end with the latest list. */
	function scheduleMarkers(): void {
		if (disposed || markersTimer !== null) return;
		const waitMs = lastMarkersAt + MARKERS_THROTTLE_MS - env.monotonicNow();
		if (waitMs <= 0) {
			sendMarkersNow();
			return;
		}
		markersTimer = env.setTimeout(() => {
			markersTimer = null;
			if (!disposed) sendMarkersNow();
		}, waitMs);
	}

	async function pairedHackRfs(): Promise<USBDevice[]> {
		const usb = env.navigator.usb;
		if (!usb) return [];
		return (await usb.getDevices()).filter(isHackRf);
	}

	async function refreshPairedCount(): Promise<void> {
		const generation = ++pairedGeneration;
		if (!env.navigator.usb) {
			pairedCount = null;
			return;
		}
		try {
			const count = (await pairedHackRfs()).length;
			if (generation !== pairedGeneration || disposed) return;
			pairedCount = count;
			scheduleStatus();
		} catch (error) {
			console.error('Receiver console bridge could not list paired radios:', error);
		}
	}

	function setVfoFrequency(index: number, hz: number): void {
		const vfo = app.vfos[index];
		const mhz = hz / 1e6;
		vfo.freq = mhz;
		vfo.displayFreq = typeof app.formatFreq === 'function' ? app.formatFreq(mhz) : mhz.toFixed(6).padStart(10, '0');
	}

	function currentCenterHz(): number {
		return mhzToHz(app.radio.centerFreq) ?? 0;
	}

	function halfSampleRateHz(): number {
		const sampleRate = Number(app.radio.sampleRate);
		return Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate / 2 : 0;
	}

	/**
	 * The only way a console command changes the centre or the active VFO: it writes
	 * the given values and stamps the change with the command id. A Receiver-page
	 * change the watcher has not reported yet keeps its own stamp.
	 */
	function writeTuning(id: string, centerHz: number | undefined, vfoHz: number | undefined): void {
		noteTune(null);
		if (centerHz !== undefined) app.radio.centerFreq = centerHz / 1e6;
		if (vfoHz !== undefined) setVfoFrequency(activeIndex(), vfoHz);
		noteTune(id);
	}

	/**
	 * SWEEP_BUSY for tune and vfo: always during a scan listen, and during a wide
	 * scan while RX still runs (a scan start that has not stopped it yet).
	 */
	function tuneRefused(): boolean {
		const busy = busyState();
		return busy === 'scan-listen' || (busy === 'sweep' && Boolean(app.running));
	}

	/** Sets the centre and, when given, the active VFO without the VFO conflict dialog. */
	function tune(id: string, centerHz: number, vfoHz: number | undefined): ResultCode {
		if (!inTuneRange(centerHz)) return 'OUT_OF_RANGE';
		if (vfoHz !== undefined && (!inTuneRange(vfoHz) || Math.abs(vfoHz - centerHz) > halfSampleRateHz())) return 'OUT_OF_RANGE';
		if (tuneRefused()) return 'SWEEP_BUSY';
		if (!app.vfos?.[activeIndex()]) return 'NOT_READY';
		// The centerFreq watcher retunes a running radio after its 200 ms debounce; a
		// stopped radio, also one a wide scan stopped, uses the new values at its next start.
		writeTuning(id, centerHz, vfoHz);
		if (busyState() === 'none') app.updateAllBackendVfoParams();
		return 'OK';
	}

	function vfo(id: string, command: { mode?: string; frequencyHz?: number; volume?: number }): ResultCode {
		if (command.frequencyHz !== undefined && !inTuneRange(command.frequencyHz)) return 'OUT_OF_RANGE';
		if (command.volume !== undefined && (command.volume < VOLUME_LIMITS.min || command.volume > VOLUME_LIMITS.max)) return 'OUT_OF_RANGE';
		if (tuneRefused()) return 'SWEEP_BUSY';
		const index = activeIndex();
		const current = app.vfos?.[index];
		if (!current) return 'NOT_READY';
		if (command.mode !== undefined && current.mode !== command.mode) {
			current.mode = command.mode;
			app.applyModeDefaults(index);
		}
		let recentred = false;
		if (command.frequencyHz !== undefined) {
			recentred = Math.abs(command.frequencyHz - currentCenterHz()) > halfSampleRateHz();
			writeTuning(id, recentred ? command.frequencyHz : undefined, command.frequencyHz);
		}
		if (command.volume !== undefined) current.volume = command.volume;
		// A wide scan owns the radio: the Listener keeps the settings for its next start.
		if (busyState() !== 'none') return 'OK';
		if (recentred) app.updateAllBackendVfoParams();
		else app.updateBackendVfoParams(index);
		return 'OK';
	}

	/**
	 * The Dengar dB scale. Only the display changes, so it is allowed during a
	 * scan; the Receiver's display watcher redraws and saves it.
	 */
	function display(command: CommandOf<'console:display'>): ResultCode {
		const current = app.display;
		if (!current || typeof current !== 'object') return 'NOT_READY';
		if (command.minDb !== undefined && command.maxDb !== undefined) {
			current.minDB = command.minDb;
			current.maxDB = command.maxDb;
		}
		current.auto = command.auto;
		return 'OK';
	}

	/** The embedded build has no remote host or client; a remote session would own these settings. */
	function remoteSession(): boolean {
		return (app.remoteMode ?? 'none') !== 'none';
	}

	/**
	 * The Listener's gain control for LNA, VGA or the RF amp: the connected
	 * device's own (null when it has none), otherwise the RadioSpectrum limits
	 * under the names the device will use.
	 */
	function gainControl(kind: 'lna' | 'vga' | 'amp'): GainControlLike | null {
		const matches = (name: string) => (kind === 'amp' ? name.startsWith('Amp') : name === (kind === 'lna' ? 'LNA' : 'VGA'));
		const list: unknown = app.deviceCapabilities?.gainControls;
		if (Array.isArray(list)) {
			for (const entry of list) {
				const control = gainControlLike(entry);
				if (control && matches(control.name)) return control;
			}
			return null;
		}
		if (kind !== 'amp') return { name: kind === 'lna' ? 'LNA' : 'VGA', ...GAIN_LIMITS[kind] };
		const saved = Object.keys((app.gains ?? {}) as Record<string, unknown>).find(matches);
		return { name: saved ?? 'Amp (14dB)', min: 0, max: 1, step: 1 };
	}

	/**
	 * The Listener's LNA, VGA and RF amp. The Receiver's gains watcher applies
	 * them to a running radio and saves them; during a wide scan they wait for
	 * the next RX start, like a tune. Every value is checked before any is written.
	 */
	function applyGains(command: CommandOf<'console:gains'>): ResultCode {
		if (remoteSession()) return 'NOT_READY';
		if (tuneRefused()) return 'SWEEP_BUSY';
		const current = app.gains as Record<string, number> | null | undefined;
		if (!current || typeof current !== 'object') return 'NOT_READY';
		const writes: Array<[string, number]> = [];
		for (const [kind, value] of [['lna', command.lnaDb], ['vga', command.vgaDb]] as const) {
			if (value === undefined) continue;
			const control = gainControl(kind);
			if (!control || !onGainStep(value, control)) return 'OUT_OF_RANGE';
			writes.push([control.name, value]);
		}
		if (command.amp !== undefined) {
			const control = gainControl('amp');
			if (!control) return 'OUT_OF_RANGE';
			writes.push([control.name, command.amp ? control.max : control.min]);
		}
		for (const [name, value] of writes) current[name] = value;
		return 'OK';
	}

	function delay(ms: number): { promise: Promise<void>; cancel(): void } {
		let handle: TimerHandle | null = null;
		const promise = new Promise<void>(resolve => {
			handle = env.setTimeout(resolve, ms);
		});
		return { promise, cancel: () => { if (handle !== null) env.clearTimeout(handle); } };
	}

	/** Resumes audio inside the activation the console's click passed to this frame. */
	async function ensureAudio(): Promise<ResultCode> {
		const context = app.audioCtx;
		if (!context) return 'AUDIO_BLOCKED';
		if (context.state !== 'running' && typeof context.resume === 'function') {
			// resume() stays pending without a user gesture; do not wait for it forever.
			const wait = delay(AUDIO_RESUME_WAIT_MS);
			const resumed = (async () => {
				try {
					await context.resume();
				} catch {
					// A refused or closed context is reported through its state below.
				}
			})();
			try {
				await Promise.race([resumed, wait.promise]);
			} finally {
				wait.cancel();
			}
		}
		return app.audioCtx?.state === 'running' ? 'OK' : 'AUDIO_BLOCKED';
	}

	/** The Receiver's notice since `before`, through tm(), or undefined. */
	function noticeSince(before: unknown): string | undefined {
		const notice = app.snackbar?.message;
		if (typeof notice !== 'string' || !notice || notice === before) return undefined;
		return typeof app.tm === 'function' ? app.tm(notice) as string : notice;
	}

	/** The Receiver's latest notice, through tm(), or undefined: for a failure that repeats the previous text. */
	function currentNotice(): string | undefined {
		return noticeSince(undefined);
	}

	/**
	 * Sets the Listener's sample rate. The Receiver's [sampleRate, fftSize]
	 * watcher restarts a running RX (as the Listener select does), which resumes
	 * an armed recording in a new segment and recreates the AudioContext. The
	 * answer waits until that restart is over, RX runs and a frame is drawn.
	 */
	async function applySampleRate(command: CommandOf<'console:radio'>): Promise<[ResultCode, string?]> {
		const rate = command.sampleRateHz;
		const supported = (): boolean => {
			const deviceRates = deviceSampleRates();
			return (SAMPLE_RATES_HZ as readonly number[]).includes(rate) && (deviceRates.length === 0 || deviceRates.includes(rate));
		};
		if (!supported()) return ['OUT_OF_RANGE'];
		if (remoteSession()) return ['NOT_READY'];
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (!app.radio || !app.vfos?.[activeIndex()]) return ['NOT_READY'];
		// An auto-connect may still be opening the radio and read its device list.
		if (connectInFlight) await connectInFlight;
		if (!supported()) return ['OUT_OF_RANGE'];
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (Number(app.radio.sampleRate) === rate) return ['OK'];
		const running = Boolean(app.running);
		if (running && (app.audioRecording?.armed || app.audioRecording?.starting) && command.confirmRecording !== true) return ['RECORDING_ACTIVE'];

		const index = activeIndex();
		const active = app.vfos[index];
		const audible = running && Boolean(active.enabled) && audioState() === 'running';
		// The DSP silently disables a VFO outside ±rate/2 of the centre: keep the one in use.
		const vfoHz = mhzToHz(active.freq);
		if (vfoHz !== null && inTuneRange(vfoHz) && Math.abs(vfoHz - currentCenterHz()) > rate / 2) writeTuning(command.id, vfoHz, undefined);
		for (const each of app.vfos) {
			if (each && each.mode === 'raw') each.bandwidth = rate;
		}
		const noticeBefore = app.snackbar?.message;
		const framesBefore = rxFrames;
		app.radio.sampleRate = rate;
		if (!running) return ['OK'];

		// Vue runs the Receiver's watcher before the next tick; it marks the restart at once.
		if (typeof app.$nextTick === 'function') await app.$nextTick();
		const deadline = env.monotonicNow() + RADIO_RESTART_WAIT_MS;
		for (;;) {
			const restarting = Boolean(app._rxRestarting);
			// startStream draws frames before it has set up the VFOs and created the new AudioContext;
			// an audible VFO waits for that context, or the check below would find none.
			if (!restarting && app.running && rxFrames > framesBefore && (!audible || app.audioCtx)) break;
			// A restart that did not bring RX back (the stream failed to start).
			if (!restarting && !app.running) return ['CONNECT_FAILED', noticeSince(noticeBefore)];
			if (env.monotonicNow() >= deadline) break;
			const wait = delay(RADIO_POLL_MS);
			await wait.promise;
		}
		if (!app.running) return ['CONNECT_FAILED', noticeSince(noticeBefore)];
		// The restart closed the AudioContext; without the click's activation it may stay suspended.
		return [audible ? await ensureAudio() : 'OK'];
	}

	function setListening(index: number, enabled: boolean): void {
		const current = app.vfos[index];
		if (Boolean(current.enabled) === enabled && !enabled) return;
		current.enabled = enabled;
		app.toggleVfoCheckbox(index);
	}

	async function listen(enabled: boolean): Promise<ResultCode> {
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		if (enabled && !app.running) return 'RX_NOT_RUNNING';
		const index = activeIndex();
		if (!app.vfos?.[index]) return 'NOT_READY';
		setListening(index, enabled);
		return enabled ? ensureAudio() : 'OK';
	}

	async function stop(): Promise<ResultCode> {
		if (busyState() !== 'none') return 'SWEEP_BUSY';
		if (app.running) await app.togglePlay();
		return 'OK';
	}

	/** Connects the radio for a console start; a code when it cannot, otherwise null. */
	async function connectForStart(mock: boolean): Promise<[ResultCode, string?] | null> {
		const noticeBefore = app.snackbar?.message;
		const failure = (): [ResultCode, string?] => {
			const notice = app.snackbar?.message;
			const message = typeof notice === 'string' && notice && notice !== noticeBefore
				? (typeof app.tm === 'function' ? app.tm(notice) as string : notice)
				: undefined;
			return ['CONNECT_FAILED', message];
		};
		try {
			if (mock) {
				if (!app.mockSdrEnabled) return ['MOCK_UNAVAILABLE'];
				await app.connectMock();
				return app.connected ? null : failure();
			}
			if (!env.navigator.usb) return ['NO_WEBUSB'];
			const devices = await pairedHackRfs();
			pairedCount = devices.length;
			if (devices.length > 1) return ['NEEDS_DEVICE_CHOICE'];
			if (devices.length === 1) {
				await app.connectToDevice(devices[0]);
				return app.connected ? null : failure();
			}
			// The browser chooser needs the activation of the console click that sent
			// this command; without it the operator pairs on the Receiver page.
			if (!env.navigator.userActivation?.isActive) return ['NEEDS_PAIRING'];
			await app.pairNewDevice();
			if (app.connected) return null;
			const paired = await pairedHackRfs();
			pairedCount = paired.length;
			return paired.length === 0 ? ['NEEDS_PAIRING'] : failure();
		} catch (error) {
			return ['CONNECT_FAILED', errorText(error)];
		}
	}

	async function start(command: CommandOf<'console:start'>): Promise<[ResultCode, string?]> {
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (!app.backend) return ['NOT_READY'];
		const { centerHz, vfoHz, mode } = command;
		if ((centerHz !== undefined && !inTuneRange(centerHz)) || (vfoHz !== undefined && !inTuneRange(vfoHz))) return ['OUT_OF_RANGE'];
		if (centerHz !== undefined && vfoHz !== undefined && Math.abs(vfoHz - centerHz) > halfSampleRateHz()) return ['OUT_OF_RANGE'];
		if (mode !== undefined) {
			const code = vfo(command.id, { mode });
			if (code !== 'OK') return [code];
		}
		if (centerHz !== undefined) {
			const code = tune(command.id, centerHz, vfoHz);
			if (code !== 'OK') return [code];
		} else if (vfoHz !== undefined) {
			const code = vfo(command.id, { frequencyHz: vfoHz });
			if (code !== 'OK') return [code];
		}

		// An auto-connect of the authorised HackRF may already be opening the radio.
		if (connectInFlight) await connectInFlight;
		if (busyState() !== 'none') return ['SWEEP_BUSY'];
		if (!app.connected) {
			const failure = await connectForStart(command.mock);
			if (failure) return failure;
		}
		if (!app.running) await app.startStream();
		if (!app.running) {
			const notice = app.snackbar?.message;
			return ['CONNECT_FAILED', typeof notice === 'string' && notice ? (typeof app.tm === 'function' ? app.tm(notice) as string : notice) : undefined];
		}
		// The Receiver page then opens on the running Listener, not the wide-scan view.
		if (app.activeWorkspace === 'spectrum') app.activeWorkspace = 'listener';
		const index = activeIndex();
		if (!app.vfos?.[index]) return ['OK'];
		// The dashboard decides whether this start is audible, also when RX was already
		// running or an auto-connect started it before this command arrived.
		setListening(index, command.listen);
		return [command.listen ? await ensureAudio() : 'OK'];
	}

	function recordingArmed(): boolean {
		return Boolean(app.audioRecording?.armed || app.audioRecording?.starting);
	}

	/**
	 * Starts the wide scan over the Receiver's own range. A connected radio
	 * scans with its hardware sweep; without one, a mock start runs the
	 * simulated scan (the Mock SDR has no sweep) and a real one connects the
	 * one authorised RadioSpectrum first, as console:start does. The scan stops
	 * RX, which ends an armed recording, so that needs confirmRecording. The
	 * Receiver page then shows it in its Spektrum workspace. A start that
	 * fails, or is stopped on the way, resumes the RX it stopped (sweep.ts);
	 * VFO 1 then plays or stays muted as it did before.
	 */
	async function sweepStart(command: CommandOf<'console:sweep-start'>): Promise<[ResultCode, string?]> {
		// RX the operator had running before this command; a Receiver-page stop of the scan resumes it.
		const rxWasRunning = Boolean(app.running);
		const playing = rxWasRunning && audioState() === 'running' && Array.isArray(app.vfos) && app.vfos.some((vfo: { enabled?: unknown } | null) => Boolean(vfo?.enabled));
		resumeVfoEnabled = rxWasRunning ? Boolean(app.vfos?.[0]?.enabled) : null;
		try {
			const answer = await startScan(command, rxWasRunning);
			// The resumed RX has a new AudioContext; without the click's activation it may stay suspended.
			if (playing && app.running && !app.sweep?.active) await ensureAudio();
			return answer;
		} finally {
			resumeVfoEnabled = null;
		}
	}

	async function startScan(command: CommandOf<'console:sweep-start'>, rxWasRunning: boolean): Promise<[ResultCode, string?]> {
		const sweep = app.sweep;
		if (remoteSession() || !sweep || typeof sweep !== 'object') return ['NOT_READY'];
		const check = (): [ResultCode] | null => {
			const busy = busyState();
			if (busy === 'scan-listen' || sweep.stopping) return ['SWEEP_BUSY'];
			return busy === 'sweep' ? ['OK'] : null;
		};
		const early = check();
		if (early) return early;
		if (!app.backend) return ['NOT_READY'];
		if (rxWasRunning && recordingArmed() && command.confirmRecording !== true) return ['RECORDING_ACTIVE'];
		// An auto-connect of the authorised HackRF may already be opening the radio.
		if (connectInFlight) await connectInFlight;
		const late = check();
		if (late) return late;
		if (app.running && recordingArmed() && command.confirmRecording !== true) return ['RECORDING_ACTIVE'];

		let hardware: boolean;
		if (app.connected && !app.mockDevice) hardware = true;
		else if (command.mock) {
			if (!app.mockSdrEnabled) return ['MOCK_UNAVAILABLE'];
			hardware = false;
		} else if (app.connected) hardware = true;
		else {
			const failure = await connectForStart(false);
			if (failure) return failure;
			hardware = true;
		}
		const settled = check();
		if (settled) return settled;

		const noticeBefore = app.snackbar?.message;
		let pending: Promise<unknown>;
		if (hardware) {
			const capabilities = app.deviceCapabilities;
			if (!capabilities?.supportsNativeSweep && !capabilities?.supportsManualSweep) return ['SWEEP_UNSUPPORTED'];
			pending = app.startHardwareSweep();
		} else {
			sweep.source = 'simulated';
			pending = app.startSweep();
		}
		// startSweep sets starting and clears the scan error before its first await; a start it
		// refuses with only a notice never gets that far.
		const begun = Boolean(sweep.starting || sweep.active);
		await pending;
		if (!sweep.active) {
			// A start someone stopped on the way is no failure; a refused one, or one that raised a
			// scan error (also the same error as last time), is.
			const failed = !begun || (typeof sweep.error === 'string' && sweep.error !== '');
			return failed ? ['SWEEP_FAILED', noticeSince(noticeBefore) ?? currentNotice()] : ['OK'];
		}
		sweep.returnToRx = rxWasRunning;
		if (app.activeWorkspace !== 'spectrum') {
			app.activeWorkspace = 'spectrum';
			if (typeof app.$nextTick === 'function') await app.$nextTick();
			if (typeof app.initSweepCanvas === 'function') app.initSweepCanvas();
		}
		return ['OK'];
	}

	/**
	 * Stops the wide scan; RX starts again only with resumeRx and when it ran
	 * before the scan. A scan that is still starting stops once it gets there,
	 * and a stop already under way is waited for, so the next queued command
	 * (a console:start from Dengar) finds the radio free.
	 */
	async function sweepStop(command: CommandOf<'console:sweep-stop'>): Promise<[ResultCode, string?]> {
		const sweep = app.sweep;
		if (!sweep || typeof sweep !== 'object') return ['NOT_READY'];
		const busy = busyState();
		if (busy === 'scan-listen') return ['SWEEP_BUSY'];
		if (busy === 'none') return ['OK'];
		const noticeBefore = app.snackbar?.message;
		await app.stopSweep(command.resumeRx);
		const deadline = env.monotonicNow() + SWEEP_STOP_WAIT_MS;
		while ((sweep.starting || sweep.stopping) && env.monotonicNow() < deadline) {
			const wait = delay(RADIO_POLL_MS);
			await wait.promise;
		}
		if (sweep.active || sweep.starting || sweep.stopping) return ['SWEEP_FAILED', noticeSince(noticeBefore)];
		return ['OK'];
	}

	/**
	 * The scan's range (displayed Hz), resolution and gains, written to the
	 * Receiver's scan settings, which it saves. Refused while a scan starts,
	 * runs or stops, and while a sweep-start waits; every value is checked
	 * before any is written.
	 */
	function sweepConfig(command: CommandOf<'console:sweep-config'>): ResultCode {
		const sweep = app.sweep;
		if (remoteSession() || !sweep || typeof sweep !== 'object') return 'NOT_READY';
		if (busyState() !== 'none' || sweepStartsPending > 0) return 'SWEEP_BUSY';
		const shift = frequencyShiftHz();
		const fftSize = command.fftSize ?? (sweep.fftSize === 4096 ? 4096 : 8192);
		const rangeChanged = command.startHz !== undefined || command.stopHz !== undefined;
		const startHz = command.startHz ?? (mhzToHz(sweep.startMHz) ?? 0) + shift;
		const stopHz = command.stopHz ?? (mhzToHz(sweep.endMHz) ?? 0) + shift;
		if ((rangeChanged || command.fftSize !== undefined) && !inSweepRange(startHz, stopHz, fftSize, shift)) return 'OUT_OF_RANGE';
		if (command.lnaDb !== undefined && !onGainStep(command.lnaDb, GAIN_LIMITS.lna)) return 'OUT_OF_RANGE';
		if (command.vgaDb !== undefined && !onGainStep(command.vgaDb, GAIN_LIMITS.vga)) return 'OUT_OF_RANGE';
		if (rangeChanged) {
			sweep.startMHz = (startHz - shift) / 1e6;
			sweep.endMHz = (stopHz - shift) / 1e6;
		}
		if (command.fftSize !== undefined) sweep.fftSize = command.fftSize;
		if (command.lnaDb !== undefined) sweep.lnaGain = command.lnaDb;
		if (command.vgaDb !== undefined) sweep.vgaGain = command.vgaDb;
		if (command.amp !== undefined) sweep.ampEnabled = command.amp;
		return 'OK';
	}

	/** The scan's Graph min./max.: display only, so it is allowed in every state. */
	function sweepDisplay(command: CommandOf<'console:sweep-display'>): ResultCode {
		const sweep = app.sweep;
		if (!sweep || typeof sweep !== 'object') return 'NOT_READY';
		sweep.displayMinDb = command.minDb;
		sweep.displayMaxDb = command.maxDb;
		if (typeof app.drawSweepSpectrum === 'function') app.drawSweepSpectrum();
		return 'OK';
	}

	/** The Receiver's records error, through tm(), for a marker save that failed. */
	function recordsError(): string | undefined {
		const error: unknown = app.records?.error;
		if (typeof error !== 'string' || !error) return undefined;
		return typeof app.tm === 'function' ? app.tm(error) as string : error;
	}

	/**
	 * The power the Receiver would store for a marker at this device frequency: from the running
	 * scan's own frame (sweep.ts sweepPowerAt, as a click on its canvas measures it), otherwise null.
	 * The dock's RX trace is dBFS of another scale, so an RX marker has no power.
	 */
	function scanPowerAt(deviceHz: number): number | null {
		if (!app.sweep?.active || typeof app.sweepPowerAt !== 'function') return null;
		return finiteOrNull(app.sweepPowerAt(deviceHz));
	}

	type MarkerReply = [ResultCode, string?, Record<string, unknown>?];

	/**
	 * Adds a marker to the Receiver's list as a click on its Spektrum canvas does, saved to the
	 * selected marker set. Allowed in every radio state: it does not touch the radio.
	 */
	async function markerAdd(command: CommandOf<'console:marker-add'>): Promise<MarkerReply> {
		const records = app.records;
		if (!records || !Array.isArray(records.markers) || typeof app.addReceiverMarker !== 'function') return ['NOT_READY'];
		const shift = frequencyShiftHz();
		if (!inMarkerRange(command.frequencyHz, shift)) return ['OUT_OF_RANGE'];
		if (records.markers.length >= MARKER_LIMITS.maxTotal) return ['MARKER_LIMIT'];
		const deviceHz = command.frequencyHz - shift;
		const added: unknown = await app.addReceiverMarker(deviceHz, scanPowerAt(deviceHz));
		if (!added || typeof added !== 'object') return ['NOT_READY', recordsError()];
		const { id, saved } = added as { id?: unknown; saved?: unknown };
		const fields = isCommandId(id) ? { markerId: id } : {};
		// The marker stays in the list; only the save to the set failed.
		if (saved === false) return ['MARKER_SAVE_FAILED', recordsError(), fields];
		return ['OK', undefined, fields];
	}

	async function markerRemove(command: CommandOf<'console:marker-remove'>): Promise<MarkerReply> {
		const records = app.records;
		if (!records || !Array.isArray(records.markers) || typeof app.removeReceiverMarker !== 'function') return ['NOT_READY'];
		if (!records.markers.some((marker: { id?: unknown } | null) => marker?.id === command.markerId)) return ['MARKER_NOT_FOUND'];
		const removed: unknown = await app.removeReceiverMarker(command.markerId);
		if (removed && typeof removed === 'object' && (removed as { saved?: unknown }).saved === false) return ['MARKER_SAVE_FAILED', recordsError()];
		return ['OK'];
	}

	/**
	 * Marker commands run one after another on their own queue, so two quick adds never race their
	 * saves, and never wait behind a start. The list that shows the change is posted before the reply.
	 */
	function enqueueMarker(id: string, task: () => Promise<MarkerReply>): void {
		if (markersQueued >= MAX_QUEUED_MARKER_COMMANDS) {
			reply(id, 'NOT_READY');
			return;
		}
		markersQueued++;
		const run = async (): Promise<void> => {
			let result: MarkerReply;
			try {
				result = await task();
			} catch (error) {
				result = ['NOT_READY', errorText(error)];
			} finally {
				markersQueued--;
			}
			if (noteMarkers() || markersTimer !== null) sendMarkersNow();
			reply(id, result[0], result[1], false, result[2]);
		};
		markerChain = markerChain.then(run, run);
	}

	/** Start, stop, listen, radio and the scan's start and stop run one after another so they never race each other. */
	function enqueue(
		id: string,
		task: () => Promise<[ResultCode, string?]>,
		options: { fallback: ResultCode; done?: () => void; withTune?: boolean },
	): void {
		const run = async (): Promise<void> => {
			let result: [ResultCode, string?];
			try {
				result = await task();
			} catch (error) {
				result = [options.fallback, errorText(error)];
			} finally {
				options.done?.();
			}
			reply(id, result[0], result[1], options.withTune === true);
		};
		lifecycle = lifecycle.then(run, run);
	}

	function handle(command: ConsoleCommand): void {
		switch (command.type) {
			case 'console:hello':
				sendHello();
				sendStatusNow();
				sendMarkersNow();
				void refreshPairedCount();
				return;
			case 'invalid':
				reply(command.id, 'INVALID_COMMAND');
				return;
			case 'console:subscribe': {
				const next = clampSubscription(command);
				if (!subscription || subscription.fps !== next.fps) {
					throttle.setFps(next.fps);
					sweepThrottle.setFps(next.fps);
				}
				subscription = next;
				if (heartbeat === null) heartbeat = env.setInterval(() => { if (!disposed) sendStatusNow(); }, STATUS_HEARTBEAT_MS);
				reply(command.id, 'OK');
				return;
			}
			case 'console:tune': {
				let code: ResultCode;
				try {
					code = tune(command.id, command.centerHz, command.vfoHz);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error), true);
					return;
				}
				reply(command.id, code, undefined, true);
				return;
			}
			case 'console:vfo': {
				let code: ResultCode;
				try {
					code = vfo(command.id, command);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error), true);
					return;
				}
				reply(command.id, code, undefined, true);
				return;
			}
			case 'console:start':
				// Set before the queue runs: an auto-connect that is already opening the
				// radio reads it when its RX starts.
				startsPending++;
				pendingListen = command.listen;
				enqueue(command.id, () => start(command), { fallback: 'CONNECT_FAILED', done: () => { startsPending--; }, withTune: true });
				return;
			case 'console:stop':
				enqueue(command.id, async () => [await stop()], { fallback: 'NOT_READY' });
				return;
			case 'console:listen':
				enqueue(command.id, async () => [await listen(command.enabled)], { fallback: 'NOT_READY' });
				return;
			case 'console:display': {
				let code: ResultCode;
				try {
					code = display(command);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error));
					return;
				}
				reply(command.id, code);
				return;
			}
			case 'console:gains': {
				let code: ResultCode;
				try {
					code = applyGains(command);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error));
					return;
				}
				reply(command.id, code);
				return;
			}
			case 'console:radio':
				// After any start or stop before it; its re-centre is a tuning change, so the result carries tune.
				enqueue(command.id, () => applySampleRate(command), { fallback: 'NOT_READY', withTune: true });
				return;
			case 'console:sweep-start':
				// Like console:start: an auto-connect that is already opening the radio, or the connect
				// of this command, starts RX with VFO 1 muted before the scan stops it.
				startsPending++;
				pendingListen = false;
				sweepStartsPending++;
				enqueue(command.id, () => sweepStart(command), {
					fallback: 'SWEEP_FAILED',
					done: () => { startsPending--; sweepStartsPending--; },
				});
				return;
			case 'console:sweep-stop':
				enqueue(command.id, () => sweepStop(command), { fallback: 'SWEEP_FAILED' });
				return;
			case 'console:sweep-config':
			case 'console:sweep-display': {
				let code: ResultCode;
				try {
					code = command.type === 'console:sweep-config' ? sweepConfig(command) : sweepDisplay(command);
				} catch (error) {
					reply(command.id, 'NOT_READY', errorText(error));
					return;
				}
				reply(command.id, code);
				return;
			}
			case 'console:marker-add':
				enqueueMarker(command.id, () => markerAdd(command));
				return;
			case 'console:marker-remove':
				enqueueMarker(command.id, () => markerRemove(command));
				return;
		}
	}

	const onMessage: MessageListener = event => {
		if (disposed || event.origin !== origin || event.source !== parent) return;
		const command = parseConsoleMessage(event.data);
		if (command) handle(command);
	};

	const onUsbChange = (): void => { void refreshPairedCount(); };

	win.addEventListener('message', onMessage);
	const usb = env.navigator.usb;
	if (usb && typeof usb.addEventListener === 'function') {
		usb.addEventListener('connect', onUsbChange);
		usb.addEventListener('disconnect', onUsbChange);
	}
	// The tuning at install is the baseline; only later changes count.
	lastTuneKey = tuneKey();
	const unwatch: (() => void) | null = typeof app.$watch === 'function'
		? app.$watch(() => JSON.stringify(snapshot()), () => onReceiverChange())
		: null;
	// The markers at install are rev 0; every later change (Receiver page or console) counts once.
	lastMarkersKey = markersKey();
	const unwatchMarkers: (() => void) | null = typeof app.$watch === 'function'
		? app.$watch(() => markersKey(), () => { if (noteMarkers()) scheduleMarkers(); })
		: null;

	sendHello();
	sendStatusNow();
	sendMarkersNow();
	void refreshPairedCount();

	return {
		spectrum(data: ArrayLike<number>, deviceHz?: number | null): void {
			if (disposed || !data || !data.length) return;
			if (app.running && !app._rxRestarting) rxFrames++;
			if (!subscription?.spectrum || !app.running) return;
			// Taken while the radio retuned: it belongs to no one centre, so the dock keeps its last frame.
			if (deviceHz === null) return;
			if (!throttle.accept(env.monotonicNow())) return;
			// The centre the stream was tuned to, in displayed Hz; the Receiver's centre moves before its
			// debounced setFrequency reaches the radio.
			const tunedHz = deviceHz === undefined ? null : finiteOrNull(deviceHz);
			const centerHz = deviceHz === undefined ? mhzToHz(app.radio?.centerFreq) : tunedHz === null ? null : Math.round(tunedHz + frequencyShiftHz());
			const sampleRateHz = finiteOrNull(app.radio?.sampleRate);
			if (centerHz === null || sampleRateHz === null) return;
			const cropped = cropSpectrum(data, centerHz, sampleRateHz, subscription.spanHz, subscription.bins);
			if (!cropped) return;
			post({
				type: 'receiver:spectrum',
				seq: ++spectrumSeq,
				tMs: env.now(),
				centerHz,
				startHz: cropped.startHz,
				stopHz: cropped.stopHz,
				sampleRateHz,
				fftSize: data.length,
				binCount: cropped.bins.length,
				bins: cropped.bins,
			}, [cropped.bins.buffer]);
		},
		sweepFrame(frame: SweepFrameLike): void {
			if (disposed || !subscription?.spectrum || !app.sweep?.active || !frame) return;
			const view = sweepView();
			const values = view === 'current' ? frame.current : view === 'max' ? frame.maxHold : frame.average;
			const startHz = finiteOrNull(frame.startHz);
			const endHz = finiteOrNull(frame.endHz);
			if (!values || !values.length || startHz === null || endHz === null || endHz <= startHz) return;
			if (!sweepThrottle.accept(env.monotonicNow())) return;
			// A copy at most `bins` long; the Receiver keeps drawing its own frame.
			const bins = decimateMaxHold(values, subscription.bins);
			const shift = frequencyShiftHz();
			post({
				type: 'receiver:sweep',
				seq: ++spectrumSeq,
				tMs: env.now(),
				startHz: Math.round(startHz + shift),
				stopHz: Math.round(endHz + shift),
				resolutionHz: finiteOrNull(frame.resolutionHz),
				sweepCount: finiteOrNull(frame.sweepCount),
				view,
				binCount: bins.length,
				bins,
			}, [bins.buffer]);
		},
		initialVfoEnabled(): boolean {
			if (resumeVfoEnabled !== null) return resumeVfoEnabled;
			return startsPending > 0 ? pendingListen : true;
		},
		trackConnect(pending: Promise<unknown>): void {
			const settled = Promise.resolve(pending).then(() => undefined, () => undefined);
			connectInFlight = settled;
			void settled.then(() => {
				if (connectInFlight === settled) connectInFlight = null;
			});
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			win.removeEventListener('message', onMessage);
			if (usb && typeof usb.removeEventListener === 'function') {
				usb.removeEventListener('connect', onUsbChange);
				usb.removeEventListener('disconnect', onUsbChange);
			}
			unwatch?.();
			unwatchMarkers?.();
			if (statusTimer !== null) env.clearTimeout(statusTimer);
			if (heartbeat !== null) env.clearInterval(heartbeat);
			if (markersTimer !== null) env.clearTimeout(markersTimer);
			statusTimer = null;
			heartbeat = null;
			markersTimer = null;
		},
	};
}
