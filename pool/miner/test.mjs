// Checks both builds against Bitcoin's genesis block and benchmarks them.
import { readFileSync } from 'fs';
import { createHash } from 'crypto';
const hex = (s) => Buffer.from(s, 'hex');
// genesis header (80 bytes, wire order)
const header = Buffer.concat([
  hex('01000000'), Buffer.alloc(32), hex('3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a'),
  hex('29ab5f49'), hex('ffff001d'), hex('1dac2b7c'),
]);
const want = createHash('sha256').update(createHash('sha256').update(header).digest()).digest();
const nonce = header.readUInt32LE(76);
for (const v of ['simd', 'scalar']) {
  const { instance } = await WebAssembly.instantiate(readFileSync(`sha256d-${v}.wasm`), {});
  const x = instance.exports, mem = new Uint32Array(x.memory.buffer, x.io(), 64);
  for (let i = 0; i < 20; i++) mem[i] = header.readUInt32BE(i * 4);
  // target: difficulty 1 (top 64 bits 0x00000000_ffff0000)
  mem[20] = 0; mem[21] = 0xffff0000;
  x.prepare();
  x.hash_header(nonce);
  const got = Buffer.alloc(32); for (let i = 0; i < 8; i++) got.writeUInt32BE(mem[56 + i], i * 4);
  console.log(v, 'hash_header ok:', got.equals(want), Buffer.from(got).reverse().toString('hex').slice(0, 20));
  const start = nonce - 1000;
  const n = x.scan(start, 2048);
  const cands = [...mem.slice(24, 24 + n)];
  console.log(v, 'scan finds genesis nonce:', cands.includes(nonce), 'candidates:', n);
  // easy target: every candidate the scan reports must really be under it, and none missed
  mem[20] = 0x0fffffff; mem[21] = 0xffffffff;
  let bad = 0, total = 0, js = 0;
  const h = Buffer.from(header);
  for (let base = 0; base < 4096; base += 64) {
    const k = x.scan(base, 64);
    const got = new Set([...mem.slice(24, 24 + k)]);
    for (let q = base; q < base + 64; q++) {
      h.writeUInt32LE(q, 76);
      const d = createHash('sha256').update(createHash('sha256').update(h).digest()).digest();
      const top = d.readUInt32LE(28);
      const ok = top <= 0x0fffffff;
      if (ok) js++;
      if (ok !== got.has(q)) bad++;
    }
    total += k;
  }
  console.log(v, 'vs node crypto on 4096 nonces: mismatches', bad, '| found', total, 'expected', js);
  const t = performance.now(); let N = 0;
  mem[20] = 0; mem[21] = 0;
  while (performance.now() - t < 2000) { x.scan(N, 65536); N += 65536; }
  console.log(v, 'speed (1 core):', (N / ((performance.now() - t) / 1000) / 1e6).toFixed(2), 'MH/s');
}
