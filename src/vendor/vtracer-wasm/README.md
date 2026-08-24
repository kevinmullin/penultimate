# vtracer-wasm (vendored)

Browser-targeted WebAssembly build of [visioncortex/vtracer](https://github.com/visioncortex/vtracer)'s
`vtracer-wasm` crate (the same Rust source that backs the official
`@visioncortex/vtracer` npm package — but that package is built with
`wasm-pack --target nodejs` and depends on `fs`/`require`, which don't exist
in a browser/worker context). This directory instead vendors an unmodified
rebuild with `--target web`, which produces plain ES module glue that works
in any browser context, including Web Workers.

No source patches were made — only the wasm-pack `--target` flag differs
from upstream's own build.

## Provenance

- Source: https://github.com/visioncortex/vtracer
- Tag: `1.0.0-alpha.3`
- Commit: `58221025d5cfc6abbe12745942ae867b57ad3117`
- Crate built: `nodejs/` (package name `vtracer-wasm`)
- License: MIT OR Apache-2.0 (see `LICENSE`)

## Rebuilding

Requires the Rust toolchain, the `wasm32-unknown-unknown` target, and
`wasm-pack`:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-pack

git clone --depth 1 --branch <tag> https://github.com/visioncortex/vtracer.git
cd vtracer/nodejs
wasm-pack build --target web --out-dir pkg-web
```

Then copy `pkg-web/vtracer_wasm.js`, `pkg-web/vtracer_wasm_bg.wasm`,
`pkg-web/vtracer_wasm.d.ts`, and `pkg-web/vtracer_wasm_bg.wasm.d.ts` into this
directory, and update the provenance tag/commit above.

## API

```ts
import init, { vectorize_rgba } from './vtracer_wasm.js'
import wasmUrl from './vtracer_wasm_bg.wasm?url'

await init(wasmUrl) // once per worker/context

const svg: string = vectorize_rgba(rgbaBytes, width, height, options)
```

`options` is a plain JS object (camelCase); see `vtracer_wasm.d.ts` and
upstream's `nodejs/index.d.ts` for the full field list (`mode`, `clustering`,
`hierarchical`, `filterSpeckle`, `colorPrecision`, `simplify`, `palette`,
`preset`, etc). Unset fields fall back to the framework default.
