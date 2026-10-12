export interface VfoAudioMetadata {
	mode: string;
	bandwidthHz: number;
}

export interface AudioChunkUsage {
	sessionBytes: number;
	segmentBytes: number;
	maxSessionBytes: number;
	maxSegmentBytes: number;
}

export interface AudioRecordingApi {
	createSession(): Promise<string>;
	createSegment(
		sessionId: string,
		metadata: {
			vfo_index: number;
			frequency_hz: number;
			mode: string;
			bandwidth_hz: number;
			codec: string;
			started_at: string;
		},
	): Promise<string>;
	appendChunk(segmentId: string, chunk: Blob): Promise<AudioChunkUsage | void>;
	finishSegment(
		segmentId: string,
		metadata: { ended_at: string; duration_seconds: number; status?: 'complete' | 'failed'; error?: string },
	): Promise<void>;
	finishSession(sessionId: string, options?: { finalizeOpenSegments?: boolean; keepalive?: boolean }): Promise<void>;
}

export type RecorderPort = MediaRecorder;

export type AudioDestinationPort = MediaStreamAudioDestinationNode;

export type AudioSourcePort = AudioBufferSourceNode;

export interface RecorderMediaFactory {
	createDestination(context: AudioContext): AudioDestinationPort;
	createRecorder(stream: MediaStream, mimeType: string): RecorderPort;
	now(): number;
	sleep?(ms: number): Promise<void>;
}

export interface RecorderStatus {
	/** notice: recording continues, but the operator should know something changed. */
	state: 'armed' | 'disarmed' | 'error' | 'notice';
	message?: string;
	error?: unknown;
	vfoIndex?: number;
}

interface SegmentState {
	vfoIndex: number;
	frequencyHz: number;
	metadata: VfoAudioMetadata;
	id: string;
	startedAt: number;
	destination: AudioDestinationPort;
	recorder: RecorderPort;
	nextTime: number;
	sources: Set<AudioSourcePort>;
	appendQueue: Promise<void>;
	appendError: unknown;
	/** After a chunk is lost the rest of this WebM stream cannot be appended; a new segment takes over. */
	broken: boolean;
	rollingOver: boolean;
	stopped: Promise<void>;
	resolveStopped: () => void;
}

const CODEC = 'audio/webm;codecs=opus';
const SAMPLE_RATE = 48_000;
const APPEND_RETRY_DELAYS_MS = [500, 1_500, 4_000];
const OPEN_RETRY_COOLDOWN_MS = 5_000;
// Roll over before the console's per-segment and per-session limits so audio is never refused.
const SEGMENT_ROLLOVER_MARGIN_BYTES = 8 * 1024 * 1024;
const SESSION_ROLLOVER_MARGIN_BYTES = 32 * 1024 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function browserFactory(): RecorderMediaFactory {
	return {
		createDestination: (context) => context.createMediaStreamDestination(),
		createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType }),
		now: () => Date.now(),
		sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
	};
}

export class VfoAudioRecorder {
	private readonly segments = new Map<number, SegmentState>();
	private readonly transitions = new Map<number, Promise<void>>();
	private readonly media: RecorderMediaFactory;
	private readonly injectedMedia: boolean;
	/** VFOs whose last segment could not be opened wait before trying again. */
	private readonly blockedVfos = new Map<number, number>();

	constructor(
		private readonly context: AudioContext,
		private readonly api: AudioRecordingApi,
		private readonly onStatus: (status: RecorderStatus) => void = () => {},
		media?: RecorderMediaFactory,
	) {
		this.injectedMedia = media !== undefined;
		this.media = media ?? browserFactory();
	}
	private armed = false;
	private currentSessionId: string | null = null;
	private disarmPromise: Promise<void> | null = null;
	private armPromise: Promise<void> | null = null;
	private sessionRollover: Promise<void> | null = null;

	get isArmed(): boolean {
		return this.armed;
	}

	get isStarting(): boolean {
		return this.armPromise !== null;
	}

	get sessionId(): string | null {
		return this.currentSessionId;
	}

	async arm(): Promise<void> {
		if (this.disarmPromise) await this.disarmPromise;
		if (this.armed) return;
		if (this.armPromise) return this.armPromise;
		if (!this.context || typeof this.context.createBufferSource !== 'function') {
			throw new Error('Audio recording requires an available AudioContext.');
		}
		if (
			!this.media.createDestination ||
			!this.media.createRecorder ||
			(!this.injectedMedia &&
				(typeof MediaRecorder === 'undefined' || typeof this.context.createMediaStreamDestination !== 'function'))
		) {
			throw new Error('Audio recording requires MediaRecorder and MediaStreamAudioDestinationNode support.');
		}
		this.blockedVfos.clear();
		this.armPromise = (async () => {
			try {
				this.currentSessionId = await this.api.createSession();
				this.armed = true;
				this.onStatus({ state: 'armed' });
			} catch (error) {
				this.reportError(error);
				throw error;
			} finally {
				this.armPromise = null;
			}
		})();
		return this.armPromise;
	}

	async ingest(
		vfoIndex: number,
		frequencyHz: number,
		samples: Float32Array,
		metadata: VfoAudioMetadata,
	): Promise<void> {
		if (!this.armed || !this.currentSessionId || !samples.length || this.isBlocked(vfoIndex)) return;
		const previous = this.transitions.get(vfoIndex) ?? Promise.resolve();
		const operation = previous.then(async () => {
			if (this.sessionRollover) await this.sessionRollover;
			if (!this.armed || this.isBlocked(vfoIndex)) return;
			let segment = this.segments.get(vfoIndex);
			if (
				segment &&
				(segment.broken || segment.frequencyHz !== frequencyHz || segment.metadata.mode !== metadata.mode || segment.metadata.bandwidthHz !== metadata.bandwidthHz)
			) {
				await this.closeSegment(segment);
				segment = undefined;
			}
			if (!segment) segment = await this.openSegment(vfoIndex, frequencyHz, metadata);
			this.schedule(segment, samples);
		});
		this.transitions.set(vfoIndex, operation);
		try {
			await operation;
		} catch (error) {
			this.reportError(error, vfoIndex);
			this.blockedVfos.set(vfoIndex, this.media.now() + OPEN_RETRY_COOLDOWN_MS);
			throw error;
		} finally {
			if (this.transitions.get(vfoIndex) === operation) this.transitions.delete(vfoIndex);
		}
	}

	private isBlocked(vfoIndex: number): boolean {
		const until = this.blockedVfos.get(vfoIndex);
		if (until === undefined) return false;
		if (this.media.now() < until) return true;
		this.blockedVfos.delete(vfoIndex);
		return false;
	}

	async stopVfo(vfoIndex: number): Promise<void> {
		const pending = this.transitions.get(vfoIndex);
		if (pending) await pending.catch(() => undefined);
		const segment = this.segments.get(vfoIndex);
		if (segment) await this.closeSegment(segment);
	}

	async disarm(): Promise<void> {
		if (this.armPromise) {
			try {
				await this.armPromise;
			} catch {
				return;
			}
		}
		if (this.disarmPromise) return this.disarmPromise;
		if (!this.currentSessionId) return;
		this.armed = false;
		this.disarmPromise = (async () => {
			const failures: unknown[] = [];
			if (this.sessionRollover) await this.sessionRollover.catch(error => failures.push(error));
			const sessionId = this.currentSessionId;
			const pending = [...this.transitions.values()];
			for (const transition of pending) {
				try {
					await transition;
				} catch {
					// Already reported by ingest; the segment's saved audio is kept.
				}
			}
			for (const segment of [...this.segments.values()]) {
				try {
					await this.closeSegment(segment);
				} catch (error) {
					failures.push(error);
				}
			}
			if (sessionId) {
				try {
					// A segment whose own finish request was lost (console briefly unreachable)
					// is closed by the console from its saved bytes instead of blocking the session.
					await this.api.finishSession(sessionId, { finalizeOpenSegments: true });
				} catch (error) {
					this.reportError(error);
					failures.push(error);
				}
			}
			this.currentSessionId = null;
			this.disarmPromise = null;
			if (failures.length) throw failures[0];
			this.onStatus({ state: 'disarmed' });
		})();
		return this.disarmPromise;
	}

	/**
	 * Best-effort close for a page that is going away: one keepalive request asks the
	 * console to finish the session and keep every open segment's saved audio.
	 */
	finalizeForUnload(): void {
		const sessionId = this.currentSessionId;
		this.armed = false;
		this.currentSessionId = null;
		for (const segment of this.segments.values()) {
			segment.broken = true;
			try {
				if (segment.recorder.state !== 'inactive') segment.recorder.stop();
			} catch {
				// The page is unloading; nothing else can be done for this recorder.
			}
		}
		this.segments.clear();
		if (sessionId) void this.api.finishSession(sessionId, { finalizeOpenSegments: true, keepalive: true }).catch(() => undefined);
	}

	private async openSegment(vfoIndex: number, frequencyHz: number, metadata: VfoAudioMetadata): Promise<SegmentState> {
		if (!this.currentSessionId) throw new Error('Cannot open an audio segment without an active session.');
		const startedAt = this.media.now();
		const destination = this.media.createDestination(this.context);
		let recorder: RecorderPort;
		try {
			recorder = this.media.createRecorder(destination.stream, CODEC);
		} catch (error) {
			destination.stream.getTracks().forEach((track) => track.stop());
			throw error;
		}
		const segmentMetadata = {
			vfo_index: vfoIndex,
			frequency_hz: frequencyHz,
			mode: metadata.mode,
			bandwidth_hz: metadata.bandwidthHz,
			codec: CODEC,
			started_at: new Date(startedAt).toISOString(),
		};
		let id: string;
		try {
			try {
				id = await this.api.createSegment(this.currentSessionId, segmentMetadata);
			} catch (error) {
				// The console closes sessions it has not heard from (for example after it was
				// restarted); keep recording in a fresh session instead of stopping.
				if (!/session is finished/i.test(errorMessage(error)) || !this.armed) throw error;
				this.currentSessionId = await this.api.createSession();
				this.onStatus({ state: 'notice', vfoIndex, message: 'The console closed the previous recording session; recording continues in a new session.' });
				id = await this.api.createSegment(this.currentSessionId, segmentMetadata);
			}
		} catch (error) {
			destination.stream.getTracks().forEach((track) => track.stop());
			throw error;
		}
		let resolveStopped!: () => void;
		const stopped = new Promise<void>((resolve) => (resolveStopped = resolve));
		const segment: SegmentState = {
			vfoIndex,
			frequencyHz,
			metadata,
			id,
			startedAt,
			destination,
			recorder,
			nextTime: this.context.currentTime,
			sources: new Set(),
			appendQueue: Promise.resolve(),
			appendError: null,
			broken: false,
			rollingOver: false,
			stopped,
			resolveStopped,
		};
		recorder.ondataavailable = ({ data }) => {
			if (!data || data.size === 0) return;
			segment.appendQueue = segment.appendQueue.then(async () => {
				if (segment.broken) return;
				try {
					const usage = await this.appendWithRetry(segment.id, data);
					if (usage) this.checkLimits(segment, usage);
				} catch (error) {
					segment.appendError ??= error;
					segment.broken = true;
					this.reportError(new Error(`audio upload failed (${errorMessage(error)}); the segment was saved up to the last uploaded chunk and a new segment starts.`), vfoIndex);
					this.scheduleRollover(segment);
				}
			});
		};
		recorder.onerror = (event) => {
			const error = ('error' in event ? event.error : undefined) ?? new Error('MediaRecorder reported an error.');
			segment.appendError ??= error;
			segment.broken = true;
			this.reportError(error, vfoIndex);
		};
		recorder.onstop = () => segment.resolveStopped();
		try {
			recorder.start(1000);
		} catch (error) {
			try {
				await this.api.finishSegment(segment.id, {
					ended_at: new Date(this.media.now()).toISOString(),
					duration_seconds: 0,
					status: 'failed',
					error: errorMessage(error),
				});
			} catch (finalizeError) {
				this.reportError(finalizeError, vfoIndex);
			} finally {
				destination.disconnect?.();
				destination.stream.getTracks().forEach((track) => track.stop());
			}
			throw error;
		}
		this.segments.set(vfoIndex, segment);
		return segment;
	}

	private async appendWithRetry(segmentId: string, chunk: Blob): Promise<AudioChunkUsage | void> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.api.appendChunk(segmentId, chunk);
			} catch (error) {
				if (attempt >= APPEND_RETRY_DELAYS_MS.length || /finished|size limit/i.test(errorMessage(error))) throw error;
				await (this.media.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(APPEND_RETRY_DELAYS_MS[attempt]);
			}
		}
	}

	private checkLimits(segment: SegmentState, usage: AudioChunkUsage): void {
		if (usage.sessionBytes >= usage.maxSessionBytes - SESSION_ROLLOVER_MARGIN_BYTES) {
			void this.rolloverSession().catch(error => this.reportError(error));
			return;
		}
		if (usage.segmentBytes >= usage.maxSegmentBytes - SEGMENT_ROLLOVER_MARGIN_BYTES && !segment.rollingOver) {
			this.onStatus({ state: 'notice', vfoIndex: segment.vfoIndex, message: `VFO ${segment.vfoIndex + 1} audio reached the file size limit; recording continues in a new file.` });
			this.scheduleRollover(segment);
		}
	}

	/** Close a segment in the background; the next audio for this VFO opens a new one. */
	private scheduleRollover(segment: SegmentState): void {
		if (segment.rollingOver) return;
		segment.rollingOver = true;
		segment.broken = true;
		const vfoIndex = segment.vfoIndex;
		const previous = this.transitions.get(vfoIndex) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(() => this.closeSegment(segment)).catch(error => this.reportError(error, vfoIndex));
		this.transitions.set(vfoIndex, operation);
		void operation.finally(() => {
			if (this.transitions.get(vfoIndex) === operation) this.transitions.delete(vfoIndex);
		});
	}

	private rolloverSession(): Promise<void> {
		if (this.sessionRollover) return this.sessionRollover;
		this.sessionRollover = (async () => {
			const previousSessionId = this.currentSessionId;
			if (!previousSessionId || !this.armed) return;
			for (const transition of [...this.transitions.values()]) await transition.catch(() => undefined);
			for (const segment of [...this.segments.values()]) {
				segment.broken = true;
				await this.closeSegment(segment).catch(error => this.reportError(error, segment.vfoIndex));
			}
			await this.api.finishSession(previousSessionId, { finalizeOpenSegments: true });
			if (!this.armed) return;
			this.currentSessionId = await this.api.createSession();
			this.onStatus({ state: 'armed' });
			this.onStatus({ state: 'notice', message: 'The recording session reached its size limit; recording continues in a new session.' });
		})().finally(() => {
			this.sessionRollover = null;
		});
		return this.sessionRollover;
	}

	private schedule(segment: SegmentState, samples: Float32Array): void {
		const buffer = this.context.createBuffer(1, samples.length, SAMPLE_RATE);
		buffer.getChannelData(0).set(samples);
		const source = this.context.createBufferSource();
		source.buffer = buffer;
		source.connect(segment.destination);
		segment.sources.add(source);
		source.onended = () => {
			source.disconnect();
			segment.sources.delete(source);
		};
		const now = this.context.currentTime;
		if (segment.nextTime < now) segment.nextTime = now + 0.01;
		source.start(segment.nextTime);
		segment.nextTime += buffer.duration;
	}

	private async closeSegment(segment: SegmentState): Promise<void> {
		if (this.segments.get(segment.vfoIndex) !== segment) return;
		this.segments.delete(segment.vfoIndex);
		for (const source of segment.sources) {
			try {
				source.stop?.();
			} catch {
				// A source can finish between the map snapshot and stop call.
			}
			source.disconnect();
			segment.sources.delete(source);
		}
		let stopError: unknown;
		if (segment.recorder.state !== 'inactive') {
			try {
				segment.recorder.stop();
			} catch (error) {
				stopError = error;
				this.reportError(error, segment.vfoIndex);
			}
		}
		if (!stopError) await segment.stopped;
		await segment.appendQueue;
		const endedAt = this.media.now();
		const endedAtIso = new Date(endedAt).toISOString();
		const durationSeconds = Math.max(0, (endedAt - segment.startedAt) / 1000);
		const recordingFailure = segment.appendError ?? stopError;
		const status = recordingFailure ? 'failed' : 'complete';
		let finalizeError: unknown;
		try {
			await this.api.finishSegment(segment.id, {
				ended_at: endedAtIso,
				duration_seconds: durationSeconds,
				status,
				...(recordingFailure ? { error: errorMessage(recordingFailure) } : {}),
			});
		} catch (error) {
			finalizeError = error;
			this.reportError(error, segment.vfoIndex);
			if (!recordingFailure) {
				try {
					await this.api.finishSegment(segment.id, {
						ended_at: endedAtIso,
						duration_seconds: durationSeconds,
						status: 'failed',
						error: errorMessage(error),
					});
				} catch (failureError) {
					this.reportError(failureError, segment.vfoIndex);
				}
			}
		} finally {
			segment.destination.disconnect?.();
			segment.destination.stream.getTracks().forEach((track) => track.stop());
		}
		// Upload failures were reported when they happened and the saved audio was kept,
		// so only a failure to close the file is an error for the caller.
		if (finalizeError) throw finalizeError;
		if (stopError) throw stopError;
	}

	private reportError(error: unknown, vfoIndex?: number): void {
		this.onStatus({ state: 'error', error, message: error instanceof Error ? error.message : String(error), vfoIndex });
	}
}
