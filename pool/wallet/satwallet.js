// Saturn wallet keys in the browser: BIP39 recovery words, BIP32/BIP84 keys (m/84'/0'/0'), and
// native SegWit sat1 addresses, exactly like the Saturn app, so the same 12 words open the same
// wallet in both. Runs entirely on the device: words and keys never leave it.
const SatWallet = (() => {
  const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual adapt add addict address adjust admit adult advance advice aerobic affair afford afraid again age agent agree ahead aim air airport aisle alarm album alcohol alert alien all alley allow almost alone alpha already also alter always amateur amazing among amount amused analyst anchor ancient anger angle angry animal ankle announce annual another answer antenna antique anxiety any apart apology appear apple approve april arch arctic area arena argue arm armed armor army around arrange arrest arrive arrow art artefact artist artwork ask aspect assault asset assist assume asthma athlete atom attack attend attitude attract auction audit august aunt author auto autumn average avocado avoid awake aware away awesome awful awkward axis baby bachelor bacon badge bag balance balcony ball bamboo banana banner bar barely bargain barrel base basic basket battle beach bean beauty because become beef before begin behave behind believe below belt bench benefit best betray better between beyond bicycle bid bike bind biology bird birth bitter black blade blame blanket blast bleak bless blind blood blossom blouse blue blur blush board boat body boil bomb bone bonus book boost border boring borrow boss bottom bounce box boy bracket brain brand brass brave bread breeze brick bridge brief bright bring brisk broccoli broken bronze broom brother brown brush bubble buddy budget buffalo build bulb bulk bullet bundle bunker burden burger burst bus business busy butter buyer buzz cabbage cabin cable cactus cage cake call calm camera camp can canal cancel candy cannon canoe canvas canyon capable capital captain car carbon card cargo carpet carry cart case cash casino castle casual cat catalog catch category cattle caught cause caution cave ceiling celery cement census century cereal certain chair chalk champion change chaos chapter charge chase chat cheap check cheese chef cherry chest chicken chief child chimney choice choose chronic chuckle chunk churn cigar cinnamon circle citizen city civil claim clap clarify claw clay clean clerk clever click client cliff climb clinic clip clock clog close cloth cloud clown club clump cluster clutch coach coast coconut code coffee coil coin collect color column combine come comfort comic common company concert conduct confirm congress connect consider control convince cook cool copper copy coral core corn correct cost cotton couch country couple course cousin cover coyote crack cradle craft cram crane crash crater crawl crazy cream credit creek crew cricket crime crisp critic crop cross crouch crowd crucial cruel cruise crumble crunch crush cry crystal cube culture cup cupboard curious current curtain curve cushion custom cute cycle dad damage damp dance danger daring dash daughter dawn day deal debate debris decade december decide decline decorate decrease deer defense define defy degree delay deliver demand demise denial dentist deny depart depend deposit depth deputy derive describe desert design desk despair destroy detail detect develop device devote diagram dial diamond diary dice diesel diet differ digital dignity dilemma dinner dinosaur direct dirt disagree discover disease dish dismiss disorder display distance divert divide divorce dizzy doctor document dog doll dolphin domain donate donkey donor door dose double dove draft dragon drama drastic draw dream dress drift drill drink drip drive drop drum dry duck dumb dune during dust dutch duty dwarf dynamic eager eagle early earn earth easily east easy echo ecology economy edge edit educate effort egg eight either elbow elder electric elegant element elephant elevator elite else embark embody embrace emerge emotion employ empower empty enable enact end endless endorse enemy energy enforce engage engine enhance enjoy enlist enough enrich enroll ensure enter entire entry envelope episode equal equip era erase erode erosion error erupt escape essay essence estate eternal ethics evidence evil evoke evolve exact example excess exchange excite exclude excuse execute exercise exhaust exhibit exile exist exit exotic expand expect expire explain expose express extend extra eye eyebrow fabric face faculty fade faint faith fall false fame family famous fan fancy fantasy farm fashion fat fatal father fatigue fault favorite feature february federal fee feed feel female fence festival fetch fever few fiber fiction field figure file film filter final find fine finger finish fire firm first fiscal fish fit fitness fix flag flame flash flat flavor flee flight flip float flock floor flower fluid flush fly foam focus fog foil fold follow food foot force forest forget fork fortune forum forward fossil foster found fox fragile frame frequent fresh friend fringe frog front frost frown frozen fruit fuel fun funny furnace fury future gadget gain galaxy gallery game gap garage garbage garden garlic garment gas gasp gate gather gauge gaze general genius genre gentle genuine gesture ghost giant gift giggle ginger giraffe girl give glad glance glare glass glide glimpse globe gloom glory glove glow glue goat goddess gold good goose gorilla gospel gossip govern gown grab grace grain grant grape grass gravity great green grid grief grit grocery group grow grunt guard guess guide guilt guitar gun gym habit hair half hammer hamster hand happy harbor hard harsh harvest hat have hawk hazard head health heart heavy hedgehog height hello helmet help hen hero hidden high hill hint hip hire history hobby hockey hold hole holiday hollow home honey hood hope horn horror horse hospital host hotel hour hover hub huge human humble humor hundred hungry hunt hurdle hurry hurt husband hybrid ice icon idea identify idle ignore ill illegal illness image imitate immense immune impact impose improve impulse inch include income increase index indicate indoor industry infant inflict inform inhale inherit initial inject injury inmate inner innocent input inquiry insane insect inside inspire install intact interest into invest invite involve iron island isolate issue item ivory jacket jaguar jar jazz jealous jeans jelly jewel job join joke journey joy judge juice jump jungle junior junk just kangaroo keen keep ketchup key kick kid kidney kind kingdom kiss kit kitchen kite kitten kiwi knee knife knock know lab label labor ladder lady lake lamp language laptop large later latin laugh laundry lava law lawn lawsuit layer lazy leader leaf learn leave lecture left leg legal legend leisure lemon lend length lens leopard lesson letter level liar liberty library license life lift light like limb limit link lion liquid list little live lizard load loan lobster local lock logic lonely long loop lottery loud lounge love loyal lucky luggage lumber lunar lunch luxury lyrics machine mad magic magnet maid mail main major make mammal man manage mandate mango mansion manual maple marble march margin marine market marriage mask mass master match material math matrix matter maximum maze meadow mean measure meat mechanic medal media melody melt member memory mention menu mercy merge merit merry mesh message metal method middle midnight milk million mimic mind minimum minor minute miracle mirror misery miss mistake mix mixed mixture mobile model modify mom moment monitor monkey monster month moon moral more morning mosquito mother motion motor mountain mouse move movie much muffin mule multiply muscle museum mushroom music must mutual myself mystery myth naive name napkin narrow nasty nation nature near neck need negative neglect neither nephew nerve nest net network neutral never news next nice night noble noise nominee noodle normal north nose notable note nothing notice novel now nuclear number nurse nut oak obey object oblige obscure observe obtain obvious occur ocean october odor off offer office often oil okay old olive olympic omit once one onion online only open opera opinion oppose option orange orbit orchard order ordinary organ orient original orphan ostrich other outdoor outer output outside oval oven over own owner oxygen oyster ozone pact paddle page pair palace palm panda panel panic panther paper parade parent park parrot party pass patch path patient patrol pattern pause pave payment peace peanut pear peasant pelican pen penalty pencil people pepper perfect permit person pet phone photo phrase physical piano picnic picture piece pig pigeon pill pilot pink pioneer pipe pistol pitch pizza place planet plastic plate play please pledge pluck plug plunge poem poet point polar pole police pond pony pool popular portion position possible post potato pottery poverty powder power practice praise predict prefer prepare present pretty prevent price pride primary print priority prison private prize problem process produce profit program project promote proof property prosper protect proud provide public pudding pull pulp pulse pumpkin punch pupil puppy purchase purity purpose purse push put puzzle pyramid quality quantum quarter question quick quit quiz quote rabbit raccoon race rack radar radio rail rain raise rally ramp ranch random range rapid rare rate rather raven raw razor ready real reason rebel rebuild recall receive recipe record recycle reduce reflect reform refuse region regret regular reject relax release relief rely remain remember remind remove render renew rent reopen repair repeat replace report require rescue resemble resist resource response result retire retreat return reunion reveal review reward rhythm rib ribbon rice rich ride ridge rifle right rigid ring riot ripple risk ritual rival river road roast robot robust rocket romance roof rookie room rose rotate rough round route royal rubber rude rug rule run runway rural sad saddle sadness safe sail salad salmon salon salt salute same sample sand satisfy satoshi sauce sausage save say scale scan scare scatter scene scheme school science scissors scorpion scout scrap screen script scrub sea search season seat second secret section security seed seek segment select sell seminar senior sense sentence series service session settle setup seven shadow shaft shallow share shed shell sheriff shield shift shine ship shiver shock shoe shoot shop short shoulder shove shrimp shrug shuffle shy sibling sick side siege sight sign silent silk silly silver similar simple since sing siren sister situate six size skate sketch ski skill skin skirt skull slab slam sleep slender slice slide slight slim slogan slot slow slush small smart smile smoke smooth snack snake snap sniff snow soap soccer social sock soda soft solar soldier solid solution solve someone song soon sorry sort soul sound soup source south space spare spatial spawn speak special speed spell spend sphere spice spider spike spin spirit split spoil sponsor spoon sport spot spray spread spring spy square squeeze squirrel stable stadium staff stage stairs stamp stand start state stay steak steel stem step stereo stick still sting stock stomach stone stool story stove strategy street strike strong struggle student stuff stumble style subject submit subway success such sudden suffer sugar suggest suit summer sun sunny sunset super supply supreme sure surface surge surprise surround survey suspect sustain swallow swamp swap swarm swear sweet swift swim swing switch sword symbol symptom syrup system table tackle tag tail talent talk tank tape target task taste tattoo taxi teach team tell ten tenant tennis tent term test text thank that theme then theory there they thing this thought three thrive throw thumb thunder ticket tide tiger tilt timber time tiny tip tired tissue title toast tobacco today toddler toe together toilet token tomato tomorrow tone tongue tonight tool tooth top topic topple torch tornado tortoise toss total tourist toward tower town toy track trade traffic tragic train transfer trap trash travel tray treat tree trend trial tribe trick trigger trim trip trophy trouble truck true truly trumpet trust truth try tube tuition tumble tuna tunnel turkey turn turtle twelve twenty twice twin twist two type typical ugly umbrella unable unaware uncle uncover under undo unfair unfold unhappy uniform unique unit universe unknown unlock until unusual unveil update upgrade uphold upon upper upset urban urge usage use used useful useless usual utility vacant vacuum vague valid valley valve van vanish vapor various vast vault vehicle velvet vendor venture venue verb verify version very vessel veteran viable vibrant vicious victory video view village vintage violin virtual virus visa visit visual vital vivid vocal voice void volcano volume vote voyage wage wagon wait walk wall walnut want warfare warm warrior wash wasp waste water wave way wealth weapon wear weasel weather web wedding weekend weird welcome west wet whale what wheat wheel when where whip whisper wide width wife wild will win window wine wing wink winner winter wire wisdom wise wish witness wolf woman wonder wood wool word work world worry worth wrap wreck wrestle wrist write wrong yard year yellow you young youth zebra zero zone zoo'.split(' ');
  const te = new TextEncoder();
  const subtle = globalThis.crypto.subtle;
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const bytesToBig = (b) => BigInt('0x' + (toHex(b) || '0'));
  const bigToBytes = (n, len = 32) => { const h = n.toString(16).padStart(len * 2, '0'); return Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16)); };
  const ser32 = (i) => new Uint8Array([i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255]);
  const sha256 = async (b) => new Uint8Array(await subtle.digest('SHA-256', b));
  async function hmac512(key, data) {
    const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    return new Uint8Array(await subtle.sign('HMAC', k, data));
  }

  // ---- RIPEMD-160 (for hash160 = RIPEMD160(SHA256(pubkey))) ----
  function ripemd160(msg) {
    const rl = (x, n) => (x << n) | (x >>> (32 - n));
    const f = (j, x, y, z) => j < 16 ? x ^ y ^ z : j < 32 ? (x & y) | (~x & z) : j < 48 ? (x | ~y) ^ z : j < 64 ? (x & z) | (y & ~z) : x ^ (y | ~z);
    const K1 = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e], K2 = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000];
    const R1 = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
    const R2 = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
    const S1 = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
    const S2 = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
    const len = msg.length, padLen = ((len + 8) >> 6 << 6) + 64;
    const m = new Uint8Array(padLen); m.set(msg); m[len] = 0x80;
    const bits = len * 8; for (let i = 0; i < 8; i++) m[padLen - 8 + i] = Math.floor(bits / 2 ** (8 * i)) & 255;
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const X = new Int32Array(16);
    for (let o = 0; o < padLen; o += 64) {
      for (let i = 0; i < 16; i++) X[i] = m[o + 4 * i] | (m[o + 4 * i + 1] << 8) | (m[o + 4 * i + 2] << 16) | (m[o + 4 * i + 3] << 24);
      let al = h0, bl = h1, cl = h2, dl = h3, el = h4, ar = h0, br = h1, cr = h2, dr = h3, er = h4;
      for (let j = 0; j < 80; j++) {
        let t = (rl((al + f(j, bl, cl, dl) + X[R1[j]] + K1[j >> 4]) | 0, S1[j]) + el) | 0;
        al = el; el = dl; dl = rl(cl, 10); cl = bl; bl = t;
        t = (rl((ar + f(79 - j, br, cr, dr) + X[R2[j]] + K2[j >> 4]) | 0, S2[j]) + er) | 0;
        ar = er; er = dr; dr = rl(cr, 10); cr = br; br = t;
      }
      const t = (h1 + cl + dr) | 0; h1 = (h2 + dl + er) | 0; h2 = (h3 + el + ar) | 0; h3 = (h4 + al + br) | 0; h4 = (h0 + bl + cr) | 0; h0 = t;
    }
    const out = new Uint8Array(20);
    [h0, h1, h2, h3, h4].forEach((h, i) => { for (let k = 0; k < 4; k++) out[4 * i + k] = (h >>> (8 * k)) & 255; });
    return out;
  }

  // ---- secp256k1 (Jacobian coordinates, BigInt) ----
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n, 1n];
  const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
  function inv(a, m = P) { let [x, y, u, v] = [mod(a, m), m, 1n, 0n]; while (x !== 0n) { const q = y / x; [y, x] = [x, y - q * x]; [v, u] = [u, v - q * u]; } return mod(v, m); }
  function dbl([X, Y, Z]) {
    if (Y === 0n) return [0n, 1n, 0n];
    const S = mod(4n * X * Y * Y), M = mod(3n * X * X), X3 = mod(M * M - 2n * S);
    return [X3, mod(M * (S - X3) - 8n * Y ** 4n), mod(2n * Y * Z)];
  }
  function add(p, q) {
    if (p[2] === 0n) return q; if (q[2] === 0n) return p;
    const [X1, Y1, Z1] = p, [X2, Y2, Z2] = q;
    const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2);
    const U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1), S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1);
    if (U1 === U2) return S1 === S2 ? dbl(p) : [0n, 1n, 0n];
    const H = mod(U2 - U1), R = mod(S2 - S1), H2 = mod(H * H), H3 = mod(H * H2), V = mod(U1 * H2);
    const X3 = mod(R * R - H3 - 2n * V);
    return [X3, mod(R * (V - X3) - S1 * H3), mod(H * Z1 * Z2)];
  }
  function mul(k) {
    let r = [0n, 1n, 0n], q = G;
    for (; k > 0n; k >>= 1n) { if (k & 1n) r = add(r, q); q = dbl(q); }
    return r;
  }
  function pubkey(priv) {
    const [X, Y, Z] = mul(priv), zi = inv(Z), zi2 = mod(zi * zi);
    const x = mod(X * zi2), y = mod(Y * zi2 * zi);
    return cat(new Uint8Array([y & 1n ? 3 : 2]), bigToBytes(x));
  }

  // ---- bech32 (BIP173), witness v0 ----
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(v) { const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const x of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((b >>> i) & 1) c ^= GEN[i]; } return c >>> 0; }
  function segwitAddress(hrp, program) {
    const data = [0]; let acc = 0, bits = 0;
    for (const b of program) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; data.push((acc >>> bits) & 31); } }
    if (bits) data.push((acc << (5 - bits)) & 31);
    const hx = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
    const pm = polymod(hx.concat(data, [0, 0, 0, 0, 0, 0])) ^ 1;
    const chk = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
    return hrp + '1' + data.concat(chk).map((d) => CH[d]).join('');
  }

  // ---- BIP39 ----
  async function generateWords(count = 12) {
    const ent = crypto.getRandomValues(new Uint8Array(count === 24 ? 32 : 16));
    const cs = (await sha256(ent))[0];
    let bits = Array.from(ent, (b) => b.toString(2).padStart(8, '0')).join('') + cs.toString(2).padStart(8, '0').slice(0, ent.length / 4);
    return Array.from({ length: count }, (_, i) => WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  }
  const normalize = (phrase) => phrase.normalize('NFKD').toLowerCase().trim().split(/\s+/).filter(Boolean);
  async function checkWords(words) {
    if (![12, 15, 18, 21, 24].includes(words.length)) return 'A recovery phrase has 12 or 24 words.';
    const bad = words.find((w) => !WORDS.includes(w));
    if (bad) return `"${bad}" isn't a recovery word. Check the spelling.`;
    const bits = words.map((w) => WORDS.indexOf(w).toString(2).padStart(11, '0')).join('');
    const entBits = Math.floor(bits.length * 32 / 33), ent = Uint8Array.from(bits.slice(0, entBits).match(/.{8}/g), (b) => parseInt(b, 2));
    const want = (await sha256(ent))[0].toString(2).padStart(8, '0').slice(0, bits.length - entBits);
    return want === bits.slice(entBits) ? null : "Those words don't add up (a word is wrong or out of order).";
  }
  async function seedFrom(words, passphrase = '') {
    const k = await subtle.importKey('raw', te.encode(words.join(' ').normalize('NFKD')), 'PBKDF2', false, ['deriveBits']);
    const salt = te.encode(('mnemonic' + passphrase).normalize('NFKD'));
    return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt, iterations: 2048 }, k, 512));
  }

  // ---- BIP32 private derivation ----
  async function child({ key, chain }, i) {
    const data = i >= 0x80000000 ? cat(new Uint8Array([0]), bigToBytes(key), ser32(i)) : cat(pubkey(key), ser32(i));
    const I = await hmac512(chain, data);
    return { key: mod(bytesToBig(I.slice(0, 32)) + key, N), chain: I.slice(32) };
  }
  const H = 0x80000000;
  async function account(words) {
    const I = await hmac512(te.encode('Bitcoin seed'), await seedFrom(words));
    let k = { key: bytesToBig(I.slice(0, 32)), chain: I.slice(32) };
    for (const i of [84 + H, 0 + H, 0 + H]) k = await child(k, i);
    return k;
  }
  async function addressAt(acct, change, index) {
    const k = await child(await child(acct, change), index);
    return segwitAddress('sat', ripemd160(await sha256(pubkey(k.key))));
  }
  // receive addresses 0..r-1 and change addresses 0..c-1
  async function addresses(words, r = 1, c = 0) {
    const acct = await account(words);
    const ext = await child(acct, 0), int = await child(acct, 1);
    const one = async (base, i) => { const k = await child(base, i); return segwitAddress('sat', ripemd160(await sha256(pubkey(k.key)))); };
    const out = { receive: [], change: [] };
    for (let i = 0; i < r; i++) out.receive.push(await one(ext, i));
    for (let i = 0; i < c; i++) out.change.push(await one(int, i));
    return out;
  }
  return { generateWords, checkWords, normalize, addresses, _ripemd160: ripemd160, _segwitAddress: segwitAddress, WORDS };
})();
if (typeof module !== 'undefined') module.exports = SatWallet;
