// Checks the browser wallet against reference values (embit, and the Saturn app's own test).
const W = require('./satwallet.js');
const crypto = require('crypto');
const eq = (a, b, what) => { if (a !== b) { console.log('FAIL', what, a, '!=', b); process.exitCode = 1; } else console.log('ok  ', what); };
(async () => {
  eq(Buffer.from(W._ripemd160(Buffer.from(''))).toString('hex'), '9c1185a5c5e9fc54612808977ee8f548b2258d31', 'ripemd160("")');
  eq(Buffer.from(W._ripemd160(Buffer.from('abc'))).toString('hex'), '8eb208f7e05d987a9b044a8e98c6b087f15a0bfc', 'ripemd160("abc")');
  const long = Buffer.alloc(1000, 'a');
  eq(Buffer.from(W._ripemd160(long)).toString('hex'), crypto.createHash('ripemd160').update(long).digest('hex'), 'ripemd160(1000 bytes)');
  eq(W.WORDS.length, 2048, 'word list size');
  const ab = W.normalize('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  eq(await W.checkWords(ab), null, 'abandon..about checksum');
  const a = await W.addresses(ab, 2, 1);
  eq(a.receive[0], 'sat1qcr8te4kr609gcawutmrza0j4xv80jy8z5vgrgx', 'abandon 0/0');
  eq(a.receive[1], 'sat1qnjg0jd8228aq7egyzacy8cys3knf9xvruqyrfj', 'abandon 0/1');
  eq(a.change[0], 'sat1q8c6fshw2dlwun7ekn9qwf37cu2rn755uymns49', 'abandon 1/0');
  const lw = W.normalize('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const b = await W.addresses(lw, 2, 1);
  eq(b.receive[0], 'sat1qgkju4yvvtuz0s8vqn837q396jezu2h8era6ufa', 'legal 0/0');
  eq(b.receive[1], 'sat1q0uez0durhkezwzmhfyj5fkjcmqcm56jdj9y2kv', 'legal 0/1');
  eq(b.change[0], 'sat1qadmm9kmte03vj7fzasr4x5r642j02t873c6xrt', 'legal 1/0');
  eq(await W.checkWords(W.normalize('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon')) !== null, true, 'bad checksum caught');
  eq((await W.checkWords(W.normalize('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandn'))).includes('abandn'), true, 'misspelling caught');
  const fresh = await W.generateWords(12);
  eq(await W.checkWords(fresh), null, 'fresh words pass their own checksum');
  const t = Date.now(); await W.addresses(fresh, 10, 10); console.log('20 addresses in', Date.now() - t, 'ms');
  console.log('sample fresh:', fresh.slice(0, 3).join(' '), '…');
})();
