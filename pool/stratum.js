// Saturn pool: stratum v1 server.
//
// Miners get unique extranonce1 values, per-connection variable difficulty and BIP310 version rolling
// (Bitaxe/ESP-Miner uses it). Every share is checked against its share target; shares that also meet
// the network target are assembled into a full block (with the template's transactions, BIP34 height
// and the segwit witness commitment) and submitted to Saturn Core. New work is pushed to all miners
// when the chain tip changes.
//
// Kept from the previous version: config.json, the pool payout script, data/*.json files and the
// stats API on :8081, so server.js and payout.js keep working unchanged.

const net = require("net");
const http = require("http");
const fs = require("fs");
const fetch = require("node-fetch");
const crypto = require("crypto");

const config = JSON.parse(fs.readFileSync("./config.json"));

// Everything a block pays goes to the pool wallet; payout.js forwards miners' shares from there.
const payoutScript = config.payoutScript || "00148b0ba8d3e679a540d3869aeb9dd7c7ca369234cc";
const POOL_TAG = Buffer.from(config.poolTag || "/Saturn Pool/");
const EXTRANONCE2_SIZE = 4;

// share difficulty: start, bounds, and how often a miner should find a share
const START_DIFF = config.startDifficulty || 256;
const MIN_DIFF = config.minDifficulty || 1;
const MAX_DIFF = config.maxDifficulty || 2 ** 32;
const TARGET_SHARE_SECONDS = config.targetShareSeconds || 10;
const RETARGET_SECONDS = 60;

const VERSION_ROLLING_MASK = 0x1fffe000;
const DIFF1_TARGET = 0xffffn << 208n;

let miners = 0;
let template = null; // latest getblocktemplate result
let nextJobId = 1;
let nextExtranonce1 = crypto.randomBytes(2).readUInt16BE() << 8; // random start so restarts don't reuse values
const jobs = new Map(); // jobId -> job
const clients = new Set();

/* ------------------------------------------------------------------ */
/* data files (same format as before)                                  */
/* ------------------------------------------------------------------ */

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return fallback;
  }
}

function recordBlock(worker, height, reward, hash) {
  const file = "./data/blocks.json";
  const blocks = readJson(file, []);
  blocks.unshift({ height, miner: worker, reward, hash, time: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(blocks.slice(0, 25), null, 2));
}

// split the block reward over everyone's work since the last block, by share difficulty
function creditPayouts(rewardSat) {
  const statsFile = "./data/stats.json";
  const payoutsFile = "./data/payouts.json";
  const stats = readJson(statsFile, { totalShares: 0, miners: {} });
  const payouts = readJson(payoutsFile, { pending: {}, paid: [] });
  payouts.pending = payouts.pending || {};
  const totalShares = stats.totalShares || 0;
  if (!totalShares || !stats.miners) {
    console.log("payout skipped: no shares recorded");
    return;
  }
  for (const worker of Object.keys(stats.miners)) {
    const shares = stats.miners[worker].shares || 0;
    if (!shares) continue;
    const reward = (shares / totalShares) * rewardSat;
    const payoutAddress = worker.split(".")[0];
    payouts.pending[payoutAddress] = (payouts.pending[payoutAddress] || 0) + reward;
  }
  payouts.lastCredit = { rewardSat, totalShares, time: new Date().toISOString() };
  fs.writeFileSync(payoutsFile, JSON.stringify(payouts, null, 2));
  fs.writeFileSync(statsFile, JSON.stringify({ totalShares: 0, miners: {} }, null, 2));
  console.log("payouts credited:", payouts.lastCredit);
}

// shares are weighted by their difficulty, so a Bitaxe at diff 4096 earns 4096x a diff-1 share
function recordShare(worker, difficulty) {
  const file = "./data/stats.json";
  const stats = readJson(file, { totalShares: 0, miners: {} });
  stats.totalShares = (stats.totalShares || 0) + difficulty;
  if (!stats.miners[worker]) stats.miners[worker] = { shares: 0 };
  stats.miners[worker].shares += difficulty;
  stats.miners[worker].lastShare = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(stats, null, 2));
}

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

function buildJob(t, clean) {
  const id = (nextJobId++).toString(16);
  const scriptPrefix = heightScript(t.height);
  const scriptSuffix = pushData(POOL_TAG);
  const scriptLen = scriptPrefix.length + 4 + EXTRANONCE2_SIZE + scriptSuffix.length;
  if (scriptLen > 100) throw new Error("coinbase script too long");

  const outputs = [Buffer.concat([u64le(t.coinbasevalue), varint(payoutScript.length / 2), Buffer.from(payoutScript, "hex")])];
  if (t.default_witness_commitment) {
    const c = Buffer.from(t.default_witness_commitment, "hex");
    outputs.push(Buffer.concat([u64le(0), varint(c.length), c]));
  }
  // coinb1 | extranonce1 | extranonce2 | coinb2 is the coinbase without witness (its txid form)
  const coinb1 = Buffer.concat([
    u32le(2),
    Buffer.from([1]),
    Buffer.alloc(32),
    Buffer.from("ffffffff", "hex"),
    varint(scriptLen),
    scriptPrefix,
  ]);
  const coinb2 = Buffer.concat([scriptSuffix, Buffer.from("ffffffff", "hex"), varint(outputs.length), ...outputs, u32le(0)]);
  const txs = t.transactions || [];
  const branches = merkleBranches(txs.map((tx) => reverse(Buffer.from(tx.txid, "hex"))));
  const job = {
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
  };
  jobs.set(id, job);
  // keep the last 20 jobs so in-flight shares on recent work are still accepted
  while (jobs.size > 20) jobs.delete(jobs.keys().next().value);
  return job;
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
    template = t;
    if (tipChanged || txsChanged || force || Date.now() - (currentJob?.created || 0) > 60_000) {
      if (tipChanged) console.log("new block template: height", t.height, "bits", t.bits, "txs", (t.transactions || []).length);
      currentJob = buildJob(t, tipChanged);
      if (tipChanged) jobs.forEach((j, id) => j.template.previousblockhash !== t.previousblockhash && jobs.delete(id));
      for (const c of clients) if (c.authorized) sendJob(c);
    }
  } catch (e) {
    console.error("getblocktemplate failed:", e.message);
  }
}

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

async function rpc(method, params = []) {
  const auth = Buffer.from(`${config.rpc.user}:${config.rpc.password}`).toString("base64");
  const res = await fetch(`http://${config.rpc.host}:${config.rpc.port}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "saturn-pool", method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  return json.result;
}

/* ------------------------------------------------------------------ */
/* stratum connections                                                 */
/* ------------------------------------------------------------------ */

function send(socket, obj) {
  if (!socket.destroyed) socket.write(JSON.stringify(obj) + "\n");
}

function setDifficulty(c, d) {
  c.difficulty = Math.min(MAX_DIFF, Math.max(MIN_DIFF, d));
  send(c.socket, { id: null, method: "mining.set_difficulty", params: [c.difficulty] });
}

function sendJob(c) {
  if (!currentJob) return;
  // a job re-sent after a difficulty change keeps the easier of the two, so shares the miner is
  // already working on at the old difficulty still count
  const prev = c.jobDiff.get(currentJob.id);
  c.jobDiff.set(currentJob.id, prev === undefined ? c.difficulty : Math.min(prev, c.difficulty));
  if (c.jobDiff.size > 40) c.jobDiff.delete(c.jobDiff.keys().next().value);
  send(c.socket, { id: null, method: "mining.notify", params: notifyParams(currentJob) });
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
  const next = Math.min(MAX_DIFF, Math.max(MIN_DIFF, c.difficulty * factor));
  if (next === c.difficulty) return;
  setDifficulty(c, next);
  sendJob(c); // new difficulty applies from the next job
}

async function handleSubmit(c, msg) {
  const [worker, jobId, en2Hex, ntimeHex, nonceHex, versionBitsHex] = msg.params || [];
  const reject = (code, text) => {
    c.rejected++;
    send(c.socket, { id: msg.id, result: false, error: [code, text, null] });
  };
  if (!c.authorized) return reject(24, "unauthorized");
  const job = jobs.get(String(jobId));
  if (!job) return reject(21, "stale job");
  if (typeof en2Hex !== "string" || en2Hex.length !== EXTRANONCE2_SIZE * 2 || !/^[0-9a-f]+$/i.test(en2Hex)) return reject(20, "bad extranonce2");
  if (!/^[0-9a-f]{8}$/i.test(ntimeHex || "") || !/^[0-9a-f]{8}$/i.test(nonceHex || "")) return reject(20, "bad ntime/nonce");

  const t = job.template;
  const ntime = parseInt(ntimeHex, 16);
  if (ntime < t.mintime || ntime > Math.floor(Date.now() / 1000) + 7200) return reject(20, "ntime out of range");

  let version = t.version;
  if (versionBitsHex !== undefined) {
    if (!/^[0-9a-f]{1,8}$/i.test(versionBitsHex)) return reject(20, "bad version bits");
    const bits = parseInt(versionBitsHex, 16);
    if ((bits & ~c.versionMask) !== 0) return reject(20, "version bits outside mask");
    version = ((t.version & ~c.versionMask) | (bits & c.versionMask)) >>> 0;
  }

  const key = `${jobId}:${c.extranonce1}:${en2Hex}:${ntimeHex}:${nonceHex}:${version}`.toLowerCase();
  if (c.seen.has(key)) return reject(22, "duplicate share");
  c.seen.add(key);
  if (c.seen.size > 5000) c.seen = new Set([...c.seen].slice(-2500));

  const coinbase = Buffer.concat([job.coinb1, Buffer.from(c.extranonce1, "hex"), Buffer.from(en2Hex, "hex"), job.coinb2]);
  let root = sha256d(coinbase);
  for (const b of job.branches) root = sha256d(Buffer.concat([root, b]));
  const header = Buffer.concat([
    u32le(version),
    reverse(Buffer.from(t.previousblockhash, "hex")),
    root,
    u32le(ntime),
    reverse(Buffer.from(t.bits, "hex")),
    u32le(parseInt(nonceHex, 16)),
  ]);
  const hash = sha256d(header);
  const value = hashToBigInt(hash);

  const diff = c.jobDiff.get(job.id) ?? c.difficulty;
  if (value > targetFromDifficulty(diff)) return reject(23, "low difficulty share");

  c.accepted++;
  c.windowShares++;
  recordShare(c.worker, diff);
  send(c.socket, { id: msg.id, result: true, error: null });

  if (value <= job.target) {
    const blockHash = reverse(hash).toString("hex");
    console.log(`BLOCK FOUND at height ${t.height} by ${c.worker}: ${blockHash}`);
    // full block: header, tx count, coinbase in witness form (marker, flag, 32-byte reserved value), template txs
    const witnessCoinbase = t.default_witness_commitment
      ? Buffer.concat([coinbase.subarray(0, 4), Buffer.from([0, 1]), coinbase.subarray(4, coinbase.length - 4), Buffer.from([1, 32]), Buffer.alloc(32), coinbase.subarray(coinbase.length - 4)])
      : coinbase;
    const block = Buffer.concat([header, varint(1 + job.txs.length), witnessCoinbase, ...job.txs.map((tx) => Buffer.from(tx.data, "hex"))]);
    try {
      const result = await rpc("submitblock", [block.toString("hex")]);
      if (result === null || result === "duplicate") {
        console.log("REAL BLOCK ACCEPTED!", t.height, blockHash);
        const rewardSat = t.coinbasevalue / 100000000;
        recordBlock(c.worker, t.height, rewardSat, blockHash);
        creditPayouts(rewardSat);
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

const server = net.createServer((socket) => {
  miners++;
  const c = {
    socket,
    extranonce1: (nextExtranonce1++ >>> 0).toString(16).padStart(8, "0").slice(-8),
    difficulty: START_DIFF,
    versionMask: 0,
    authorized: false,
    worker: null,
    accepted: 0,
    rejected: 0,
    windowStart: Date.now(),
    windowShares: 0,
    jobDiff: new Map(),
    seen: new Set(),
    buffer: "",
  };
  clients.add(c);
  console.log("miner connected", socket.remoteAddress, "miners:", miners);
  socket.setEncoding("utf8");
  socket.setKeepAlive(true, 60_000);

  socket.on("data", async (data) => {
    c.buffer += data;
    if (c.buffer.length > 64 * 1024) return socket.destroy();
    const lines = c.buffer.split("\n");
    c.buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      try {
        switch (msg.method) {
          case "mining.configure": {
            // BIP310 version rolling (Bitaxe asks for it)
            const [exts = [], opts = {}] = msg.params || [];
            const result = {};
            if (exts.includes("version-rolling")) {
              const requested = parseInt(opts["version-rolling.mask"] || "ffffffff", 16);
              c.versionMask = (requested & VERSION_ROLLING_MASK) >>> 0;
              result["version-rolling"] = true;
              result["version-rolling.mask"] = c.versionMask.toString(16).padStart(8, "0");
            }
            send(socket, { id: msg.id, result, error: null });
            break;
          }
          case "mining.subscribe":
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
            const worker = String(msg.params?.[0] || "");
            const address = worker.split(".")[0];
            if (!/^sat1[02-9ac-hj-np-z]{8,87}$/.test(address)) {
              send(socket, { id: msg.id, result: false, error: [24, "username must be your sat1… address (optionally .workername)", null] });
              break;
            }
            c.worker = worker;
            c.authorized = true;
            send(socket, { id: msg.id, result: true, error: null });
            console.log("authorized miner:", worker, "extranonce1", c.extranonce1);
            sendJob(c);
            break;
          }
          case "mining.submit":
            await handleSubmit(c, msg);
            break;
          default:
            if (msg.id != null && msg.method) send(socket, { id: msg.id, result: null, error: [20, "unsupported method", null] });
        }
      } catch (e) {
        console.error("stratum handler error:", e.message);
        if (msg.id != null) send(socket, { id: msg.id, result: false, error: [20, "internal error", null] });
      }
    }
  });

  socket.on("close", () => {
    miners--;
    clients.delete(c);
    console.log(`miner disconnected (${c.worker || "unauthorized"}: ${c.accepted} accepted, ${c.rejected} rejected), miners: ${miners}`);
  });
  socket.on("error", (err) => console.log("socket error:", err.message));
});

/* ------------------------------------------------------------------ */
/* stats API (unchanged endpoints) + live hashrate per worker          */
/* ------------------------------------------------------------------ */

const statsServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  const stats = readJson("./data/stats.json", { totalShares: 0, miners: {} });
  const blocks = readJson("./data/blocks.json", []);
  const payouts = readJson("./data/payouts.json", { pending: {}, paid: [] });
  const parts = req.url.split("/").filter(Boolean);

  if (req.url === "/stats") {
    res.end(
      JSON.stringify(
        {
          totalShares: stats.totalShares || 0,
          miners: stats.miners || {},
          blocks,
          connected: [...clients].filter((c) => c.authorized).map((c) => ({ worker: c.worker, difficulty: c.difficulty, accepted: c.accepted, rejected: c.rejected })),
          height: template?.height ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (parts[0] === "stats" && parts[1]) {
    const address = parts[1];
    const work = Object.entries(stats.miners || {})
      .filter(([w]) => w.split(".")[0] === address)
      .reduce((a, [, m]) => a + (m.shares || 0), 0);
    res.end(
      JSON.stringify(
        {
          address,
          shares: work,
          blocksFound: blocks.filter((b) => String(b.miner).split(".")[0] === address).length,
          pendingPayout: payouts.pending?.[address] || 0,
          lastShare: Object.entries(stats.miners || {}).filter(([w]) => w.split(".")[0] === address).map(([, m]) => m.lastShare).sort().pop() || null,
        },
        null,
        2,
      ),
    );
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

setInterval(refreshTemplate, 5000);
// miners whose difficulty is too high may never submit; ease them down even without shares
setInterval(() => {
  for (const c of clients) if (c.authorized && (Date.now() - c.windowStart) / 1000 >= RETARGET_SECONDS * 2) retarget(c);
}, 15_000);
refreshTemplate(true);

statsServer.listen(config.statsPort || 8081, "0.0.0.0", () => console.log(`Saturn pool stats API listening on ${config.statsPort || 8081}`));
server.listen(config.stratumPort, "0.0.0.0", () => console.log(`Saturn stratum listening on ${config.stratumPort}`));
