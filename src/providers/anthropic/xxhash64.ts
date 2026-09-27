import xxhashInit from "./vendor/xxhash-wasm.js";

/**
 * xxHash64, from the vendored reference implementation.
 *
 * A hand-written BigInt version was attempted first and abandoned: it was
 * correct for empty and tiny inputs and wrong for every longer one, and four
 * rounds of fixes never converged. See vendor/README.md.
 *
 * The WASM module is instantiated once and shared.
 */

type RawHasher = (bytes: Uint8Array, seed?: bigint) => bigint;

let hasher: Promise<RawHasher> | undefined;

function load(): Promise<RawHasher> {
  hasher ??= (async () => {
    const instance = await (xxhashInit as unknown as () => Promise<{ h64Raw: RawHasher }>)();
    return instance.h64Raw;
  })();
  return hasher;
}

/** 64-bit hash of `bytes` with an optional seed. */
export async function xxhash64(bytes: Uint8Array, seed = 0n): Promise<bigint> {
  return (await load())(bytes, seed);
}

export async function xxhash64Hex(value: string): Promise<string> {
  const hash = await xxhash64(new TextEncoder().encode(value));
  return hash.toString(16).padStart(16, "0").slice(0, 16);
}