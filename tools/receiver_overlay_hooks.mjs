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
const wasmModuleUrl = new URL('../vendor/BrowSDR/hackrf-web/pkg/hackrf_web.js', toolsUrl).href;

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
		const resolved = sourceFile(`${overlayRoot}${target}`) ?? sourceFile(`${vendorRoot}${target}`);
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
