// Vendors wgpuFFT's standalone browser build into js/wgpu_fft_web.js.
//
// Build it in the wgpuFFT repository first (python wgpu-fft-web/build_standalone.py),
// then pass the built file:
//
//   node tools/vendor-wgpu-fft-web.mjs <wgpuFFT>/wgpu-fft-web/dist/wgpu_fft_web.js
//
// The code goes inside wgpuFftWebModule(), as js/h5wasm.js sits inside
// h5wasmModule(), so index.html can start it in its Web Worker from the
// function's source text. When the build's Rust dependencies change, update
// js/wgpu_fft_web-LICENSES.txt from
//   cargo tree -p wgpu-fft-web --target wasm32-unknown-unknown -e normal --format "{p} {l}"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
    console.error('usage: node tools/vendor-wgpu-fft-web.mjs <path to dist/wgpu_fft_web.js>');
    process.exit(1);
}
const text = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
if (!/^var wgpuFftWeb = /m.test(text) || !text.startsWith('// wgpu-fft-web ')) {
    console.error(`${source} is not a wgpu-fft-web standalone build`);
    process.exit(1);
}
const version = text.split('\n', 2).join(' ').replace(/\/\/\s*/g, '').replace(/\s+/g, ' ')
    .replace(/\s*Do not edit; rerun the script instead\.\s*/, '').trim();
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js', 'wgpu_fft_web.js');
fs.writeFileSync(target, [
    '// 3DSConvert: wgpuFFT\'s browser bindings, vendored by tools/vendor-wgpu-fft-web.mjs from',
    `// ${version}`,
    '// The build sits inside wgpuFftWebModule() so index.html can start it in its',
    '// Web Worker from this function\'s source text. Do not edit; re-vendor instead.',
    'function wgpuFftWebModule() {',
    text.trimEnd(),
    'return wgpuFftWeb;',
    '}',
    '',
].join('\n'));
console.log(`wrote ${path.relative(process.cwd(), target)} (${(fs.statSync(target).size / 1e6).toFixed(2)} MB)`);
