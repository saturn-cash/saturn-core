// Saturn Pool payouts.
//
// stratum.js records every block the pool finds as a "round": the block's height and hash, its
// reward, and each miner's share of it (by work since the previous block). This daemon, once a
// minute:
//   1. checks every maturing round: if its block was replaced in the chain, the round is dropped;
//      once it has 101 confirmations its reward is spendable, so each miner's share moves to "owed";
//   2. pays everyone owed at least MIN_PAYOUT in ONE transaction (sendmany) from the pool wallet,
//      and records the txid.
// It only ever pays out rewards of blocks the pool actually found and that have unlocked, never
// other money that happens to sit in the same wallet. The network fee comes out of the pool wallet.
//
// config.json: payoutWallet (default "vps-wallet"), minPayout (default 1 SAT).

const fs = require("fs");
const fetch = require("node-fetch");

const config = JSON.parse(fs.readFileSync("./config.json"));
const WALLET = config.payoutWallet || "vps-wallet";
const MIN_PAYOUT = Number(config.minPayout ?? 1);
const MATURITY = 101; // a block reward can be spent once it has 101 confirmations
const CHECK_EVERY_MS = 60_000;
const DRY_RUN = process.argv.includes("--dry-run");
const FILE = "./data/payouts.json";

async function rpc(method, params = [], wallet = null) {
  const auth = Buffer.from(`${config.rpc.user}:${config.rpc.password}`).toString("base64");
  const res = await fetch(`http://${config.rpc.host}:${config.rpc.port}${wallet ? `/wallet/${encodeURIComponent(wallet)}` : ""}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "1.0", id: "saturn-payout", method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
  return json.result;
}

const round8 = (v) => Math.round(v * 1e8) / 1e8;

function load() {
  let p;
  try {
    p = JSON.parse(fs.readFileSync(FILE));
  } catch {
    p = {};
  }
  p.owed = p.owed || {};
  p.paid = p.paid || [];
  p.rounds = p.rounds || [];
  // Before rounds existed, "pending" was a running total with no block behind each entry. Those
  // amounts can't be matched to rewards the wallet holds, so they're set aside, not paid.
  if (!p.migrated) {
    if (p.pending && Object.keys(p.pending).length && !p.rounds.length) {
      p.legacyPending = p.pending;
      console.log("[payout] set aside legacy pending balances (no block rewards behind them):", p.legacyPending);
    }
    p.migrated = new Date().toISOString();
  }
  return p;
}

function save(p) {
  const pending = {};
  for (const [a, v] of Object.entries(p.owed)) pending[a] = (pending[a] || 0) + v;
  for (const r of p.rounds) if (r.status === "immature") for (const [a, v] of Object.entries(r.credits)) pending[a] = (pending[a] || 0) + v;
  for (const a of Object.keys(pending)) pending[a] = round8(pending[a]);
  p.pending = pending;
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, FILE);
}

async function tick() {
  const p = load();
  const tip = await rpc("getblockcount");

  // 1. mature or drop rounds
  for (const r of p.rounds) {
    if (r.status !== "immature") continue;
    if (r.height > tip) continue;
    const hash = await rpc("getblockhash", [r.height]);
    if (hash !== r.hash) {
      r.status = "orphaned";
      console.log(`[payout] block ${r.height} is no longer in the chain; its round is dropped`);
      continue;
    }
    const confirmations = tip - r.height + 1;
    if (confirmations >= MATURITY) {
      r.status = "mature";
      for (const [a, v] of Object.entries(r.credits)) p.owed[a] = round8((p.owed[a] || 0) + v);
      console.log(`[payout] block ${r.height} unlocked: ${r.reward} SAT now owed to ${Object.keys(r.credits).length} miner(s)`);
    }
  }
  // keep the file small: settled rounds older than the last 200 go
  if (p.rounds.length > 400) p.rounds = p.rounds.filter((r, i) => r.status === "immature" || i >= p.rounds.length - 200);

  // 2. pay everyone over the minimum in one transaction
  const due = Object.entries(p.owed).filter(([a, v]) => a.startsWith(`${config.addressPrefix || "sat"}1`) && v >= MIN_PAYOUT);
  if (!due.length) {
    save(p);
    return;
  }
  const amounts = Object.fromEntries(due.map(([a, v]) => [a, round8(v)]));
  const total = round8(due.reduce((s, [, v]) => s + v, 0));
  const balances = await rpc("getbalances", [], WALLET);
  const trusted = Number(balances?.mine?.trusted || 0);
  if (trusted < total) {
    console.log(`[payout] ${total} SAT due but "${WALLET}" only has ${trusted} SAT spendable; waiting`);
    save(p);
    return;
  }
  if (DRY_RUN) {
    console.log("[payout] dry run, would pay:", amounts);
    save(p);
    return;
  }
  const txid = await rpc("sendmany", ["", amounts, 1, `Saturn Pool payout`], WALLET);
  const time = new Date().toISOString();
  for (const [a, v] of Object.entries(amounts)) {
    p.owed[a] = round8(p.owed[a] - v);
    if (p.owed[a] <= 0) delete p.owed[a];
    p.paid.unshift({ address: a, amount: v, txid, time });
  }
  p.paid = p.paid.slice(0, 500);
  save(p);
  console.log(`[payout] paid ${total} SAT to ${due.length} miner(s) in ${txid}`);
}

async function main() {
  console.log(`[payout] Saturn payout daemon: wallet "${WALLET}", minimum ${MIN_PAYOUT} SAT, rewards unlock after ${MATURITY} confirmations${DRY_RUN ? ", DRY RUN" : ""}`);
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
