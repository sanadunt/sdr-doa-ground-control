type SpectrumFft = { fft(input: Int8Array, output: Float32Array): void };

// These buffers are owned by the spectrum path and refilled before the next FFT.
export function processSpectrumFft(fft: SpectrumFft, input: Int8Array, output: Float32Array, correctDc: boolean): void {
	if (correctDc) {
		let sumI = 0;
		let sumQ = 0;
		for (let i = 0; i < input.length; i += 2) {
			sumI += input[i];
			sumQ += input[i + 1];
		}
		const sampleCount = input.length / 2;
		const offsetI = Math.round(sumI / sampleCount);
		const offsetQ = Math.round(sumQ / sampleCount);
		if (offsetI || offsetQ) {
			for (let i = 0; i < input.length; i += 2) {
				input[i] = Math.max(-128, Math.min(127, input[i] - offsetI));
				input[i + 1] = Math.max(-128, Math.min(127, input[i + 1] - offsetQ));
			}
		}
	}
	fft.fft(input, output);
}
