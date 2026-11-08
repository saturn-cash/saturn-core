// Saturn Pool payouts.
//
// stratum.js records every block the pool finds as a "round" in rounds.json: the block's height and
// hash, its reward, and each miner's share of it (PPLNS). This daemon, once a minute:
//   1. checks every unsettled round: if its block was replaced in the chain, the round is dropped
//      ("orphaned"); once it has 101 confirmations its reward is spendable, so each miner's share
//      moves to "owed" ("mature");
//   2. pays everyone owed at least minPayout in ONE transaction (sendmany) from the pool wallet;
//   3. optionally sweeps whatever the wallet holds beyond what miners are owed (the operator's own
//      coins, rounding dust) to an offline address, so little sits on the server.
// It only ever pays out rewards of blocks the pool actually found and that have unlocked. If the
// wallet is encrypted it is unlocked for a few seconds per payment and locked again right after.
// When stratum.js sees a deep chain reorganisation (guard.json) payouts stop until an operator runs
// `node payout.js --resume`.
//
// Settings (config.json, or a separate file named by SATURN_PAYOUT_CONFIG that only this daemon can
// read, which is where the wallet passphrase belongs):
//   payoutWallet (default "vps-wallet"), minPayout (default 1 SAT), rpc {host, port, user, password},
//   walletPassphrase, coldAddress, coldSweepMin (default 10 SAT), keepReserve (default 1 SAT)
//
//   node payout.js            run the daemon
//   node payout.js --once     one pass, then exit;  --dry-run: say what would be paid, pay nothing
//   node payout.js --status   print what is owed, maturing and paid
//   node payout.js --resume   lift a reorg pause after checking the chain

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const base = JSON.parse(fs.readFileSync(process.env.SATURN_POOL_CONFIG || "./config.json"));
const own = process.env.SATURN_PAYOUT_CONFIG ? JSON.parse(fs.readFileSync(process.env.SATURN_PAYOUT_CONFIG)) : {};
const config = { ...base, ...own, rpc: { ...base.rpc, ...(own.rpc || {}) } };
const DATA = config.dataDir || process.env.SATURN_POOL_DATA || "./data";
const dataFile = (n) => path.join(DATA, n);

const WALLET = config.payoutWallet || "vps-wallet";
const MIN_PAYOUT = Number(config.minPayout ?? 1);
const MATURITY = 101; // a block reward can be spent once it has 101 confirmations
const CHECK_EVERY_MS = 60_000;
const SWEEP_MIN = Number(config.coldSweepMin ?? 10);
const RESERVE = Number(config.keepReserve ?? 1);
const SWEEP_EVERY_MS = 60 * 60_000;
const DRY_RUN = process.argv.includes("--dry-run");
const FILE = dataFile("payouts.json");

async function rpc(method, params = [], wallet = null) {
  const auth = Buffer.from(`${config.rpc.user}:${config.rpc.password}`).toString("base64");
  const res = await fetch(`http://${config.rpc.host}:${config.rpc.port}${wallet ? `/wallet/${encodeURIComponent(wallet)}` : ""}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "saturn-payout", method, params }),
    timeout: 60_000,
  });
  if (res.status === 401 || res.status === 403) throw new Error(`the node refused ${method} (check the payout RPC user and its whitelist)`);
  const json = await res.json();
  if (json.error) throw Object.assign(new Error(json.error.message || JSON.stringify(json.error)), { code: json.error.code });
  return json.result;
}

const round8 = (v) => Math.round(v * 1e8) / 1e8;
const roundId = (r) => `${r.height}:${r.hash}`;
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function load() {
  const p = readJson(FILE, {});
  p.owed = p.owed || {};
  p.paid = p.paid || [];
  p.settled = p.settled || {};
  // Before rounds existed, "pending" was a running total with no block behind each entry. Those
  // amounts can't be matched to rewards the wallet holds, so they're set aside, not paid.
  if (!p.migrated) {
    if (p.pending && Object.keys(p.pending).length && !(p.rounds || []).length) {
      p.legacyPending = p.pending;
      console.log("[payout] set aside legacy pending balances (no block rewards behind them):", p.legacyPending);
    }
    p.migrated = new Date().toISOString();
  }
  // Rounds used to live in this file with their status inline. They now live in rounds.json (written
  // by stratum.js) and their status here. Create rounds.json first if stratum hasn't yet.
  if (Array.isArray(p.rounds)) {
    if (!fs.existsSync(dataFile("rounds.json"))) writeJsonAtomic(dataFile("rounds.json"), p.rounds.map(({ status, ...r }) => r));
    for (const r of p.rounds) if (r.status && r.status !== "immature") p.settled[roundId(r)] = r.status;
    delete p.rounds;
  }
  delete p.pending; // stratum.js works pending out from owed + maturing rounds
  return p;
}
// the pool page shows the payout minimum, so it travels with the state stratum.js reads
const save = (p) => writeJsonAtomic(FILE, { ...p, minPayout: MIN_PAYOUT });

// Encrypted wallet: unlock for one payment, lock again whatever happens.
async function withUnlockedWallet(fn) {
  if (!config.walletPassphrase) return fn();
  try {
    await rpc("walletpassphrase", [config.walletPassphrase, 60], WALLET);
  } catch (e) {
    if (!/unencrypted/i.test(e.message)) throw new Error(`couldn't unlock "${WALLET}": ${e.message}`);
  }
  try {
    return await fn();
  } finally {
    await rpc("walletlock", [], WALLET).catch(() => {});
  }
}

function pausedBy(p) {
  const g = readJson(dataFile("guard.json"), {});
  if (!g.paused) return null;
  if (p.resumedAt && p.resumedAt > g.paused.since) return null;
  return g.paused;
}

let lastPauseLog = 0;
async function tick() {
  const p = load();
  const rounds = readJson(dataFile("rounds.json"), []);
  const tip = await rpc("getblockcount");

  // 1. mature or drop rounds
  for (const r of rounds) {
    const id = roundId(r);
    if (p.settled[id] || r.height > tip) continue;
    const hash = await rpc("getblockhash", [r.height]);
    if (hash !== r.hash) {
      p.settled[id] = "orphaned";
      console.log(`[payout] block ${r.height} is no longer in the chain; its round is dropped`);
      continue;
    }
    if (tip - r.height + 1 >= MATURITY) {
      p.settled[id] = "mature";
      for (const [a, v] of Object.entries(r.credits)) p.owed[a] = round8((p.owed[a] || 0) + v);
      console.log(`[payout] block ${r.height} unlocked: ${r.reward} SAT now owed to ${Object.keys(r.credits).length} miner(s)`);
    }
  }
  // settled rounds that stratum.js has already dropped from rounds.json can be forgotten
  const live = new Set(rounds.map(roundId));
  for (const id of Object.keys(p.settled)) if (!live.has(id) && Object.keys(p.settled).length > 2000) delete p.settled[id];

  const paused = pausedBy(p);
  if (paused) {
    if (Date.now() - lastPauseLog > 10 * 60_000) {
      lastPauseLog = Date.now();
      console.error(`[payout] PAUSED since ${paused.since}: ${paused.reason}. Check the chain, then run: node payout.js --resume`);
    }
    save(p);
    return;
  }

  // 2. pay everyone over the minimum in one transaction
  const prefix = `${config.addressPrefix || "sat"}1`;
  const due = Object.entries(p.owed).filter(([a, v]) => a.startsWith(prefix) && v >= MIN_PAYOUT);
  if (due.length) {
    const amounts = Object.fromEntries(due.map(([a, v]) => [a, round8(v)]));
    const total = round8(due.reduce((s, [, v]) => s + v, 0));
    const trusted = Number((await rpc("getbalances", [], WALLET))?.mine?.trusted || 0);
    if (trusted < total) {
      console.log(`[payout] ${total} SAT due but "${WALLET}" only has ${trusted} SAT spendable; waiting`);
    } else if (DRY_RUN) {
      console.log("[payout] dry run, would pay:", amounts);
    } else {
      const txid = await withUnlockedWallet(() => rpc("sendmany", ["", amounts, 1, "Saturn Pool payout"], WALLET));
      const time = new Date().toISOString();
      for (const [a, v] of Object.entries(amounts)) {
        p.owed[a] = round8(p.owed[a] - v);
        if (p.owed[a] <= 0) delete p.owed[a];
        p.paid.unshift({ address: a, amount: v, txid, time });
      }
      p.paid = p.paid.slice(0, 500);
      save(p); // record the payment before anything else can fail
      console.log(`[payout] paid ${total} SAT to ${due.length} miner(s) in ${txid}`);
    }
  }

  // 3. send what isn't owed to anyone to the offline address
  if (config.coldAddress && !DRY_RUN && Date.now() - Date.parse(p.lastSweep?.time || 0) > SWEEP_EVERY_MS) {
    const trusted = Number((await rpc("getbalances", [], WALLET))?.mine?.trusted || 0);
    const owedTotal = Object.values(p.owed).reduce((s, v) => s + v, 0);
    const excess = round8(trusted - owedTotal - RESERVE);
    if (excess >= SWEEP_MIN) {
      // subtract the fee from the swept amount, so what's owed stays untouched
      const txid = await withUnlockedWallet(() => rpc("sendtoaddress", [config.coldAddress, excess, "", "", true], WALLET));
      p.lastSweep = { amount: excess, txid, time: new Date().toISOString(), to: config.coldAddress };
      console.log(`[payout] swept ${excess} SAT (not owed to miners) to the offline address ${config.coldAddress} in ${txid}`);
    }
  }
  save(p);
}

// the address blocks pay must be in the wallet this daemon pays from
async function checkWallet() {
  try {
    const info = await rpc("getwalletinfo", [], WALLET);
    const locked = info.unlocked_until !== undefined;
    console.log(`[payout] wallet "${WALLET}": ${locked ? "encrypted" : "NOT encrypted"}${locked && !config.walletPassphrase ? " but no walletPassphrase is set, so payments will fail" : ""}`);
    if (config.payoutAddress) {
      const a = await rpc("getaddressinfo", [config.payoutAddress], WALLET);
      if (!a.ismine) console.error(`[payout] WARNING: blocks pay ${config.payoutAddress}, which is NOT in "${WALLET}". Those rewards can't be paid out.`);
    }
    if (config.coldAddress) {
      const v = await rpc("validateaddress", [config.coldAddress]);
      if (!v.isvalid) throw new Error(`coldAddress ${config.coldAddress} isn't a valid address`);
      const mine = await rpc("getaddressinfo", [config.coldAddress], WALLET).catch(() => ({}));
      if (mine.ismine) console.error(`[payout] WARNING: coldAddress is in "${WALLET}" itself; sweeping to it keeps the coins on this server.`);
    }
  } catch (e) {
    console.error(`[payout] wallet check: ${e.message}`);
  }
}

async function main() {
  if (process.argv.includes("--resume")) {
    const p = load();
    p.resumedAt = new Date().toISOString();
    save(p);
    console.log("[payout] payouts resumed. Any later deep reorganisation pauses them again.");
    return;
  }
  if (process.argv.includes("--status")) {
    const p = load();
    const rounds = readJson(dataFile("rounds.json"), []);
    const maturing = rounds.filter((r) => !p.settled[roundId(r)]);
    console.log(JSON.stringify({ wallet: WALLET, paused: pausedBy(p), owed: p.owed, maturing: maturing.map((r) => ({ height: r.height, reward: r.reward, miners: Object.keys(r.credits).length })), lastPaid: p.paid.slice(0, 10), lastSweep: p.lastSweep || null }, null, 2));
    return;
  }
  console.log(
    `[payout] Saturn payout daemon: wallet "${WALLET}", minimum ${MIN_PAYOUT} SAT, rewards unlock after ${MATURITY} confirmations` +
      `${config.coldAddress ? `, extra coins swept to ${config.coldAddress}` : ""}${DRY_RUN ? ", DRY RUN" : ""}`,
  );
  await checkWallet();
  const once = process.argv.includes("--once");
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("[payout] error:", e.message);
    }
    if (once) break;
    await new Promise((r) => setTimeout(r, CHECK_EVERY_MS));
  }
}

main();
