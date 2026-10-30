#!/usr/bin/env python3
"""Apply the Saturn rebrand to a checked-out upstream tree, file by file, following saturn-core's own choices.

  policy.py <repo> <mb-ref> <saturn-ref> <target-ref> <tree-dir>

A file is rebranded if saturn-core changed that file relative to the Bitcoin merge base (Saturn renamed it);
it stays raw if saturn-core left it alone. Files new in <target-ref> follow the majority of their directory.
Upstream file renames inherit the source file's decision. Vendored subtrees are never rebranded.
"""
import os, subprocess, sys, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rebrand

repo, mb, saturn, target, tree = sys.argv[1:6]
SUBTREES = ('src/secp256k1/', 'src/minisketch/', 'src/leveldb/', 'src/crc32c/', 'src/crypto/ctaes/')

def git(*a):
    return subprocess.run(['git', '-C', repo, *a], check=True, capture_output=True, text=True).stdout

touched = set(git('diff', '--name-only', mb, saturn).split('\n')) - {''}
mb_files = set(git('ls-tree', '-r', '--name-only', mb).split('\n')) - {''}
renames = {}
for line in git('diff', '--name-status', '-M', mb, target).split('\n'):
    p = line.split('\t')
    if p and p[0].startswith('R'):
        renames[p[2]] = p[1]

# directory votes: among mb files that the rebrand would change, how many did Saturn actually rename?
votes = collections.defaultdict(lambda: [0, 0])
# cheap pre-filter with git grep for files mentioning the words at all
hits = set(git('grep', '-l', '-I', '-E', 'Bitcoin|bitcoin|BTC', mb).replace(f'{mb}:', '').split('\n')) - {''}
for f in hits:
    if f.startswith(SUBTREES):
        continue
    d = os.path.dirname(f)
    while True:
        votes[d][1] += 1
        if f in touched:
            votes[d][0] += 1
        if d == '':
            break
        d = os.path.dirname(d)

def dir_says_rebrand(path):
    d = os.path.dirname(path)
    while True:
        r, n = votes.get(d, (0, 0))
        if n >= 3:
            return r * 2 > n
        if d == '':
            return True
        d = os.path.dirname(d)

def decide(path):
    if path.startswith(SUBTREES):
        return False
    src = renames.get(path, path)
    if src in mb_files:
        return src in touched
    return dir_says_rebrand(path)

changed = 0
for root, dirs, files in os.walk(tree):
    dirs[:] = [d for d in dirs if d != '.git']
    for fn in files:
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, tree)
        if os.path.islink(full) or not decide(rel):
            continue
        data = open(full, 'rb').read()
        if rebrand.is_binary(data):
            continue
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            continue
        new = rebrand.apply(text)
        if new != text:
            open(full, 'w', encoding='utf-8', newline='').write(new)
            changed += 1
print(f'rebranded {changed} files', file=sys.stderr)
