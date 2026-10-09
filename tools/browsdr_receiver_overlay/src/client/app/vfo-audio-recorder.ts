export interface VfoAudioMetadata {
	mode: string;
	bandwidthHz: number;
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
	appendChunk(segmentId: string, chunk: Blob): Promise<void>;
	finishSegment(
		segmentId: string,
		metadata: { ended_at: string; duration_seconds: number; status?: 'complete' | 'failed'; error?: string },
	): Promise<void>;
	finishSession(sessionId: string): Promise<void>;
}

export type RecorderPort = MediaRecorder;

export type AudioDestinationPort = MediaStreamAudioDestinationNode;

export type AudioSourcePort = AudioBufferSourceNode;

export interface RecorderMediaFactory {
	createDestination(context: AudioContext): AudioDestinationPort;
	createRecorder(stream: MediaStream, mimeType: string): RecorderPort;
	now(): number;
}

export interface RecorderStatus {
	state: 'armed' | 'disarmed' | 'error';
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
	stopped: Promise<void>;
	resolveStopped: () => void;
}

const CODEC = 'audio/webm;codecs=opus';
const SAMPLE_RATE = 48_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function browserFactory(): RecorderMediaFactory {
	return {
		createDestination: (context) => context.createMediaStreamDestination(),
		createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType }),
		now: () => Date.now(),
	};
}

export class VfoAudioRecorder {
	private readonly segments = new Map<number, SegmentState>();
	private readonly transitions = new Map<number, Promise<void>>();
	private readonly media: RecorderMediaFactory;
	private readonly injectedMedia: boolean;
	private readonly blockedVfos = new Set<number>();

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
		if (!this.armed || !this.currentSessionId || !samples.length || this.blockedVfos.has(vfoIndex)) return;
		const previous = this.transitions.get(vfoIndex) ?? Promise.resolve();
		const operation = previous.then(async () => {
			if (!this.armed || this.blockedVfos.has(vfoIndex)) return;
			let segment = this.segments.get(vfoIndex);
			if (
				segment &&
				(segment.frequencyHz !== frequencyHz || segment.metadata.mode !== metadata.mode || segment.metadata.bandwidthHz !== metadata.bandwidthHz)
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
			this.blockedVfos.add(vfoIndex);
			throw error;
		} finally {
			if (this.transitions.get(vfoIndex) === operation) this.transitions.delete(vfoIndex);
		}
	}

	async stopVfo(vfoIndex: number): Promise<void> {
		const pending = this.transitions.get(vfoIndex);
		if (pending) await pending;
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
		const sessionId = this.currentSessionId;
		this.disarmPromise = (async () => {
			const pending = [...this.transitions.values()];
			const failures: unknown[] = [];
			for (const transition of pending) {
				try {
					await transition;
				} catch (error) {
					failures.push(error);
				}
			}
			for (const segment of [...this.segments.values()]) {
				try {
					await this.closeSegment(segment);
				} catch (error) {
					failures.push(error);
				}
			}
			try {
				await this.api.finishSession(sessionId);
			} catch (error) {
				this.reportError(error);
				failures.push(error);
			}
			this.currentSessionId = null;
			this.disarmPromise = null;
			if (failures.length) throw failures[0];
			this.onStatus({ state: 'disarmed' });
		})();
		return this.disarmPromise;
	}

	private async openSegment(vfoIndex: number, frequencyHz: number, metadata: VfoAudioMetadata): Promise<SegmentState> {
		const sessionId = this.currentSessionId;
		if (!sessionId) throw new Error('Cannot open an audio segment without an active session.');
		const startedAt = this.media.now();
		const destination = this.media.createDestination(this.context);
		let recorder: RecorderPort;
		try {
			recorder = this.media.createRecorder(destination.stream, CODEC);
		} catch (error) {
			destination.stream.getTracks().forEach((track) => track.stop());
			throw error;
		}
		let id: string;
		try {
			id = await this.api.createSegment(sessionId, {
				vfo_index: vfoIndex,
				frequency_hz: frequencyHz,
				mode: metadata.mode,
				bandwidth_hz: metadata.bandwidthHz,
				codec: CODEC,
				started_at: new Date(startedAt).toISOString(),
			});
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
			stopped,
			resolveStopped,
		};
		recorder.ondataavailable = ({ data }) => {
			if (!data || data.size === 0) return;
			segment.appendQueue = segment.appendQueue.then(() => this.api.appendChunk(segment.id, data)).catch((error) => {
				segment.appendError ??= error;
				this.reportError(error, vfoIndex);
			});
		};
		recorder.onerror = (event) => {
			const error = ('error' in event ? event.error : undefined) ?? new Error('MediaRecorder reported an error.');
			segment.appendError ??= error;
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
		if (finalizeError) throw finalizeError;
		if (segment.appendError) throw segment.appendError;
		if (stopError) throw stopError;
	}

	private reportError(error: unknown, vfoIndex?: number): void {
		this.onStatus({ state: 'error', error, message: error instanceof Error ? error.message : String(error), vfoIndex });
	}
}
