#!/usr/bin/env python3
"""Saturn rebrand: map Bitcoin Core source text to Saturn Core source text.

Reproduces the mechanical substitutions saturn-core applied when it forked, so an upstream release
can be rebranded the same way before Saturn's real changes are merged on top.
Usage: rebrand.py <tree-dir>   (rewrites files in place; binary files are skipped)
"""
import os, re, sys

# Order matters: specific before general.
RULES = [
    (re.compile(r'bitcoin.conf'), 'saturn.conf'),          # as forked (regex dot)
    (re.compile(r'BitcoinTestFramework'), 'SaturnTestFramework'),
    (re.compile(r'Bitcoin'), 'Saturn'),
    (re.compile(r'bitcoin'), 'saturn'),
    (re.compile(r'BTC'), 'SAT'),
]
SKIP_DIRS = {'.git', 'src/secp256k1', 'src/leveldb', 'src/crc32c', 'src/minisketch', 'src/crypto/ctaes'}
TEXT_EXT = None  # all non-binary files

def is_binary(data: bytes) -> bool:
    return b'\0' in data[:8192]

def apply(text: str) -> str:
    for pat, rep in RULES:
        text = pat.sub(rep, text)
    return text

def main(root):
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        dirnames[:] = [d for d in dirnames if os.path.normpath(os.path.join(rel, d)) not in SKIP_DIRS and d != '.git']
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            if os.path.islink(p):
                continue
            with open(p, 'rb') as f:
                data = f.read()
            if is_binary(data):
                continue
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                continue
            new = apply(text)
            if new != text:
                with open(p, 'w', encoding='utf-8', newline='') as f:
                    f.write(new)

if __name__ == '__main__':
    main(sys.argv[1])
