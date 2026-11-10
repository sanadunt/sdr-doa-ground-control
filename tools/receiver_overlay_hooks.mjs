// Node module hooks for the Receiver node --test scripts. They resolve the
// overlay's extensionless imports the way the build does (overlay file first,
// then the pinned vendor/BrowSDR file) and transform TypeScript, including
// parameter properties, which Node's default type stripping rejects.
import { readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolsUrl = new URL('./', import.meta.url);
const overlayRoot = fileURLToPath(new URL('browsdr_receiver_overlay/', toolsUrl));
const vendorRoot = fileURLToPath(new URL('../vendor/BrowSDR/', toolsUrl));
const frontendRoot = fileURLToPath(new URL('../frontend/src/', toolsUrl));
const wasmModuleUrl = new URL('../vendor/BrowSDR/hackrf-web/pkg/hackrf_web.js', toolsUrl).href;

// Console files the builder copies into the Receiver source (tools/build_browsdr_receiver.py, CONSOLE_SHARED_FILES).
const consoleShared = new Map([
	['src/client/app/radioAudioFilter', fileURLToPath(new URL('../frontend/src/lib/radioAudioFilter.ts', toolsUrl))],
]);

function sourceFile(basePath) {
	for (const candidate of [basePath, `${basePath}.ts`, `${basePath}/index.ts`]) {
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
	}
	return null;
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier === '/hackrf-web/pkg/hackrf_web.js' || specifier === '/receiver/hackrf-web/pkg/hackrf_web.js') {
		return nextResolve(wasmModuleUrl, context);
	}
	const parent = context.parentURL?.startsWith('file:') ? fileURLToPath(context.parentURL) : null;
	if (parent && (specifier.startsWith('./') || specifier.startsWith('../'))
		&& (parent.startsWith(overlayRoot) || parent.startsWith(vendorRoot))) {
		const relativeParent = parent.startsWith(overlayRoot) ? parent.slice(overlayRoot.length) : parent.slice(vendorRoot.length);
		const parentDir = relativeParent.split('/').slice(0, -1).join('/');
		const target = new URL(specifier, `file:///${parentDir}/`).pathname.slice(1);
		const shared = consoleShared.get(target.replace(/\.ts$/, ''));
		const resolved = sourceFile(`${overlayRoot}${target}`) ?? sourceFile(`${vendorRoot}${target}`) ?? (shared && sourceFile(shared));
		if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
	}
	// The console's own TypeScript (frontend/src) also imports without extensions, as Vite resolves them.
	if (parent && parent.startsWith(frontendRoot) && (specifier.startsWith('./') || specifier.startsWith('../'))) {
		const resolved = sourceFile(fileURLToPath(new URL(specifier, pathToFileURL(parent))));
		if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (url.startsWith('file:') && url.endsWith('.ts')) {
		const source = readFileSync(fileURLToPath(url), 'utf8');
		return {
			format: 'module',
			source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }),
			shortCircuit: true,
		};
	}
	return nextLoad(url, context);
}
