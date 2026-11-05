#!/usr/bin/env bash
# Saturn server inventory: READ-ONLY. Prints what the hardening script needs to know.
# Passwords, cookies and keys are masked. Nothing is changed.
mask() { sed -E 's/("?(password|rpcpassword|pass|secret|token|passphrase)"?[[:space:]]*[:=][[:space:]]*"?)[^",[:space:]]+/\1***/Ig'; }
echo "== system";      . /etc/os-release; echo "$PRETTY_NAME"; uname -r; nproc; free -h | sed -n 2p; df -h / | tail -1
echo "== users";       id; ls -ld /root/saturn-modern-pool 2>/dev/null; getent passwd saturn || echo "no saturn user"
echo "== ssh";         for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -f "$f" ] && echo "$f: $(grep -c . "$f") key(s)"; done
                       sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|pubkeyauthentication) '
echo "== listening";   ss -ltnp | awk 'NR==1||/LISTEN/' | sed -E 's/users:\(\("([^"]+)",pid=([0-9]+).*/\1 pid=\2/'
echo "== firewall";    (ufw status verbose 2>/dev/null || echo "ufw not installed") | head -30
echo "== fail2ban";    (fail2ban-client status 2>/dev/null || echo "fail2ban not installed") | head -5
echo "== unattended";  dpkg -l unattended-upgrades 2>/dev/null | grep -q '^ii' && echo installed || echo "not installed"
echo "== saturn.service"; systemctl cat saturn 2>/dev/null | mask; systemctl is-active saturn
echo "== saturn.conf"; for f in /root/.saturn/saturn.conf /root/.saturn/bitcoin.conf /etc/saturn/saturn.conf; do [ -f "$f" ] && { echo "-- $f"; mask < "$f"; }; done
echo "== datadir";     ls /root/.saturn 2>/dev/null | head -30; du -sh /root/.saturn 2>/dev/null
echo "== node js";     node -v; npm -v; pm2 -v 2>/dev/null
echo "== pm2";         pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const p of JSON.parse(s||"[]"))console.log(p.name,p.pm2_env.status,"cwd="+p.pm2_env.pm_cwd,"script="+p.pm2_env.pm_exec_path,"user="+p.pm2_env.username)})'
echo "== pool config"; mask < /root/saturn-modern-pool/config.json
echo "== pool files";  ls -la /root/saturn-modern-pool /root/saturn-modern-pool/data 2>/dev/null; sha256sum /root/saturn-modern-pool/{stratum,payout}.js 2>/dev/null | cut -c1-12
echo "== crontab";     crontab -l 2>/dev/null
echo "== wallets";     CLI=$(command -v saturn-cli); for w in $($CLI listwallets 2>/dev/null | tr -d '[]", ' ); do echo "-- $w"; $CLI -rpcwallet="$w" getwalletinfo 2>/dev/null | grep -E '"(walletname|descriptors|unlocked_until|private_keys_enabled|balance|immature_balance)"'; $CLI -rpcwallet="$w" getbalances 2>/dev/null | tr -d '\n ' ; echo; done
                       $CLI listwalletdir 2>/dev/null | tr -d '\n '; echo
echo "== chain";       $CLI getblockchaininfo 2>/dev/null | grep -E '"(blocks|headers|difficulty)"'; $CLI getnetworkinfo 2>/dev/null | grep -E '"(connections|localaddresses)"'
echo "== dns";         getent hosts pool.saturn.boats saturn.boats; curl -s -4 --max-time 5 ifconfig.me; echo
echo "== caddy/nginx"; for b in caddy nginx apache2; do command -v $b >/dev/null && echo "$b installed"; done; true
