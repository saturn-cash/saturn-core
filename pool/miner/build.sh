#!/bin/sh
# Builds the browser miner's WebAssembly: SIMD (4 nonces per instruction) and a plain fallback.
set -e
cd "$(dirname "$0")"
for v in simd scalar; do
  F="-mbulk-memory"; [ $v = simd ] && F="-DSIMD -msimd128 -mbulk-memory"
  clang --target=wasm32 -O3 $F -nostdlib -Wl,--no-entry -Wl,--export=io -Wl,--export=prepare \
    -Wl,--export=scan -Wl,--export=hash_header -Wl,--strip-all -o sha256d-$v.wasm sha256d.c
done
ls -l sha256d-*.wasm
