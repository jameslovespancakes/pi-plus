# Vendored: xxhash-wasm

`xxhash-wasm.js` is the ESM build of [xxhash-wasm](https://github.com/jungomi/xxhash-wasm),
MIT licensed (see `xxhash-wasm.LICENSE.md`), copied in verbatim.

## Why vendored rather than depended on

The billing checksum in `../client-identity.ts` needs xxHash64. Two things were
tried before this:

1. **A hand-written BigInt implementation.** It produced correct values for
   empty and very short inputs and wrong values for everything longer. Four
   separate bugs were found and fixed, each time with the output still wrong.
   Guessing further at a hash function was not converging.
2. **`xxhash-wasm` as an npm dependency.** Rejected: the point of the extraction
   is that no unaudited package sits in the auth path.

Vendoring gets both: the algorithm is known-correct, and the code lives in this
repository with no install-time dependency.

## What this is

A single self-contained ~11 KB `.js` file with the compiled WebAssembly inlined
as a byte array. It is not fetched, built, or downloaded at runtime. The only
import is the file itself.

## Regenerating

```sh
npm pack xxhash-wasm@<version>
tar -xzf xxhash-wasm-*.tgz
cp package/esm/xxhash-wasm.js src/core/anthropic/vendor/
```

Record the version when you do. The current copy came from `xxhash-wasm` as
installed by pi's own tree on 2026-09-19.