/**
 * Frame side of the Ground Console bridge. When the Receiver runs inside the
 * console's same-origin iframe, the Overview dashboard starts and stops RX,
 * tunes, picks the listen mode, sets the Dengar dB scale, the Listener's gains
 * and sample rate, and draws a cropped spectrum through window.postMessage.
 * The protocol is in console-bridge-protocol.ts.
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
 * - during a scan listen every radio command is refused;
 * - during a wide scan start, stop, listen and radio are refused, while tune,
 *   vfo and gains only change the stopped Listener's settings, with no
 *   backend call (RX uses them when it starts again); a scan start that has
 *   not stopped RX yet refuses them too;
 * - display (the dB scale), marker and sweep-* commands are never refused
 *   because of a scan.
 * The marker and sweep-* commands follow this rule when they are added.
 *
 * Every console write of the centre or the active VFO goes through
 * writeTuning(), which stamps the change with the command id. Any other change
 * is the Receiver page's. receiver:status carries the stamp (tune), so the
 * console can tell a Receiver-page retune from its own.
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
	GAIN_LIMITS,
	inTuneRange,
	onGainStep,
	parseConsoleMessage,
	SAMPLE_RATES_HZ,
	VOLUME_LIMITS,
	type AudioState,
	type BusyState,
	type CommandOf,
	type ConsoleCommand,
	type ReceiverStatus,
	type ResultCode,
	type ResultTune,
	type StatusErrorCode,
	type Subscription,
	type TuneSource,
	type TuneStamp,
	type Workspace,
} from './console-bridge-protocol';

export interface ConsoleBridge {
	/** Called with every FFT frame the Listener draws. */
	spectrum(data: ArrayLike<number>): void;
	/** Whether a fresh RX start unmutes VFO 1: false while a console start without listen runs. */
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
	let statusSeq = 0;
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
	let connectInFlight: Promise<void> | null = null;
	let lifecycle: Promise<void> = Promise.resolve();
	// FFT frames drawn by a running Listener outside an RX restart; console:radio waits for the next one.
	let rxFrames = 0;

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

	function urgentKey(status: Pick<ReceiverStatus, 'running' | 'connected' | 'busy' | 'error' | 'recording'>): string {
		return `${status.running}|${status.connected}|${status.busy}|${status.error?.code ?? ''}|${status.recording}`;
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
	 * coalesced for STATUS_DEBOUNCE_MS; a running, connected, busy, error or
	 * recording change is sent at once, at most every STATUS_URGENT_MIN_MS.
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

	/** withTune: the reply of console:tune, console:vfo, console:start and console:radio, which carries the tuning after it. */
	function reply(id: string, code: ResultCode, message?: string, withTune = false): void {
		post({
			type: 'receiver:result',
			id,
			ok: code === 'OK',
			code,
			...(message ? { message } : {}),
			...(withTune ? { tune: resultTune() } : {}),
		});
		scheduleStatus();
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

	/** Start, stop, listen and radio run one after another so they never race each other. */
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
				void refreshPairedCount();
				return;
			case 'invalid':
				reply(command.id, 'INVALID_COMMAND');
				return;
			case 'console:subscribe': {
				const next = clampSubscription(command);
				if (!subscription || subscription.fps !== next.fps) throttle.setFps(next.fps);
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

	sendHello();
	sendStatusNow();
	void refreshPairedCount();

	return {
		spectrum(data: ArrayLike<number>): void {
			if (disposed || !data || !data.length) return;
			if (app.running && !app._rxRestarting) rxFrames++;
			if (!subscription?.spectrum || !app.running) return;
			if (!throttle.accept(env.monotonicNow())) return;
			const centerHz = mhzToHz(app.radio?.centerFreq);
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
		initialVfoEnabled(): boolean {
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
			if (statusTimer !== null) env.clearTimeout(statusTimer);
			if (heartbeat !== null) env.clearInterval(heartbeat);
			statusTimer = null;
			heartbeat = null;
		},
	};
}
