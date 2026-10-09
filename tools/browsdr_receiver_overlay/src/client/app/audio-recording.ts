import type { AppInstance } from './types';
import { receiverRecordsApi } from './receiver-records-api';
import { VfoAudioRecorder } from './vfo-audio-recorder';
import type { AudioRecordingApi, RecorderStatus } from './vfo-audio-recorder';
import type { Vfo } from './types';

interface RecorderEntry {
	context: AudioContext;
	recorder: VfoAudioRecorder;
}

const recorders = new WeakMap<object, RecorderEntry>();

const recordingApi: AudioRecordingApi = {
	async createSession() {
		return (await receiverRecordsApi.createAudioSession()).id;
	},
	async createSegment(sessionId, metadata) {
		return (await receiverRecordsApi.createAudioSegment(sessionId, metadata)).id;
	},
	appendChunk(segmentId, chunk) {
		return receiverRecordsApi.appendAudioChunk(segmentId, chunk);
	},
	finishSegment(segmentId, metadata) {
		return receiverRecordsApi.finishAudioSegment(segmentId, metadata);
	},
	finishSession(sessionId) {
		return receiverRecordsApi.finishAudioSession(sessionId);
	},
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function setRecordingError(app: AppInstance, message: string): void {
	app.audioRecording.error = message;
	app.records.error = message;
}

function recorderFor(app: AppInstance): VfoAudioRecorder | null {
	const context = app.audioCtx as AudioContext | null;
	if (!context) return null;
	const current = recorders.get(app);
	if (current?.context === context) return current.recorder;
	const recorder = new VfoAudioRecorder(context, recordingApi, (status: RecorderStatus) => {
		if (status.state === 'error') {
			const prefix = status.vfoIndex === undefined ? 'Audio recording' : `VFO ${status.vfoIndex + 1} audio recording`;
			setRecordingError(app, `${prefix}: ${status.message || 'recording error'}`);
			return;
		}
		if (status.state === 'armed') {
			app.audioRecording.armed = true;
			app.audioRecording.sessionId = recorder.sessionId;
			app.audioRecording.error = '';
		} else {
			app.audioRecording.armed = false;
			app.audioRecording.sessionId = null;
		}
	});
	recorders.set(app, { context, recorder });
	return recorder;
}

export const audioRecordingMethods = {
	async toggleVfoAudioRecording(this: AppInstance) {
		if (this.audioRecording.starting || this.audioRecording.stopping) return;
		if (this.audioRecording.armed) {
			await this.disarmVfoAudioRecording();
			return;
		}
		if (!this.running) {
			this.showMsg('Start the Receiver in Listener before recording VFO audio.');
			return;
		}
		this._initAudioCtx();
		const recorder = recorderFor(this);
		if (!recorder) {
			setRecordingError(this, 'AudioContext is unavailable.');
			return;
		}
		this.audioRecording.starting = true;
		this.audioRecording.error = '';
		try {
			await recorder.arm();
			this.audioRecording.armed = recorder.isArmed;
			this.audioRecording.sessionId = recorder.sessionId;
			this.showMsg('Per-VFO audio recording started.');
		} catch (error) {
			this.audioRecording.armed = false;
			this.audioRecording.sessionId = null;
			setRecordingError(this, `Could not start audio recording: ${errorMessage(error)}`);
			this.showMsg(this.audioRecording.error);
		} finally {
			this.audioRecording.starting = false;
		}
	},

	async disarmVfoAudioRecording(this: AppInstance) {
		const recorder = recorderFor(this);
		if (!recorder || (!recorder.isArmed && !recorder.isStarting)) {
			this.audioRecording.armed = false;
			this.audioRecording.sessionId = null;
			return;
		}
		this.audioRecording.stopping = true;
		try {
			await recorder.disarm();
			this.audioRecording.error = '';
		} catch (error) {
			setRecordingError(this, `Could not finalize audio recording: ${errorMessage(error)}`);
			this.showMsg(this.audioRecording.error);
		} finally {
			this.audioRecording.armed = false;
			this.audioRecording.sessionId = null;
			this.audioRecording.stopping = false;
		}
	},

	async stopVfoAudioRecording(this: AppInstance, vfoIndex: number) {
		const recorder = recorderFor(this);
		if (!recorder?.isArmed) return;
		try {
			await recorder.stopVfo(vfoIndex);
		} catch (error) {
			setRecordingError(this, `Could not close VFO ${vfoIndex + 1} audio segment: ${errorMessage(error)}`);
			this.showMsg(this.audioRecording.error);
		}
	},

	async stopAllVfoAudioSegments(this: AppInstance) {
		for (let index = 0; index < this.vfos.length; index++) await this.stopVfoAudioRecording(index);
	},

	recordVfoAudio(this: AppInstance, vfoIndex: number, frequencyMHz: number, samples: Float32Array) {
		if (!this.audioRecording.armed || !Number.isFinite(frequencyMHz) || !samples.length) return;
		const vfo = this.vfos[vfoIndex] as Vfo | undefined;
		const recorder = recorderFor(this);
		if (!vfo?.enabled || !this.isFreqInBandwidth(vfo.freq) || !recorder?.isArmed) return;
		void recorder.ingest(vfoIndex, frequencyMHz * 1_000_000, samples, {
			mode: vfo.mode,
			bandwidthHz: vfo.bandwidth,
		}).catch((error: unknown) => {
			setRecordingError(this, `VFO ${vfoIndex + 1} audio recording: ${errorMessage(error)}`);
		});
	},
};
