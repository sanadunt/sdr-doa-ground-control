type SpectrumFft = { fft(input: Int8Array, output: Float32Array): void };

let ditherState = 0x9e3779b9;

function nextDitherUnit(): number {
	ditherState ^= ditherState << 13;
	ditherState ^= ditherState >>> 17;
	ditherState ^= ditherState << 5;
	return (ditherState >>> 0) / 0x1_0000_0000;
}

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
		const meanI = sumI / sampleCount;
		const meanQ = sumQ / sampleCount;
		if (meanI || meanQ) {
			// The FFT takes 8-bit samples, so a fractional DC offset cannot be
			// subtracted exactly. Each sample's offset is rounded up with probability
			// equal to the fraction, so the subtracted offset averages to the exact
			// mean; the leftover error is white noise (at most 0.25 LSB^2) instead of
			// a coherent spike in the DC bin.
			const wholeI = Math.floor(meanI);
			const wholeQ = Math.floor(meanQ);
			const fractionI = meanI - wholeI;
			const fractionQ = meanQ - wholeQ;
			for (let i = 0; i < input.length; i += 2) {
				const offsetI = fractionI > 0 && nextDitherUnit() < fractionI ? wholeI + 1 : wholeI;
				const offsetQ = fractionQ > 0 && nextDitherUnit() < fractionQ ? wholeQ + 1 : wholeQ;
				input[i] = Math.max(-128, Math.min(127, input[i] - offsetI));
				input[i + 1] = Math.max(-128, Math.min(127, input[i + 1] - offsetQ));
			}
		}
	}
	fft.fft(input, output);
}
