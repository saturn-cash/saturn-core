import { readFileSync } from 'fs';
for (const f of process.argv.slice(2)) {
  const { instance } = await WebAssembly.instantiate(readFileSync(f), {});
  const x = instance.exports, mem = new Uint32Array(x.memory.buffer, x.io(), 64);
  for (let i = 0; i < 20; i++) mem[i] = (i * 2654435761) >>> 0; mem[20] = 0; mem[21] = 0; x.prepare();
  const r = [];
  for (let k = 0; k < 3; k++) { const t = performance.now(); let N = 0; while (performance.now() - t < 3000) { x.scan(N, 65536); N += 65536; } r.push(N / ((performance.now() - t) / 1000) / 1e6); }
  console.log(f.padEnd(24), r.map((v) => v.toFixed(2)).join('  '), 'MH/s');
}
