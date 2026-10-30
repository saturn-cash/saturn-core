# Updating Saturn Core to a new Bitcoin Core release

Saturn Core is Bitcoin Core with (1) a mechanical rename (Bitcoin→Saturn, bitcoind→saturnd, BTC→SAT…) and
(2) a small set of real changes: chain parameters, a few node behaviours for a young chain, and docs.
A plain `git merge` of a Bitcoin release conflicts on hundreds of files because of the rename. These scripts
turn that into a merge where only the real changes can conflict.

The real Saturn changes (keep these when resolving conflicts):

| File | Change |
| --- | --- |
| `src/kernel/chainparams.cpp` | Saturn genesis, magic bytes, port 9999, powLimit, **difficulty retarget every block**, `sat` bech32, seeds, empty minimum-chainwork/assumevalid |
| `src/validation.cpp` | leaves initial block download even when the tip is old (quiet chain can still mine) |
| `src/rpc/mining.cpp` | `getblocktemplate` works with zero peers |
| `src/util/chaintype.cpp` | mainnet chain name `saturn` |
| `src/wallet/dump.cpp` | wallet dump magic `SATURN_CORE_WALLET_DUMP` |
| `src/node/warnings.cpp` | pre-release warning text |
| `README.md`, `SECURITY.md`, `.gitignore` | Saturn docs |

## Procedure

```bash
git remote add upstream https://github.com/bitcoin/bitcoin.git
git fetch upstream tag vNEW --no-tags
OLD=<Bitcoin commit Saturn was last merged with>      # v32.1 after this update
SAT=$(git rev-parse HEAD)

# 1. rebranded old base
git worktree add ../rb-base $OLD
python3 contrib/saturn/policy.py . $OLD $SAT $OLD ../rb-base
(cd ../rb-base && ../<repo>/contrib/saturn/derive.sh && git add -A)
BASE=$(cd ../rb-base && git commit-tree $(git write-tree) -p $OLD -m base)

# 2. rebranded new release
git worktree add ../rb-new vNEW
python3 contrib/saturn/policy.py . $OLD $SAT vNEW ../rb-new
(cd ../rb-new && ../<repo>/contrib/saturn/derive.sh && git add -A)
NEW=$(cd ../rb-new && git commit-tree $(git write-tree) -p $BASE -m "Bitcoin Core vNEW, rebranded")

# 3. Saturn's tree on top of the rebranded base, then merge
OURS=$(git commit-tree $SAT^{tree} -p $BASE -m saturn)
git checkout -b merge-vNEW $OURS && git merge $NEW      # resolve the (few) conflicts, keeping Saturn's values
# 4. record it as a real merge of Saturn + vNEW
TREE=$(git write-tree)
git checkout <saturn branch> && git reset --hard $(git commit-tree $TREE -p $SAT -p vNEW -m "Merge Bitcoin Core vNEW")
```

Note: `policy.py` decides per file whether to rebrand, following what Saturn did at the fork. After this
update, Saturn's "last merged" point is v32.1, so use `OLD=v32.1` and pass the merge commit as `SAT`.
Vendored subtrees (secp256k1, leveldb, minisketch, crc32c, ctaes) are always taken from upstream unchanged.
