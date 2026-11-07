// Saturn pool: stratum v1 server, pool website and light-wallet API.
//
// Miners get unique extranonce1 values, per-connection variable difficulty and BIP310 version rolling
// (Bitaxe/ESP-Miner uses it). Every share is checked against its share target; shares that also meet
// the network target are assembled into a full block (with the template's transactions, BIP34 height
// and the segwit witness commitment) and submitted to Saturn Core. New work is pushed to all miners
// when the chain tip changes.
//
// Payouts are PPLNS: a block's reward is split over the last N shares' worth of work (N = pplnsFactor
// x the block difficulty), not just the work since the previous block, so hopping in and out of the
// pool doesn't pay. Miners who log in with the password "solo" mine blocks that pay their own address
// the whole reward. payout.js pays rounds once they unlock.
//
// Files (in dataDir, default ./data). Each file has exactly one writer:
//   written here:      stats.json (work this round), workers.json (all-time), blocks.json, rounds.json,
//                      pplns.json (the share window), history.json, guard.json (reorg alarm)
//   written by payout: payouts.json (owed, paid, settled rounds)
//
// Abuse limits: connections per IP, login and idle timeouts, a cap on line length, temporary bans for
// clients that send mostly junk, and per-IP rate limits on the HTTP API.

const net = require("net");
const http = require("http");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const crypto = require("crypto");

const CONFIG_FILE = process.env.SATURN_POOL_CONFIG || "./config.json";
const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
const DATA = config.dataDir || process.env.SATURN_POOL_DATA || "./data";
fs.mkdirSync(DATA, { recursive: true });
const dataFile = (name) => path.join(DATA, name);

// Everything a block pays goes to the pool wallet; payout.js forwards miners' shares from there.
// address prefix miners log in with ("bcrt" lets the pool run against a regtest chain for testing)
const ADDRESS_PREFIX = config.addressPrefix || "sat";
const payoutScript = config.payoutScript || "00148b0ba8d3e679a540d3869aeb9dd7c7ca369234cc";
const POOL_TAG = Buffer.from(config.poolTag || "/Saturn Pool/");
const EXTRANONCE2_SIZE = 4;

// share difficulty: start, bounds, and how often a miner should find a share
const START_DIFF = config.startDifficulty || 256;
const MIN_DIFF = config.minDifficulty || 1;
const MAX_DIFF = config.maxDifficulty || 2 ** 32;
const TARGET_SHARE_SECONDS = config.targetShareSeconds || 10;
const RETARGET_SECONDS = 60;
// browsers (the Mine tab on the pool site) hash a million times slower than a Bitaxe: they start and
// may go much lower, so even a phone finds a share every few seconds
const BROWSER_START_DIFF = Number(config.browserStartDifficulty ?? 1 / 16);
const BROWSER_MIN_DIFF = Number(config.browserMinDifficulty ?? 1 / 1024);
// only pages on these sites may open a browser-mining connection, so nobody can embed the miner on
// their own site and quietly mine with their visitors' phones
const WS_ORIGINS = config.wsOrigins || ["https://pool.saturn.boats", "https://saturn.boats", "https://www.saturn.boats"];

// PPLNS window: this many blocks' worth of work (at the current block difficulty)
const PPLNS_FACTOR = Number(config.pplnsFactor ?? 2);

// abuse limits
const MAX_CONNECTIONS = Number(config.maxConnections ?? 20000);
const MAX_PER_IP = Number(config.maxConnectionsPerIp ?? 64); // a farm behind one router needs room
const LOGIN_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 15 * 60_000;
const MAX_LINE = 16 * 1024;
const BAN_MS = 10 * 60_000;

// reorg alarm: a chain reorganisation at least this deep pauses payouts until someone checks
const REORG_ALERT_DEPTH = Number(config.reorgAlertDepth ?? 6);

const VERSION_ROLLING_MASK = 0x1fffe000;
const DIFF1_TARGET = 0xffffn << 208n;

let template = null; // latest getblocktemplate result
let nextJobId = 1;
let nextExtranonce1 = crypto.randomBytes(2).readUInt16BE() << 8; // random start so restarts don't reuse values
const jobs = new Map(); // jobId -> job
const clients = new Set();

/* ------------------------------------------------------------------ */
/* data: kept in memory, written to disk in the background             */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return fallback;
  }
}
// write to a temp file and rename it over the old one, so a crash never leaves half a file
function writeJsonAtomic(file, value, pretty = false) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value));
  fs.renameSync(tmp, file);
}

const roundId = (r) => `${r.height}:${r.hash}`;
const round8 = (v) => Math.round(v * 1e8) / 1e8;

// rounds used to live inside payouts.json; the first start of this version moves them out (payout.js
// does the same if it starts first, so whichever runs first, nothing is lost)
function loadRounds() {
  const f = dataFile("rounds.json");
  if (fs.existsSync(f)) return readJson(f, []);
  const old = (readJson(dataFile("payouts.json"), {}).rounds || []).map(({ status, ...r }) => r);
  writeJsonAtomic(f, old);
  return old;
}

const db = {
  stats: readJson(dataFile("stats.json"), { totalShares: 0, miners: {} }),
  workers: readJson(dataFile("workers.json"), null),
  blocks: readJson(dataFile("blocks.json"), []),
  rounds: loadRounds(),
  history: readJson(dataFile("history.json"), []).filter(([t]) => t > Date.now() - 86_400_000),
  guard: readJson(dataFile("guard.json"), { paused: null, reorgs: [] }),
};
// first run with the all-time worker list: seed it from the current round and the blocks found so far
if (!db.workers) {
  db.workers = {};
  for (const [w, m] of Object.entries(db.stats.miners || {})) db.workers[w] = { work: m.shares || 0, shares: 0, blocks: 0, lastShare: m.lastShare };
  for (const b of db.blocks) if (db.workers[b.miner]) db.workers[b.miner].blocks++;
}

const dirty = new Set();
function save(name, now = false) {
  dirty.add(name);
  if (now) flush();
}
function flush() {
  for (const name of dirty) {
    try {
      if (name === "pplns") writeJsonAtomic(dataFile("pplns.json"), { shares: pplns.slice(pplnsHead) });
      else writeJsonAtomic(dataFile(`${name}.json`), db[name], name === "blocks" || name === "guard");
    } catch (e) {
      console.error(`couldn't save ${name}:`, e.message);
      continue;
    }
    dirty.delete(name);
  }
}
setInterval(flush, 10_000);
for (const sig of ["SIGTERM", "SIGINT"])
  process.on(sig, () => {
    flush();
    process.exit(0);
  });

/* ------------------------------------------------------------------ */
/* shares, blocks and PPLNS                                            */
/* ------------------------------------------------------------------ */

// the window: [address, work, time] oldest first; entries before pplnsHead are already dropped
let pplns = (readJson(dataFile("pplns.json"), { shares: [] }).shares || []).filter((e) => Array.isArray(e) && e[1] > 0);
let pplnsHead = 0;
let pplnsWork = pplns.reduce((a, e) => a + e[1], 0);

function blockDifficulty() {
  return template ? Number(DIFF1_TARGET) / Number(targetFromBits(template.bits)) : null;
}
const pplnsWindow = () => {
  const d = blockDifficulty();
  return d ? PPLNS_FACTOR * d : Infinity;
};

function trimPplns() {
  const want = pplnsWindow();
  while (pplnsHead < pplns.length && pplnsWork > want) {
    const e = pplns[pplnsHead];
    const excess = pplnsWork - want;
    if (e[1] <= excess) {
      pplnsWork -= e[1];
      pplnsHead++;
    } else {
      e[1] -= excess; // keep exactly the window: the oldest share counts in part
      pplnsWork = want;
    }
  }
  // compact now and then so the array doesn't grow forever
  if (pplnsHead > 50_000 && pplnsHead > pplns.length / 2) {
    pplns = pplns.slice(pplnsHead);
    pplnsHead = 0;
  }
}

function addPplns(address, work) {
  const last = pplns[pplns.length - 1];
  // consecutive shares from one address within a minute share an entry (keeps the file small)
  if (pplns.length > pplnsHead && last[0] === address && Date.now() - last[2] < 60_000) last[1] += work;
  else pplns.push([address, work, Date.now()]);
  pplnsWork += work;
  trimPplns();
  save("pplns");
}

// shares are weighted by their difficulty, so a Bitaxe at diff 4096 earns 4096x a diff-1 share
function recordShare(worker, difficulty, solo = false) {
  const now = new Date().toISOString();
  const w = (db.workers[worker] = db.workers[worker] || { work: 0, shares: 0, blocks: 0, firstSeen: now });
  if (!w.device) { const live = [...clients].find((x) => x.worker === worker && x.device); if (live) w.device = live.device; }
  w.work += difficulty;
  w.shares += 1;
  w.lastShare = now;
  save("workers");
  // solo work isn't part of the pool's round or window: only the all-time record counts it
  if (solo) return;
  const s = db.stats;
  s.totalShares = (s.totalShares || 0) + difficulty;
  const m = (s.miners[worker] = s.miners[worker] || { shares: 0 });
  m.shares += difficulty;
  m.lastShare = now;
  save("stats");
  addPplns(worker.split(".")[0], difficulty);
}

function recordBlock(worker, height, reward, hash, solo = false) {
  if (db.workers[worker]) db.workers[worker].blocks = (db.workers[worker].blocks || 0) + 1;
  db.blocks.unshift({ height, miner: worker, reward, hash, time: new Date().toISOString(), ...(solo ? { solo: true } : {}) });
  db.blocks = db.blocks.slice(0, 25);
  save("workers");
  save("blocks", true);
}

// Split a found block's reward over the PPLNS window by work and record it as a round. payout.js pays
// a round once its reward has unlocked (101 confirmations) and the block is still in the chain.
function creditPayouts(rewardSat, height, hash) {
  trimPplns();
  const work = {};
  let total = 0;
  for (let i = pplnsHead; i < pplns.length; i++) {
    const [a, w] = pplns[i];
    work[a] = (work[a] || 0) + w;
    total += w;
  }
  let scheme = "pplns";
  if (!total) {
    // no window yet (first block after an upgrade): fall back to the work since the previous block
    scheme = "round";
    for (const [worker, m] of Object.entries(db.stats.miners || {})) {
      const a = worker.split(".")[0];
      work[a] = (work[a] || 0) + (m.shares || 0);
      total += m.shares || 0;
    }
  }
  if (!total) {
    console.log("payout skipped: no shares recorded");
    return;
  }
  const credits = {};
  for (const [a, w] of Object.entries(work)) {
    const v = Math.floor((w / total) * rewardSat * 1e8) / 1e8; // never promise more than the block paid
    if (v > 0) credits[a] = v;
  }
  db.rounds.push({ height, hash, reward: rewardSat, credits, scheme, work: total, time: new Date().toISOString() });
  db.stats = { totalShares: 0, miners: {} };
  save("stats");
  save("rounds", true);
  console.log(`payouts credited (${scheme}): block ${height}, ${rewardSat} SAT over ${Object.keys(credits).length} miner(s)`);
}

// payouts.json is payout.js's file; read it, never write it
function payoutState() {
  const p = readJson(dataFile("payouts.json"), {});
  const settled = { ...(p.settled || {}) };
  // payouts.json from before rounds.json existed keeps each round's status inline
  for (const r of p.rounds || []) if (r.status && r.status !== "immature") settled[roundId(r)] = r.status;
  return { owed: p.owed || {}, paid: p.paid || [], settled, resumedAt: p.resumedAt || null };
}

// pending = owed (unlocked, not yet paid) + credits of rounds still maturing
function pendingNow(p = payoutState()) {
  const pending = {};
  for (const [a, v] of Object.entries(p.owed)) pending[a] = (pending[a] || 0) + v;
  for (const r of db.rounds) if (!p.settled[roundId(r)]) for (const [a, v] of Object.entries(r.credits)) pending[a] = (pending[a] || 0) + v;
  for (const a of Object.keys(pending)) pending[a] = round8(pending[a]);
  return pending;
}

// rounds payout.js has settled and that are well buried can go
function pruneRounds() {
  if (!template || db.rounds.length < 300) return;
  const { settled } = payoutState();
  const before = db.rounds.length;
  db.rounds = db.rounds.filter((r) => !settled[roundId(r)] || r.height > template.height - 1000);
  if (db.rounds.length !== before) save("rounds");
}
setInterval(pruneRounds, 10 * 60_000);

/* ------------------------------------------------------------------ */
/* encoding helpers                                                    */
/* ------------------------------------------------------------------ */

function sha256d(buf) {
  return crypto.createHash("sha256").update(crypto.createHash("sha256").update(buf).digest()).digest();
}
const reverse = (buf) => Buffer.from(buf).reverse();
function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function varint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) return Buffer.concat([Buffer.from([0xfd]), Buffer.from([n & 0xff, n >> 8])]);
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}
function pushData(buf) {
  if (buf.length >= 76) throw new Error("push too large");
  return Buffer.concat([Buffer.from([buf.length]), buf]);
}
// BIP34: the coinbase scriptSig starts with the height exactly as `CScript() << nHeight` writes it
function heightScript(h) {
  if (h === 0) return Buffer.from([0x00]);
  if (h >= 1 && h <= 16) return Buffer.from([0x50 + h]); // OP_1..OP_16
  const bytes = [];
  let v = h;
  while (v > 0) {
    bytes.push(v & 0xff);
    v = Math.floor(v / 256);
  }
  if (bytes[bytes.length - 1] & 0x80) bytes.push(0);
  return pushData(Buffer.from(bytes));
}
function targetFromBits(bitsHex) {
  const bits = parseInt(bitsHex, 16);
  const exp = BigInt(bits >>> 24);
  const mant = BigInt(bits & 0x7fffff);
  return exp <= 3n ? mant >> (8n * (3n - exp)) : mant << (8n * (exp - 3n));
}
function targetFromDifficulty(d) {
  // DIFF1 / d with ~9 significant digits of d, in integer math
  const scale = 1_000_000_000n;
  return (DIFF1_TARGET * scale) / BigInt(Math.max(1, Math.round(d * 1e9)));
}
const hashToBigInt = (hashLE) => BigInt("0x" + reverse(hashLE).toString("hex"));

// stratum sends the previous block hash as 8 words, each 4-byte word byte-swapped
function stratumPrevHash(rpcHex) {
  const internal = reverse(Buffer.from(rpcHex, "hex"));
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = internal[i * 4 + 3 - j];
  return out.toString("hex");
}

// branches to combine with the coinbase hash to get the merkle root (txids in internal byte order)
function merkleBranches(txids) {
  const branches = [];
  let level = [null, ...txids];
  while (level.length > 1) {
    branches.push(level[1]);
    const next = [null];
    for (let i = 2; i < level.length; i += 2) next.push(sha256d(Buffer.concat([level[i], level[i + 1] || level[i]])));
    level = next;
  }
  return branches;
}

/* ------------------------------------------------------------------ */
/* jobs                                                                */
/* ------------------------------------------------------------------ */

// Segwit data is only allowed once the chain has activated it (getblocktemplate lists it in
// "rules"). Before that, a coinbase witness makes the node reject the block as "unexpected-witness".
const witnessActive = (t) => !!t.default_witness_commitment && (t.rules || []).some((r) => r.replace(/^!/, "") === "segwit");

function registerJob(job) {
  jobs.set(job.id, job);
  // keep recent jobs (pool, solo and per-miner copies) so in-flight shares on recent work count
  while (jobs.size > 20_000) jobs.delete(jobs.keys().next().value);
  return job;
}

function buildJob(t, clean, outScript = payoutScript) {
  const id = (nextJobId++).toString(16);
  const scriptPrefix = heightScript(t.height);
  const scriptSuffix = pushData(POOL_TAG);
  const scriptLen = scriptPrefix.length + 4 + EXTRANONCE2_SIZE + scriptSuffix.length;
  if (scriptLen > 100) throw new Error("coinbase script too long");

  const outputs = [Buffer.concat([u64le(t.coinbasevalue), varint(outScript.length / 2), Buffer.from(outScript, "hex")])];
  if (witnessActive(t)) {
    const c = Buffer.from(t.default_witness_commitment, "hex");
    outputs.push(Buffer.concat([u64le(0), varint(c.length), c]));
  }
  // coinb1 | extranonce1 | extranonce2 | coinb2 is the coinbase without witness (its txid form)
  const coinb1 = Buffer.concat([u32le(2), Buffer.from([1]), Buffer.alloc(32), Buffer.from("ffffffff", "hex"), varint(scriptLen), scriptPrefix]);
  const coinb2 = Buffer.concat([scriptSuffix, Buffer.from("ffffffff", "hex"), varint(outputs.length), ...outputs, u32le(0)]);
  const txs = t.transactions || [];
  const branches = merkleBranches(txs.map((tx) => reverse(Buffer.from(tx.txid, "hex"))));
  return registerJob({
    id,
    template: t,
    coinb1,
    coinb2,
    branches,
    txs,
    target: targetFromBits(t.bits),
    prevhash: stratumPrevHash(t.previousblockhash),
    clean,
    created: Date.now(),
  });
}

// The same work under a new job id, for one miner whose difficulty just changed. ESP-Miner restarts
// extranonce2 at 0 on every notify, so re-sending the old id would make it redo work it already did;
// a copy keeps that cheap without sending everyone a new job.
function copyJob(job) {
  return registerJob({ ...job, id: (nextJobId++).toString(16), clean: false, created: Date.now() });
}

function notifyParams(job) {
  const t = job.template;
  return [
    job.id,
    job.prevhash,
    job.coinb1.toString("hex"),
    job.coinb2.toString("hex"),
    job.branches.map((b) => b.toString("hex")),
    t.version.toString(16).padStart(8, "0"),
    t.bits,
    t.curtime.toString(16).padStart(8, "0"),
    job.clean,
  ];
}

let currentJob = null;

async function refreshTemplate(force = false) {
  try {
    const t = await rpc("getblocktemplate", [{ rules: ["segwit"] }]);
    const tipChanged = !template || t.previousblockhash !== template.previousblockhash;
    const txsChanged = !template || (t.transactions || []).length !== (template.transactions || []).length;
    const prevTip = template ? { height: template.height - 1, hash: template.previousblockhash } : null;
    template = t;
    if (tipChanged || txsChanged || force || Date.now() - (currentJob?.created || 0) > 60_000) {
      if (tipChanged) console.log("new block template: height", t.height, "bits", t.bits, "txs", (t.transactions || []).length);
      currentJob = buildJob(t, tipChanged);
      soloJobs.clear();
      if (tipChanged) {
        jobs.forEach((j, id) => j.template.previousblockhash !== t.previousblockhash && jobs.delete(id));
        if (prevTip) checkReorg(prevTip, t).catch((e) => console.error("reorg check failed:", e.message));
      } else {
        // work older than 10 minutes on the same tip is still valid but nobody should be on it
        const old = Date.now() - 10 * 60_000;
        jobs.forEach((j, id) => j.created < old && j !== currentJob && jobs.delete(id));
      }
      for (const c of clients) if (c.authorized) sendJob(c);
    }
  } catch (e) {
    console.error("getblocktemplate failed:", e.message);
  }
}

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

const SLOW_RPC = new Set(["scantxoutset", "submitblock"]);
async function rpc(method, params = [], wallet = null) {
  const auth = Buffer.from(`${config.rpc.user}:${config.rpc.password}`).toString("base64");
  const res = await fetch(`http://${config.rpc.host}:${config.rpc.port}${wallet ? `/wallet/${encodeURIComponent(wallet)}` : ""}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "saturn-pool", method, params }),
    timeout: SLOW_RPC.has(method) ? 180_000 : 30_000,
  });
  if (res.status === 401 || res.status === 403) throw new Error(`the node refused ${method} (check the pool's RPC user and its whitelist)`);
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/* ------------------------------------------------------------------ */
/* reorg alarm                                                         */
/* ------------------------------------------------------------------ */

// When the tip moves, the block we were building on should still be in the chain. If it isn't, the
// chain reorganised: walk back to where the old branch rejoins it to measure how deep. A deep reorg is
// what a 51% attack looks like, so payouts pause (payout.js honours guard.json) until an operator
// checks the chain and runs `node payout.js --resume`.
async function checkReorg(prevTip, t) {
  if (prevTip.hash === t.previousblockhash) return;
  let hash = prevTip.hash;
  let depth = 0;
  for (; depth < 500; depth++) {
    const h = await rpc("getblockheader", [hash]).catch(() => null);
    if (!h) return; // a block we never fully had; nothing to measure
    if (h.confirmations !== -1) break; // back on the main chain
    hash = h.previousblockhash;
  }
  if (depth === 0) return;
  const event = { time: new Date().toISOString(), depth, oldTip: prevTip.hash, oldHeight: prevTip.height, newTip: t.previousblockhash, newHeight: t.height - 1 };
  console.error(`CHAIN REORGANISATION: ${depth} block(s) replaced (old tip ${prevTip.height} ${prevTip.hash})`);
  db.guard.reorgs = [event, ...(db.guard.reorgs || [])].slice(0, 50);
  if (depth >= REORG_ALERT_DEPTH && !db.guard.paused) {
    db.guard.paused = { since: event.time, depth, reason: `a ${depth}-block chain reorganisation` };
    console.error(`PAYOUTS PAUSED: the chain reorganised ${depth} blocks deep. Check it, then run: node payout.js --resume`);
  }
  save("guard", true);
  alert(depth >= REORG_ALERT_DEPTH ? `⚠️ Saturn chain reorganised ${depth} blocks deep (old tip ${prevTip.height}). Pool payouts are paused until you run \`node payout.js --resume\`.` : `Saturn chain reorganised ${depth} block(s) at height ${prevTip.height}.`);
}

// optional: post alarms to a Discord/Slack-style webhook (config.alertWebhook)
function alert(text) {
  if (!config.alertWebhook) return;
  fetch(config.alertWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, text }), timeout: 10_000 }).catch((e) =>
    console.error("alert webhook failed:", e.message),
  );
}

/* ------------------------------------------------------------------ */
/* stratum connections                                                 */
/* ------------------------------------------------------------------ */

function send(socket, obj) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(obj) + "\n");
}

// whole powers of two: ESP-Miner (Bitaxe) truncates set_difficulty to an integer, so a fractional
// difficulty made it submit shares the pool then judged too easy
function roundDiff(d, min = MIN_DIFF) {
  const clamped = Math.min(MAX_DIFF, Math.max(min, d));
  return 2 ** Math.round(Math.log2(clamped));
}

function setDifficulty(c, d) {
  c.difficulty = roundDiff(d, c.minDiff);
  send(c.socket, { id: null, method: "mining.set_difficulty", params: [c.difficulty] });
}

// Solo miners mine the same template, but its coinbase pays their own address the whole reward.
// One solo job per (pool job, payout script), shared by every solo miner with that address.
const soloJobs = new Map(); // `${poolJobId}:${script}` -> job
function jobFor(c) {
  if (!c.soloScript) return currentJob;
  const key = `${currentJob.id}:${c.soloScript}`;
  let job = soloJobs.get(key);
  if (!job) {
    job = buildJob(currentJob.template, currentJob.clean, c.soloScript);
    job.solo = true;
    soloJobs.set(key, job);
    while (soloJobs.size > 10_000) soloJobs.delete(soloJobs.keys().next().value);
  }
  return job;
}

function sendJob(c, fresh = false) {
  if (!currentJob) return;
  let job = jobFor(c);
  if (fresh) job = copyJob(job);
  // a job re-sent after a difficulty change keeps the easier of the two, so shares the miner is
  // already working on at the old difficulty still count
  const prev = c.jobDiff.get(job.id);
  c.jobDiff.set(job.id, prev === undefined ? c.difficulty : Math.min(prev, c.difficulty));
  if (c.jobDiff.size > 40) c.jobDiff.delete(c.jobDiff.keys().next().value);
  send(c.socket, { id: null, method: "mining.notify", params: notifyParams(job) });
}

// aim for one share every TARGET_SHARE_SECONDS; move at most 4x per step
function retarget(c) {
  const elapsed = (Date.now() - c.windowStart) / 1000;
  if (elapsed < RETARGET_SECONDS && c.windowShares < 30) return;
  const rate = c.windowShares / elapsed; // shares per second at the current difficulty
  const wanted = 1 / TARGET_SHARE_SECONDS;
  let factor = rate > 0 ? rate / wanted : 0.25;
  factor = Math.min(4, Math.max(0.25, factor));
  c.windowStart = Date.now();
  c.windowShares = 0;
  if (factor > 0.8 && factor < 1.25) return;
  const next = roundDiff(c.difficulty * factor, c.minDiff);
  if (next === c.difficulty) return;
  setDifficulty(c, next);
  // the new difficulty applies from the next job: this miner (only) gets the current work under a
  // fresh job id
  sendJob(c, true);
}

// clients that mostly send junk (malformed lines, invalid shares) are cut off for a while
const bans = new Map(); // ip -> until
const perIp = new Map(); // ip -> open connections
function junk(c, weight = 1) {
  c.junk += weight;
  if (c.junk >= 50 && c.junk > 4 * (c.accepted + 1)) {
    bans.set(c.ip, Date.now() + BAN_MS);
    console.log(`banned ${c.ip} for ${BAN_MS / 60_000} min: ${c.junk} bad messages, ${c.accepted} good shares`);
    c.socket.destroy();
  }
}

async function handleSubmit(c, msg) {
  const [, jobId, en2Hex, ntimeHex, nonceHex, versionBitsHex] = msg.params || [];
  const reject = (code, text, bad = true) => {
    c.rejected++;
    // all-time count per worker, shown in the pool's miner list
    const w = c.worker && db.workers[c.worker];
    if (w) {
      w.rejected = (w.rejected || 0) + 1;
      save("workers");
    }
    if (bad) junk(c);
    if (c.rejected <= 50 || c.rejected % 100 === 0) console.log(`share rejected from ${c.worker || c.ip}: ${text} (job ${jobId})`);
    send(c.socket, { id: msg.id, result: false, error: [code, text, null] });
  };
  if (!c.authorized) return reject(24, "unauthorized");
  const job = jobs.get(String(jobId));
  if (!job) return reject(21, "stale job", false); // normal right after a new block
  if (typeof en2Hex !== "string" || en2Hex.length !== EXTRANONCE2_SIZE * 2 || !/^[0-9a-f]+$/i.test(en2Hex)) return reject(20, "bad extranonce2");
  if (!/^[0-9a-f]{8}$/i.test(ntimeHex || "") || !/^[0-9a-f]{8}$/i.test(nonceHex || "")) return reject(20, "bad ntime/nonce");

  const t = job.template;
  const ntime = parseInt(ntimeHex, 16);
  if (ntime < t.mintime || ntime > Math.floor(Date.now() / 1000) + 7200) return reject(20, "ntime out of range");

  // BIP310 version rolling. Miners disagree on what they submit when the template already has bits
  // inside the mask: BIP310/cgminer send the rolled bits themselves, ESP-Miner (Bitaxe) sends the
  // bits it changed. Both give the same version when no template bit is in the mask (the normal
  // case); otherwise the share is checked against both readings.
  let versions = [t.version];
  if (versionBitsHex !== undefined) {
    if (!/^[0-9a-f]{1,8}$/i.test(versionBitsHex)) return reject(20, "bad version bits");
    const bits = parseInt(versionBitsHex, 16);
    if ((bits & ~c.versionMask) !== 0) return reject(20, "version bits outside mask");
    const xor = (t.version ^ bits) >>> 0;
    const or = ((t.version & ~c.versionMask) | bits) >>> 0;
    versions = xor === or ? [xor] : [xor, or];
  }
  let version = versions[0];

  const key = `${jobId}:${c.extranonce1}:${en2Hex}:${ntimeHex}:${nonceHex}:${versionBitsHex || ""}`.toLowerCase();
  if (c.seen.has(key)) return reject(22, "duplicate share");
  c.seen.add(key);
  if (c.seen.size > 5000) c.seen = new Set([...c.seen].slice(-2500));

  const coinbase = Buffer.concat([job.coinb1, Buffer.from(c.extranonce1, "hex"), Buffer.from(en2Hex, "hex"), job.coinb2]);
  let root = sha256d(coinbase);
  for (const b of job.branches) root = sha256d(Buffer.concat([root, b]));
  const makeHeader = (v) =>
    Buffer.concat([u32le(v), reverse(Buffer.from(t.previousblockhash, "hex")), root, u32le(ntime), reverse(Buffer.from(t.bits, "hex")), u32le(parseInt(nonceHex, 16))]);
  const diff = c.jobDiff.get(job.id) ?? c.difficulty;
  const shareTarget = targetFromDifficulty(diff);
  let header = makeHeader(version);
  let hash = sha256d(header);
  let value = hashToBigInt(hash);
  if (value > shareTarget && versions.length > 1) {
    version = versions[1];
    header = makeHeader(version);
    hash = sha256d(header);
    value = hashToBigInt(hash);
  }
  if (value > shareTarget) return reject(23, "low difficulty share");

  c.accepted++;
  c.windowShares++;
  c.recent.push([Date.now(), diff]);
  recordShare(c.worker, diff, !!job.solo);
  send(c.socket, { id: msg.id, result: true, error: null });

  if (value <= job.target) {
    const blockHash = reverse(hash).toString("hex");
    console.log(`BLOCK FOUND at height ${t.height} by ${c.worker}: ${blockHash}`);
    // full block: header, tx count, coinbase in witness form (marker, flag, 32-byte reserved value), template txs
    const witnessCoinbase = witnessActive(t)
      ? Buffer.concat([coinbase.subarray(0, 4), Buffer.from([0, 1]), coinbase.subarray(4, coinbase.length - 4), Buffer.from([1, 32]), Buffer.alloc(32), coinbase.subarray(coinbase.length - 4)])
      : coinbase;
    const block = Buffer.concat([header, varint(1 + job.txs.length), witnessCoinbase, ...job.txs.map((tx) => Buffer.from(tx.data, "hex"))]);
    try {
      const result = await rpc("submitblock", [block.toString("hex")]);
      if (result === null || result === "duplicate") {
        console.log("REAL BLOCK ACCEPTED!", t.height, blockHash);
        refreshNetwork();
        const rewardSat = t.coinbasevalue / 100000000;
        recordBlock(c.worker, t.height, rewardSat, blockHash, !!job.solo);
        // a solo block already paid its finder in the coinbase; pool blocks are split by work
        if (!job.solo) creditPayouts(rewardSat, t.height, blockHash);
        await refreshTemplate(true);
      } else {
        console.error("submitblock rejected block", t.height, ":", result);
      }
    } catch (e) {
      console.error("submitblock failed:", e.message);
    }
  }
  retarget(c);
}

// solo logins check the address with the node; cache the answer so reconnect storms don't hit RPC
const addressScripts = new Map();
async function scriptFor(address) {
  if (addressScripts.has(address)) return addressScripts.get(address);
  const v = await rpc("validateaddress", [address]);
  if (!v.isvalid) throw new Error("invalid address");
  addressScripts.set(address, v.scriptPubKey);
  if (addressScripts.size > 50_000) addressScripts.delete(addressScripts.keys().next().value);
  return v.scriptPubKey;
}

const ADDRESS_RE = new RegExp(`^${ADDRESS_PREFIX}1[02-9ac-hj-np-z]{8,87}$`);
let refusedLogged = 0;

const server = net.createServer((socket) => acceptMiner(socket, (socket.remoteAddress || "").replace(/^::ffff:/, "")));

/*
 * What kind of device a connection is, for the pool page ("Bitaxe Gamma", "Saturn app", "iPhone browser").
 * Miners name their software in mining.subscribe (Bitaxe sends "bitaxe/BM1370/v2.4.1", the Saturn app
 * "SaturnMiner/0.8.5"); a browser miner is described from its User-Agent header instead.
 */
const BITAXE_CHIPS = { BM1397: "Max", BM1366: "Ultra", BM1368: "Supra", BM1370: "Gamma" };
function browserDevice(ua) {
  ua = String(ua || "");
  const where = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua)) ? "iPad"
    : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet") : /CrOS/.test(ua) ? "Chromebook"
    : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows PC" : /Linux/.test(ua) ? "Linux PC" : "";
  const app = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return where ? `${where}${app ? ` · ${app}` : ""}` : app ? `${app} browser` : "Web browser";
}
function deviceName(c) {
  if (c.browser) return browserDevice(c.userAgent);
  const a = String(c.agent || "");
  let m;
  if ((m = a.match(/^SaturnMiner\/([\w.-]+)(?:\s*\(([^)]*)\))?/i))) return `Saturn app${m[2] ? ` · ${m[2]}` : ""}`;
  if (/bitaxe|esp-?miner/i.test(a)) {
    const chip = (a.match(/BM\d{4}/i) || [""])[0].toUpperCase();
    return BITAXE_CHIPS[chip] ? `Bitaxe ${BITAXE_CHIPS[chip]}` : chip ? `Bitaxe (${chip})` : "Bitaxe";
  }
  if (/nerd\s*q?axe/i.test(a)) return /qaxe/i.test(a) ? "NerdQaxe" : "NerdAxe";
  if (/nerd\s*miner/i.test(a)) return "NerdMiner";
  if (/bmminer|antminer|cgminer.*bitmain/i.test(a)) return "Antminer";
  if (/braiins|bosminer/i.test(a)) return "Braiins OS miner";
  if (/whatsminer|btminer/i.test(a)) return "Whatsminer";
  if (/avalon/i.test(a)) return "Avalon";
  if (/^cgminer/i.test(a)) return "cgminer";
  if (/^bfgminer/i.test(a)) return "BFGMiner";
  if (/cpuminer|minerd/i.test(a)) return "cpuminer";
  if (/nicehash/i.test(a)) return "NiceHash";
  return a ? a.replace(/[^\w ./()+-]/g, "").slice(0, 32) : "Miner";
}

// one stratum connection: a TCP socket from a miner, or a browser's WebSocket (see WsSocket)
function acceptMiner(socket, ip, browser = false, userAgent = "") {
  const banned = bans.get(ip);
  if (banned && banned > Date.now()) return socket.destroy();
  if (banned) bans.delete(ip);
  const open = perIp.get(ip) || 0;
  if (clients.size >= MAX_CONNECTIONS || open >= MAX_PER_IP) {
    if (refusedLogged++ % 100 === 0) console.log(`refused connection from ${ip}: ${open >= MAX_PER_IP ? `${open} already open from that address` : "pool is full"}`);
    return socket.destroy();
  }
  perIp.set(ip, open + 1);

  const c = {
    socket,
    ip,
    extranonce1: (nextExtranonce1++ >>> 0).toString(16).padStart(8, "0").slice(-8),
    browser,
    userAgent: String(userAgent || "").slice(0, 300),
    agent: "",
    minDiff: browser ? BROWSER_MIN_DIFF : MIN_DIFF,
    difficulty: browser ? BROWSER_START_DIFF : START_DIFF,
    versionMask: 0,
    authorized: false,
    worker: null,
    accepted: 0,
    rejected: 0,
    junk: 0,
    windowStart: Date.now(),
    windowShares: 0,
    jobDiff: new Map(),
    recent: [], // [time, difficulty] of accepted shares, for the live hashrate
    since: Date.now(),
    seen: new Set(),
    buffer: "",
    busy: Promise.resolve(),
  };
  clients.add(c);
  if (clients.size <= 200 || clients.size % 100 === 0) console.log("miner connected", ip, "miners:", clients.size);
  socket.setEncoding("utf8");
  socket.setKeepAlive(true, 60_000);
  socket.setNoDelay(true);
  // log in within 30 s, then say something at least every 15 minutes
  const loginTimer = setTimeout(() => !c.authorized && socket.destroy(), LOGIN_TIMEOUT_MS);
  socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());

  socket.on("data", (data) => {
    c.buffer += data;
    if (c.buffer.length > MAX_LINE) {
      junk(c, 25);
      return socket.destroy();
    }
    const lines = c.buffer.split("\n");
    c.buffer = lines.pop();
    // handle lines strictly in order, one at a time (submits await the node)
    for (const line of lines) c.busy = c.busy.then(() => handleLine(c, line));
  });

  socket.on("close", () => {
    clearTimeout(loginTimer);
    clients.delete(c);
    const n = (perIp.get(ip) || 1) - 1;
    if (n > 0) perIp.set(ip, n);
    else perIp.delete(ip);
    if (c.authorized || clients.size < 200) console.log(`miner disconnected (${c.worker || "unauthorized"}: ${c.accepted} accepted, ${c.rejected} rejected), miners: ${clients.size}`);
  });
  socket.on("error", () => {});
}

/* ------------------------------------------------------------------ */
/* browser mining: stratum over WebSocket                              */
/* ------------------------------------------------------------------ */

// Browsers can't open a raw TCP connection to port 3333, so the Mine tab speaks the same stratum
// messages over a WebSocket at /ws (through nginx on the HTTPS site). Each WebSocket text message is
// one stratum line. This is a small, strict RFC 6455 server: text, ping/pong and close frames only,
// client frames must be masked, and no message may exceed MAX_LINE.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const { EventEmitter } = require("events");
class WsSocket extends EventEmitter {
  constructor(raw, ip) {
    super();
    this.raw = raw;
    this.remoteAddress = ip;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    raw.on("data", (d) => this.onData(d));
    raw.on("close", () => { clearInterval(this.pinger); this.emit("close"); });
    raw.on("error", (e) => this.emit("error", e));
    // nginx drops quiet connections; a ping every 25 s keeps phones connected between shares
    this.pinger = setInterval(() => this.frame(0x9, Buffer.alloc(0)), 25_000);
  }
  get destroyed() { return this.raw.destroyed; }
  get writable() { return this.raw.writable; }
  setEncoding() {}
  setKeepAlive(...a) { this.raw.setKeepAlive(...a); }
  setNoDelay(...a) { this.raw.setNoDelay(...a); }
  setTimeout(ms, cb) { this.raw.setTimeout(ms, cb); }
  destroy() { clearInterval(this.pinger); this.raw.destroy(); }
  frame(op, payload) {
    if (this.raw.destroyed || !this.raw.writable) return;
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
    this.raw.write(Buffer.concat([head, payload]));
  }
  // stratum code writes newline-terminated JSON; each line becomes one text message
  write(text) {
    for (const line of String(text).split("\n")) if (line) this.frame(0x1, Buffer.from(line, "utf8"));
    return true;
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (!masked) return this.destroy(); // browsers always mask; anything else isn't a browser
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) return this.destroy(); // no stratum message is anywhere near 64 KB
      if (len > MAX_LINE) return this.destroy();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op === 0x8) { this.frame(0x8, Buffer.alloc(0)); return this.destroy(); }
      if (op === 0x9) { this.frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op !== 0x0 && op !== 0x1) return this.destroy(); // binary isn't stratum
      this.parts.push(payload);
      if (this.parts.reduce((a, p) => a + p.length, 0) > MAX_LINE) return this.destroy();
      if (fin) {
        const text = Buffer.concat(this.parts).toString("utf8");
        this.parts = [];
        this.emit("data", text.replace(/\n/g, " ") + "\n");
      }
    }
  }
}

function handleUpgrade(req, raw) {
  const ip = clientIp(req);
  const origin = String(req.headers.origin || "");
  const key = req.headers["sec-websocket-key"];
  const urlPath = (req.url || "").split("?")[0];
  const allowed = WS_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (urlPath !== "/ws" || String(req.headers.upgrade || "").toLowerCase() !== "websocket" || !key || !allowed) {
    raw.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  raw.setNoDelay(true);
  acceptMiner(new WsSocket(raw, ip), ip, true, req.headers["user-agent"]);
}

async function handleLine(c, line) {
  const socket = c.socket;
  if (socket.destroyed || !line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
    if (!msg || typeof msg !== "object") throw new Error("not an object");
  } catch {
    return junk(c, 2);
  }
  if (!c.authorized && (c.logged = (c.logged || 0) + 1) <= 6 && clients.size < 500) {
    console.log(`from ${c.ip}: ${msg.method || "response"} ${JSON.stringify(msg.params ?? msg.result ?? "").slice(0, 160)}`);
  }
  try {
    switch (msg.method) {
      case "mining.configure": {
        // BIP310 version rolling (Bitaxe asks for it)
        const [exts = [], opts = {}] = Array.isArray(msg.params) ? msg.params : [];
        const result = {};
        if (Array.isArray(exts) && exts.includes("version-rolling")) {
          const requested = parseInt(opts?.["version-rolling.mask"] || "ffffffff", 16);
          c.versionMask = (requested & VERSION_ROLLING_MASK) >>> 0;
          result["version-rolling"] = true;
          result["version-rolling.mask"] = c.versionMask.toString(16).padStart(8, "0");
        }
        send(socket, { id: msg.id, result, error: null });
        break;
      }
      case "mining.subscribe":
        c.agent = String((Array.isArray(msg.params) && msg.params[0]) || "").slice(0, 80);
        send(socket, {
          id: msg.id,
          result: [[["mining.set_difficulty", c.extranonce1], ["mining.notify", c.extranonce1]], c.extranonce1, EXTRANONCE2_SIZE],
          error: null,
        });
        setDifficulty(c, c.difficulty);
        break;
      case "mining.suggest_difficulty": {
        const d = Number(msg.params?.[0]);
        if (d > 0) setDifficulty(c, d);
        if (msg.id != null) send(socket, { id: msg.id, result: true, error: null });
        break;
      }
      case "mining.extranonce.subscribe":
        send(socket, { id: msg.id, result: true, error: null });
        break;
      case "mining.authorize": {
        // phones auto-capitalise ("Sat1q…") and add stray spaces; addresses are case-insensitive,
        // so normalise to the canonical lowercase form instead of refusing the miner
        const raw = String(msg.params?.[0] || "").trim().slice(0, 200);
        const dot = raw.indexOf(".");
        const address = (dot < 0 ? raw : raw.slice(0, dot)).toLowerCase();
        const workerName = (dot < 0 ? "" : raw.slice(dot + 1).trim()).replace(/[^\w.-]/g, "").slice(0, 40);
        const worker = workerName ? `${address}.${workerName}` : address;
        if (!ADDRESS_RE.test(address)) {
          junk(c, 5);
          if (clients.size < 500) console.log(`login refused from ${c.ip}: username ${JSON.stringify(raw.slice(0, 80))} is not a ${ADDRESS_PREFIX}1 address`);
          send(socket, { id: msg.id, result: false, error: [24, `username must be your ${ADDRESS_PREFIX}1… address (optionally .workername)`, null] });
          break;
        }
        // password "solo" (or "m=solo"): the miner's blocks pay its own address in full
        const password = String(msg.params?.[1] || "").slice(0, 200);
        if (/(^|[\s,;])(m=)?solo($|[\s,;])/i.test(password)) {
          try {
            c.soloScript = await scriptFor(address);
          } catch (e) {
            send(socket, { id: msg.id, result: false, error: [24, `solo mining needs a valid address: ${e.message}`, null] });
            break;
          }
        }
        c.worker = worker;
        c.authorized = true;
        c.device = deviceName(c);
        if (db.workers[worker] && db.workers[worker].device !== c.device) { db.workers[worker].device = c.device; save("workers"); }
        send(socket, { id: msg.id, result: true, error: null });
        if (clients.size < 500) console.log(`authorized ${c.soloScript ? "SOLO " : ""}miner:`, worker, `(${c.device})`, "extranonce1", c.extranonce1);
        sendJob(c);
        break;
      }
      case "mining.submit":
        await handleSubmit(c, msg);
        break;
      default:
        if (msg.id != null && msg.method) {
          junk(c);
          send(socket, { id: msg.id, result: null, error: [20, "unsupported method", null] });
        }
    }
  } catch (e) {
    console.error("stratum handler error:", e.message);
    if (msg.id != null) send(socket, { id: msg.id, result: false, error: [20, "internal error", null] });
  }
}

/* ------------------------------------------------------------------ */
/* network stats and live hashrate                                     */
/* ------------------------------------------------------------------ */

// hashes per second implied by the shares a miner sent in the last 10 minutes (each diff-1 share
// stands for 2^32 hashes)
const HASH_WINDOW_MS = 10 * 60_000;
function liveHashrate(c) {
  const now = Date.now();
  while (c.recent.length && c.recent[0][0] < now - HASH_WINDOW_MS) c.recent.shift();
  const span = Math.min(HASH_WINDOW_MS, now - c.since) / 1000;
  if (span < 20) return 0;
  return (c.recent.reduce((a, [, d]) => a + d, 0) * 2 ** 32) / span;
}

let network = { hashrate: null, difficulty: null, blocks: null, updated: 0 };
async function refreshNetwork() {
  try {
    const info = await rpc("getmininginfo");
    // getmininginfo averages over 120 blocks, which still includes the very first easy blocks;
    // the last 20 blocks are a truer picture of the network now
    const recent = await rpc("getnetworkhashps", [20]).catch(() => null);
    network = { hashrate: recent ?? info.networkhashps ?? null, difficulty: info.difficulty ?? null, blocks: info.blocks ?? null, updated: Date.now() };
  } catch (e) {
    console.error("getmininginfo failed:", e.message);
  }
}
setInterval(refreshNetwork, 15_000);
refreshNetwork();

/* ------------------------------------------------------------------ */
/* website and API                                                     */
/* ------------------------------------------------------------------ */

const WEB_ROOT = config.webRoot || path.join(__dirname, "public");

// scantxoutset runs one scan at a time, so requests queue behind each other; results are cached
// for a few seconds per address set, and the queue has a ceiling
let scanChain = Promise.resolve();
let scansWaiting = 0;
const scanCache = new Map();
function scanUtxos(addrs) {
  const key = [...addrs].sort().join(",");
  const hit = scanCache.get(key);
  if (hit && Date.now() - hit.at < 8000) return Promise.resolve(hit.value);
  if (scansWaiting >= 20) return Promise.reject(Object.assign(new Error("busy, try again in a few seconds"), { status: 503 }));
  scansWaiting++;
  const run = scanChain.then(async () => {
    scansWaiting--;
    const r = await rpc("scantxoutset", ["start", addrs.map((a) => `addr(${a})`)]);
    const tip = r.height;
    const utxos = (r.unspents || []).map((u) => {
      const confirmations = tip - u.height + 1;
      return {
        txid: u.txid,
        vout: u.vout,
        amount: u.amount,
        sats: Math.round(u.amount * 1e8),
        scriptPubKey: u.scriptPubKey,
        address: (u.desc.match(/addr\(([^)]+)\)/) || [])[1] || null,
        height: u.height,
        confirmations,
        coinbase: !!u.coinbase,
        // newly mined coins can't be spent for 100 blocks
        spendable: !u.coinbase || confirmations >= 100,
      };
    });
    const value = { height: tip, utxos };
    scanCache.set(key, { at: Date.now(), value });
    if (scanCache.size > 500) scanCache.delete(scanCache.keys().next().value);
    return value;
  });
  scanChain = run.catch(() => {});
  return run;
}

// Per-IP rate limits (requests per minute). Behind nginx every request comes from 127.0.0.1, so the
// client's address is taken from X-Real-IP, but only when the request really came from this machine.
const LIMITS = { utxos: 20, broadcast: 6, stats: 120, other: 240 };
const hits = new Map(); // `${ip}|${kind}` -> [windowStart, count]
setInterval(() => {
  const old = Date.now() - 60_000;
  for (const [k, [t]] of hits) if (t < old) hits.delete(k);
}, 60_000);
function clientIp(req) {
  const direct = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  if ((direct === "127.0.0.1" || direct === "::1") && req.headers["x-real-ip"]) return String(req.headers["x-real-ip"]).slice(0, 64);
  return direct;
}
function limited(req, kind) {
  const key = `${clientIp(req)}|${kind}`;
  const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h[0] >= 60_000) {
    hits.set(key, [now, 1]);
    return false;
  }
  h[1]++;
  return h[1] > LIMITS[kind];
}

// /stats is built at most every 3 seconds, however many people are looking
let statsCache = { at: 0, body: "" };
function statsBody() {
  if (Date.now() - statsCache.at < 3000) return statsCache.body;
  const p = payoutState();
  const live = [...clients].filter((c) => c.authorized);
  const pausedNow = db.guard.paused && !(p.resumedAt && p.resumedAt > db.guard.paused.since) ? db.guard.paused : null;
  const body = JSON.stringify({
    totalShares: db.stats.totalShares || 0,
    miners: db.stats.miners || {},
    workers: db.workers,
    blocks: db.blocks,
    connected: live.map((c) => ({ worker: c.worker, device: c.device || deviceName(c), solo: !!c.soloScript, browser: !!c.browser, difficulty: c.difficulty, accepted: c.accepted, rejected: c.rejected, hashrate: liveHashrate(c), since: new Date(c.since).toISOString() })),
    hashrate: live.reduce((a, c) => a + liveHashrate(c), 0),
    height: template?.height ?? null,
    // difficulty of the block being mined now (getmininginfo reports the tip's)
    network: { ...network, nextDifficulty: blockDifficulty() },
    reward: template ? template.coinbasevalue / 1e8 : null,
    pending: pendingNow(p),
    rounds: db.rounds.slice(-25).map((r) => ({ height: r.height, status: p.settled[roundId(r)] || "immature", reward: r.reward, scheme: r.scheme || "round" })),
    paid: p.paid.slice(0, 10),
    payoutScheme: { name: "PPLNS", windowBlocks: PPLNS_FACTOR, windowWork: pplnsWork },
    guard: { paused: pausedNow, lastReorg: (db.guard.reorgs || [])[0] || null },
    stratum: `stratum+tcp://${config.poolHost || "pool.saturn.boats"}:${config.stratumPort}`,
  });
  statsCache = { at: Date.now(), body };
  return body;
}

/*
 * Coin / logo design submissions from saturn.boats ("Design the Saturn coin"). The page shrinks and
 * re-encodes the picture in the browser, so what arrives is a plain PNG/JPEG/WebP under 500 KB; it's
 * checked again here by its first bytes (never trusted by its name or type), saved privately in
 * <dataDir>/designs with a line in designs/index.json, and never served back to anyone. Limits: a
 * few per person per hour, and a cap on how many and how much in total.
 */
const DESIGNS = dataFile("designs");
const DESIGN_MAX_BYTES = 500_000;
const DESIGN_MAX_FILES = Number(config.designMaxFiles ?? 500);
const DESIGN_MAX_TOTAL = Number(config.designMaxTotalBytes ?? 200_000_000);
const DESIGN_PER_HOUR = 4;
const designHits = new Map(); // ip -> [times]
const designOrigin = (req) => {
  const o = String(req.headers.origin || "");
  return WS_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o) ? o : "";
};
function imageKind(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}
const cleanText = (v, max) => {
  let t = "";
  try {
    t = decodeURIComponent(String(v || ""));
  } catch {
    t = String(v || "");
  }
  return t.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
};
function handleDesign(req, res) {
  const origin = designOrigin(req);
  res.setHeader("Content-Type", "application/json");
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Design-Name, X-Design-Contact, X-Design-Note");
    res.setHeader("Access-Control-Max-Age", "600");
    res.statusCode = origin ? 204 : 403;
    return res.end();
  }
  const fail = (code, error) => {
    res.statusCode = code;
    res.end(JSON.stringify({ error }));
  };
  if (req.method !== "POST") return fail(405, "POST a picture");
  if (!origin) return fail(403, "submit from saturn.boats");
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (designHits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= DESIGN_PER_HOUR) return fail(429, "That's a few already this hour, thanks! Try again later.");
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on("data", (d) => {
    size += d.length;
    if (size > DESIGN_MAX_BYTES) {
      tooBig = true;
      req.destroy();
    } else chunks.push(d);
  });
  req.on("end", () => {
    if (tooBig) return;
    const buf = Buffer.concat(chunks);
    const kind = imageKind(buf);
    if (!kind) return fail(415, "send a PNG, JPEG or WebP picture");
    try {
      fs.mkdirSync(DESIGNS, { recursive: true, mode: 0o750 });
      const indexFile = path.join(DESIGNS, "index.json");
      const index = readJson(indexFile, []);
      const total = index.reduce((t, e) => t + (e.bytes || 0), 0);
      if (index.length >= DESIGN_MAX_FILES || total + buf.length > DESIGN_MAX_TOTAL) return fail(507, "Submissions are full right now, thanks for trying!");
      const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
      const file = `${stamp}-${crypto.randomBytes(3).toString("hex")}.${kind}`;
      fs.writeFileSync(path.join(DESIGNS, file), buf, { mode: 0o640 });
      index.push({
        file,
        time: new Date(now).toISOString(),
        bytes: buf.length,
        name: cleanText(req.headers["x-design-name"], 60),
        contact: cleanText(req.headers["x-design-contact"], 120),
        note: cleanText(req.headers["x-design-note"], 500),
        from: crypto.createHash("sha256").update(ip + "saturn-designs").digest("hex").slice(0, 12),
      });
      fs.writeFileSync(indexFile + ".tmp", JSON.stringify(index, null, 1));
      fs.renameSync(indexFile + ".tmp", indexFile);
      recent.push(now);
      designHits.set(ip, recent);
      console.log(`design submitted: ${file} (${buf.length} bytes)`);
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.log("design save failed:", e.message);
      fail(500, "couldn't save it, try again later");
    }
  });
}
setInterval(() => {
  const old = Date.now() - 3600_000;
  for (const [ip, ts] of designHits) if (!ts.some((t) => t > old)) designHits.delete(ip);
}, 600_000);

/*
 * The pool operator's private gallery of submissions: /designs/review?key=<key>. The key is made once
 * and kept in <dataDir>/designs/review-key (readable only on the server); without it the gallery
 * and the pictures answer 404, like they aren't there.
 */
function designKey() {
  const f = path.join(DESIGNS, "review-key");
  try {
    return fs.readFileSync(f, "utf8").trim();
  } catch {
    fs.mkdirSync(DESIGNS, { recursive: true, mode: 0o750 });
    const k = crypto.randomBytes(18).toString("base64url");
    fs.writeFileSync(f, k + "\n", { mode: 0o600 });
    console.log(`design review key created in ${f}`);
    return k;
  }
}
const REVIEW_KEY = designKey();
function reviewAllowed(req) {
  const k = new URL(req.url, "http://x").searchParams.get("key") || "";
  const a = Buffer.from(k);
  const b = Buffer.from(REVIEW_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function handleReview(req, res, parts) {
  const notFound = () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  };
  if (limited(req, "other") || req.method !== "GET" || !reviewAllowed(req)) return notFound();
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Robots-Tag", "noindex");
  const index = readJson(path.join(DESIGNS, "index.json"), []);
  if (parts[1] === "file" && parts[2]) {
    const e = index.find((x) => x.file === parts[2]);
    if (!e || !/^[\w.-]+\.(png|jpg|webp)$/.test(e.file)) return notFound();
    res.setHeader("Content-Type", { png: "image/png", jpg: "image/jpeg", webp: "image/webp" }[e.file.split(".").pop()]);
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    return res.end(fs.readFileSync(path.join(DESIGNS, e.file)));
  }
  const key = encodeURIComponent(REVIEW_KEY);
  const cards = index
    .slice()
    .reverse()
    .map(
      (e) => `<figure><a href="/designs/file/${escHtml(e.file)}?key=${key}" target="_blank" rel="noreferrer"><img src="/designs/file/${escHtml(e.file)}?key=${key}" alt="" loading="lazy"></a>
<figcaption><b>${escHtml(e.name || "anonymous")}</b>${e.contact ? ` · ${escHtml(e.contact)}` : ""}<span>${escHtml(new Date(e.time).toLocaleString("en-US", { timeZone: "America/Chicago" }))}</span>${e.note ? `<p>${escHtml(e.note)}</p>` : ""}</figcaption></figure>`,
    )
    .join("");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saturn coin submissions</title>
<style>body{margin:0;background:#07090d;color:#e8e6df;font:15px/1.45 system-ui,sans-serif;padding:24px}h1{font-weight:600;font-size:22px;margin:0 0 4px}.sub{color:#8a8f99;margin:0 0 22px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}figure{margin:0;background:#11141b;border:1px solid #232733;border-radius:12px;overflow:hidden}
img{display:block;width:100%;aspect-ratio:1;object-fit:contain;background:repeating-conic-gradient(#171a22 0 25%,#12151c 0 50%) 0 0/20px 20px}figcaption{padding:10px 12px;font-size:13px;color:#b9bcc4}figcaption b{color:#fff}figcaption span{display:block;color:#6f7480;font-size:12px}figcaption p{margin:6px 0 0;color:#d6d3cb}</style></head>
<body><h1>Saturn coin submissions</h1><p class="sub">${index.length} so far, newest first. Click one to open it full size. Keep this link private.</p><main>${cards || '<p class="sub">None yet.</p>'}</main></body></html>`);
}

function handleHttp(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  const urlPath = (req.url || "/").split("?")[0];
  // the pool website: GET / serves public/index.html when it exists
  if (req.method === "GET" && (urlPath === "/" || urlPath === "/index.html" || /^\/[\w.-]+\.(png|svg|ico|webp|jpg)$/.test(urlPath))) {
    if (limited(req, "other")) return tooMany(res);
    const file = path.join(WEB_ROOT, urlPath === "/" ? "index.html" : urlPath.slice(1));
    if (file.startsWith(WEB_ROOT + path.sep) && fs.existsSync(file)) {
      const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".jpg": "image/jpeg" };
      res.setHeader("Content-Type", types[path.extname(file)] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache");
      return res.end(fs.readFileSync(file));
    }
  }
  if (urlPath === "/designs") return handleDesign(req, res);
  if (urlPath.startsWith("/designs/")) return handleReview(req, res, urlPath.split("/").filter(Boolean));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const parts = urlPath.split("/").filter(Boolean);

  if (urlPath === "/stats") {
    if (limited(req, "stats")) return tooMany(res);
    return res.end(statsBody());
  }
  // Light-wallet API for the Saturn app: unspent coins for a set of addresses, and broadcasting a
  // signed transaction. Read-only plus relay, like a block explorer.
  if (urlPath === "/utxos" && req.method === "GET") {
    if (limited(req, "utxos")) return tooMany(res);
    const addrs = (new URL(req.url, "http://x").searchParams.get("addrs") || "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => /^(sat1|bcrt1)[02-9ac-hj-np-z]{8,87}$/.test(a)) // bcrt1: regtest, for testing
      .slice(0, 100);
    if (!addrs.length) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "pass ?addrs=sat1…,sat1…" }));
    }
    scanUtxos(addrs)
      .then((r) => res.end(JSON.stringify(r)))
      .catch((e) => {
        res.statusCode = e.status || 502;
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }
  if (urlPath === "/broadcast" && req.method === "POST") {
    if (limited(req, "broadcast")) return tooMany(res);
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 400_000) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { hex } = JSON.parse(body || "{}");
        if (!/^[0-9a-f]+$/i.test(hex || "")) throw new Error('send {"hex": "<signed transaction>"}');
        const txid = await rpc("sendrawtransaction", [hex]);
        console.log("broadcast", txid);
        res.end(JSON.stringify({ txid }));
      } catch (e) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (limited(req, "other")) return tooMany(res);
  if (urlPath === "/history") return res.end(JSON.stringify(db.history));
  if (parts[0] === "stats" && parts[1]) {
    const address = parts[1].toLowerCase();
    const mine = Object.entries(db.stats.miners || {}).filter(([w]) => w.split(".")[0] === address);
    return res.end(
      JSON.stringify({
        address,
        shares: mine.reduce((a, [, m]) => a + (m.shares || 0), 0),
        blocksFound: db.blocks.filter((b) => String(b.miner).split(".")[0] === address).length,
        pendingPayout: pendingNow()[address] || 0,
        lastShare: mine.map(([, m]) => m.lastShare).sort().pop() || null,
      }),
    );
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
}
function tooMany(res) {
  res.statusCode = 429;
  res.setHeader("Retry-After", "30");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "too many requests, slow down" }));
}

const LISTEN_HOST = config.listenHost || "0.0.0.0";
const statsServer = http.createServer(handleHttp);
statsServer.requestTimeout = 30_000;
statsServer.headersTimeout = 15_000;
statsServer.on("upgrade", handleUpgrade);
// optional second port for the website (e.g. 80), same pages and API
if (config.sitePort) {
  const site = http.createServer(handleHttp);
  site.requestTimeout = 30_000;
  site.on("upgrade", handleUpgrade);
  site.listen(config.sitePort, LISTEN_HOST, () => console.log(`Saturn pool website listening on ${config.sitePort}`)).on("error", (e) => console.error(`website port ${config.sitePort}:`, e.message));
}

// pool hashrate once a minute for the last 24 hours, for the chart on the website
setInterval(() => {
  const h = [...clients].filter((c) => c.authorized).reduce((a, c) => a + liveHashrate(c), 0);
  db.history.push([Date.now(), Math.round(h)]);
  db.history = db.history.filter(([t]) => t > Date.now() - 86_400_000);
  save("history");
}, 60_000);

// The address blocks pay must belong to the wallet payout.js pays from, or rewards are lost. The
// pool's RPC user may not be allowed wallet calls (it shouldn't need them), so this is best-effort.
async function checkPayoutAddress() {
  const wallet = config.payoutWallet || "vps-wallet";
  if (!config.payoutAddress) {
    console.error(`WARNING: config.payoutAddress is not set. Set it (and payoutScript) to an address from the "${wallet}" wallet, or block rewards may go to an address nobody can spend.`);
    return;
  }
  try {
    const v = await rpc("validateaddress", [config.payoutAddress]);
    if (v.scriptPubKey !== payoutScript) console.error(`WARNING: config.payoutScript doesn't match config.payoutAddress (${v.scriptPubKey}).`);
    const info = await rpc("getaddressinfo", [config.payoutAddress], wallet);
    if (!info.ismine) console.error(`WARNING: the pool pays ${config.payoutAddress}, which is NOT in the "${wallet}" wallet. Block rewards there cannot be paid out.`);
    else console.log(`block rewards go to ${config.payoutAddress} in the "${wallet}" wallet`);
  } catch (e) {
    console.log(`block rewards go to ${config.payoutAddress} (payout.js checks it belongs to the "${wallet}" wallet)`);
  }
}
checkPayoutAddress();

setInterval(refreshTemplate, 5000);
// miners whose difficulty is too high may never submit; ease them down even without shares
setInterval(() => {
  for (const c of clients) if (c.authorized && (Date.now() - c.windowStart) / 1000 >= RETARGET_SECONDS * 2) retarget(c);
}, 15_000);
refreshTemplate(true);

statsServer.listen(config.statsPort || 8081, LISTEN_HOST, () => console.log(`Saturn pool stats API listening on ${config.statsPort || 8081}`));
server.listen(config.stratumPort, "0.0.0.0", () => console.log(`Saturn stratum listening on ${config.stratumPort}`));
