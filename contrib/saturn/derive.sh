#!/usr/bin/env bash
# Regenerate the saturn-named entry points (saturnd.cpp, saturn-cli.cpp, ...) from upstream's bitcoin-named
# originals, rebranded. Run from the repository root after rebranding an upstream tree.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for b in src/bitcoin.cpp src/bitcoind.cpp src/bitcoin-cli.cpp src/bitcoin-tx.cpp src/bitcoin-util.cpp src/bitcoin-wallet.cpp \
         src/init/bitcoind.cpp src/init/bitcoin-wallet.cpp cmake/bitcoin-build-config.h.in \
         src/bitcoin-res.rc src/bitcoind-res.rc src/bitcoin-cli-res.rc src/bitcoin-tx-res.rc src/bitcoin-util-res.rc src/bitcoin-wallet-res.rc; do
  [ -f "$b" ] || continue
  s="${b//bitcoin/saturn}"
  python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); import rebrand; sys.stdout.write(rebrand.apply(open(sys.argv[2], encoding="utf-8").read()))' "$here" "$b" > "$s"
done
