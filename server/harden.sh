#!/usr/bin/env bash
# Saturn server hardening: one script for the pool server (pool.saturn.boats).
#
#   harden.sh check                     show what would change (default; changes nothing)
#   harden.sh apply [options]           do it
#   harden.sh rollback                  put the services back the way they were (emergency only)
#
# Options for apply:
#   --cold-address sat1...   sweep the pool wallet's coins that aren't owed to miners to this offline
#                            address (an address from the Saturn app on your own computer)
#   --ssh-keys-only          turn off SSH password logins (only after you've checked you can log in
#                            with your SSH key; the Vultr web console still works if you get locked out)
#   --yes                    don't ask before starting
#
# What apply does, in order (each step is safe to run again):
#   1. installs fail2ban, certbot and jq
#   2. stops the pool, moves Saturn Core to its own user "saturn" (/var/lib/saturn), and the pool to
#      two users: "saturnpool" runs stratum + website, "saturnpay" runs payouts. Code goes to
#      /opt/saturn-pool (read-only for them), data to /var/lib/saturn-pool, settings to /etc/saturn-pool
#   3. gives each its own node login that can only call what it needs: the pool can't touch the
#      wallet at all; payouts can only pay
#   4. encrypts the pool wallet (vps-wallet) with a new random passphrase only the payout user can read
#   5. runs stratum and payouts as systemd services (restart on crash, logs in journald, size-capped)
#   6. HTTPS for pool.saturn.boats through nginx + Let's Encrypt
#   7. firewall: closes ports nothing uses any more (3000, 8080)
#   8. fail2ban for SSH, automatic security updates, (optionally) key-only SSH
#   9. daily encrypted wallet backups to /var/backups/saturn (keep 14 days)
# Everything it replaces is copied to /root/saturn-backup-<time>/ first.

set -Eeuo pipefail
umask 022

DIST="${SATURN_DIST:-https://raw.githubusercontent.com/saturn-cash/saturn-core/dist}"   # set SATURN_DIST to a commit URL to pin every download to one version
OLD_POOL=/root/saturn-modern-pool
OLD_DATADIR=/root/.saturn
NODE_HOME=/var/lib/saturn
POOL_CODE=/opt/saturn-pool
POOL_DATA=/var/lib/saturn-pool
POOL_ETC=/etc/saturn-pool
BACKUPS=/var/backups/saturn
DOMAIN=pool.saturn.boats
WALLET=vps-wallet

MODE=${1:-check}
shift || true
COLD=""
SSH_KEYS_ONLY=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --cold-address) COLD=${2:-}; shift 2 ;;
    --ssh-keys-only) SSH_KEYS_ONLY=1; shift ;;
    --yes) YES=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

bold=$'\e[1m'; green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; off=$'\e[0m'
step() { echo; echo "${bold}== $*${off}"; }
ok() { echo "${green}  ✓ $*${off}"; }
warn() { echo "${yellow}  ! $*${off}"; }
die() { echo "${red}  ✗ $*${off}" >&2; exit 1; }
# report where it stopped (only for the script itself, not for checks inside $(…) that may fail)
trap '[ "$BASHPID" = "$$" ] && echo "${red}stopped at line $LINENO: $BASH_COMMAND${off}" >&2' ERR

[ "$(id -u)" = 0 ] || die "run this as root"
NODE_BIN=$(command -v node || true)
SATURND=$(command -v saturnd || echo /usr/local/bin/saturnd)
CLI_BIN=$(command -v saturn-cli || echo /usr/local/bin/saturn-cli)

# saturn-cli as the node's admin, wherever the data directory is right now
admin_cli() {
  local dir=$NODE_HOME
  [ -f "$NODE_HOME/saturn.conf" ] || dir=$OLD_DATADIR
  "$CLI_BIN" -datadir="$dir" "$@"
}

rpcauth_line() { # user password -> rpcauth=user:salt$hmac (what share/rpcauth/rpcauth.py makes)
  local salt
  salt=$(openssl rand -hex 16)
  printf 'rpcauth=%s:%s$%s\n' "$1" "$salt" "$(printf '%s' "$2" | openssl dgst -sha256 -hmac "$salt" -r | cut -d' ' -f1)"
}
key_count() { local n; n=$(grep -sc . /root/.ssh/authorized_keys || true); echo "${n:-0}"; }
randpw() { openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40; }

# ------------------------------------------------------------------------------------------------
check() {
  step "What's here now"
  . /etc/os-release; echo "  $PRETTY_NAME, $(nproc) CPU, $(free -h | awk '/Mem:/{print $2}') RAM"
  df -h / | awk 'NR==2{print "  disk: "$3" used of "$2" ("$5"), "$4" free"}'
  [ -n "$NODE_BIN" ] && echo "  node: $NODE_BIN $($NODE_BIN -v)" || warn "node.js not found"
  case "$NODE_BIN" in /root/*) warn "node.js lives under /root; the new service users can't run it there. Install it system-wide first (apt install nodejs)";; esac
  [ -x "$SATURND" ] && echo "  saturnd: $SATURND" || warn "saturnd not found"
  if [ -L "$OLD_DATADIR" ]; then ok "Saturn Core already moved to $NODE_HOME"; else echo "  Saturn Core data: $OLD_DATADIR ($(du -sh $OLD_DATADIR 2>/dev/null | cut -f1)), runs as $(systemctl show -p User --value saturn 2>/dev/null || echo '?')"; fi
  systemctl is-active --quiet saturn-stratum 2>/dev/null && ok "stratum already a systemd service" || echo "  pool: pm2 apps $(pm2 jlist 2>/dev/null | jq -r '[.[].name]|join(", ")' 2>/dev/null || echo '?')"
  local enc
  enc=$(admin_cli -rpcwallet=$WALLET getwalletinfo 2>/dev/null | jq -r 'if has("unlocked_until") then "encrypted" else "NOT encrypted" end' || echo "unknown")
  echo "  $WALLET wallet: $enc"
  echo "  ssh: $(sshd -T 2>/dev/null | grep -Ei '^(passwordauthentication|permitrootlogin) ' | tr '\n' ' ')"
  echo "  root ssh keys: $(key_count)"
  command -v fail2ban-client >/dev/null && ok "fail2ban installed" || echo "  fail2ban: not installed"
  echo "  nginx sites for $DOMAIN: $(grep -Rls "server_name[^;]*$DOMAIN" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | tr '\n' ' ' || true)"
  [ -d /etc/letsencrypt/live/$DOMAIN ] && ok "HTTPS certificate exists" || echo "  HTTPS: no certificate yet"
  echo "  open firewall ports: $(ufw status 2>/dev/null | awk '/ALLOW/ && !/v6/{print $1}' | sort -u | tr '\n' ' ')"
  step "Biggest folders (the disk is the thing to watch)"
  du -xh / --max-depth=2 2>/dev/null | sort -rh | sed -n '2,12p' | sed 's/^/  /'
  echo "  pm2 logs: $(du -sh /root/.pm2/logs 2>/dev/null | cut -f1)   journal: $(journalctl --disk-usage 2>/dev/null | grep -o '[0-9.]*[KMGT]' | head -1)"
  step "Plan"
  cat <<EOF
  1. install fail2ban, certbot, jq
  2. move Saturn Core to user "saturn" ($NODE_HOME); pool to users "saturnpool" + "saturnpay"
     (code $POOL_CODE, data $POOL_DATA, settings $POOL_ETC)
  3. separate node logins: pool = mining calls only, payouts = paying only
  4. encrypt $WALLET with a random passphrase (shown once; write it down)
  5. stratum + payouts as systemd services; remove the old pm2 apps (saturn-stratum, saturn-payout, saturn-pool)
  6. HTTPS for $DOMAIN via nginx + Let's Encrypt
  7. firewall: close 3000 and 8080
  8. fail2ban for SSH + automatic security updates$([ $SSH_KEYS_ONLY = 1 ] && echo " + key-only SSH")
  9. daily wallet backups in $BACKUPS
$([ -n "$COLD" ] && echo "  + sweep coins not owed to miners to $COLD" || echo "  (no --cold-address: everything stays in $WALLET)")
  Mining stops for about a minute while this runs. Run:  bash harden.sh apply$([ -n "$COLD" ] && echo " --cold-address $COLD")
EOF
}

# ------------------------------------------------------------------------------------------------
apply() {
  [ -n "$NODE_BIN" ] || die "node.js not found"
  case "$NODE_BIN" in /root/*) die "node.js is installed under /root ($NODE_BIN); install it system-wide first";; esac
  [ -x "$SATURND" ] || die "saturnd not found"
  if [ -n "$COLD" ]; then
    [[ "$COLD" =~ ^sat1[02-9ac-hj-np-z]{8,87}$ ]] || die "--cold-address must be a sat1… address"
  fi
  local free_mb
  free_mb=$(df -Pm / | awk 'NR==2{print $4}')
  [ "$free_mb" -ge 800 ] || die "only ${free_mb} MB free on disk; free up some space first (see: bash harden.sh check)"
  if [ $YES = 0 ]; then
    check
    echo; read -r -p "Go ahead? Mining pauses for about a minute. [y/N] " a
    [[ "$a" =~ ^[Yy] ]] || exit 0
  fi
  local TS BK
  TS=$(date +%Y%m%d-%H%M%S)
  BK=/root/saturn-backup-$TS
  mkdir -p "$BK"; chmod 700 "$BK"
  echo "backups of everything replaced: $BK"

  step "1. Packages"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban certbot python3-certbot-nginx jq rsync >/dev/null
  ok "fail2ban, certbot, jq installed"

  step "2. Download and check the new pool software"
  local NEW=$BK/new-pool
  mkdir -p "$NEW/public"
  for f in stratum.js payout.js public/index.html SHA256SUMS; do curl -fsSL "$DIST/pool/$f" -o "$NEW/$f"; done
  (cd "$NEW" && sha256sum -c --quiet SHA256SUMS) || die "downloaded pool files don't match their SHA256SUMS"
  ok "stratum.js, payout.js, website downloaded and verified"

  step "3. Users"
  id saturn >/dev/null 2>&1 || useradd --system --home-dir $NODE_HOME --shell /usr/sbin/nologin --user-group saturn
  id saturnpool >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --user-group saturnpool
  id saturnpay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --user-group saturnpay
  usermod -aG saturnpool saturnpay   # payouts read rounds.json, the pool reads payouts.json
  ok "users saturn, saturnpool, saturnpay"

  step "4. Stop mining for a moment"
  pm2 save --force >/dev/null 2>&1 || true
  cp -a /root/.pm2/dump.pm2 "$BK/pm2-dump.pm2" 2>/dev/null || true
  for app in saturn-stratum saturn-payout saturn-pool; do pm2 stop "$app" >/dev/null 2>&1 || true; done
  systemctl stop saturn-stratum saturn-payout 2>/dev/null || true
  ok "pool stopped"

  step "5. Saturn Core → user saturn ($NODE_HOME)"
  cp -a /etc/systemd/system/saturn.service "$BK/saturn.service"
  if [ ! -L "$OLD_DATADIR" ]; then
    systemctl stop saturn
    mkdir -p $NODE_HOME
    rsync -a "$OLD_DATADIR/" "$NODE_HOME/"
    mv "$OLD_DATADIR" "$BK/dot-saturn"
    ln -s $NODE_HOME "$OLD_DATADIR"   # so `saturn-cli` as root keeps working
    ok "data copied; the old folder is kept at $BK/dot-saturn"
  else
    systemctl stop saturn || true
    ok "already moved"
  fi
  chown -R saturn:saturn $NODE_HOME
  chmod 700 $NODE_HOME
  local CONF=$NODE_HOME/saturn.conf
  cp -a "$CONF" "$BK/saturn.conf"
  # fresh node logins for the pool and the payouts, each limited to the calls it needs
  local POOL_PW PAY_PW
  POOL_PW=$(randpw); PAY_PW=$(randpw)
  sed -i '/^rpcauth=saturnpool:/d;/^rpcauth=saturnpay:/d;/^rpcwhitelist/d;/^# Saturn service logins/d' "$CONF"
  {
    echo "# Saturn service logins (harden.sh $TS): the pool can only mine, the payouts can only pay"
    rpcauth_line saturnpool "$POOL_PW"
    rpcauth_line saturnpay "$PAY_PW"
    echo "rpcwhitelistdefault=0"
    echo "rpcwhitelist=saturnpool:getblocktemplate,submitblock,getmininginfo,getnetworkhashps,validateaddress,scantxoutset,sendrawtransaction,getblockheader,getblockhash,getblockcount,getbestblockhash"
    echo "rpcwhitelist=saturnpay:getblockcount,getblockhash,getbalances,sendmany,sendtoaddress,walletpassphrase,walletlock,getwalletinfo,getaddressinfo,validateaddress"
  } >> "$CONF"
  chown saturn:saturn "$CONF"; chmod 600 "$CONF"
  cat > /etc/systemd/system/saturn.service <<EOF
[Unit]
Description=Saturn Core node
After=network-online.target
Wants=network-online.target

[Service]
User=saturn
Group=saturn
ExecStart=$SATURND -daemon=0 -datadir=$NODE_HOME -dnsseed=0
# saturnd shuts down cleanly on SIGTERM; give it time to flush the chain to disk
TimeoutStopSec=600
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$NODE_HOME

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl start saturn
  local i
  for i in $(seq 120); do "$CLI_BIN" -datadir=$NODE_HOME getblockcount >/dev/null 2>&1 && break; sleep 1; done
  "$CLI_BIN" -datadir=$NODE_HOME getblockcount >/dev/null 2>&1 || die "Saturn Core didn't come back up; see: journalctl -u saturn -n 50  (undo: bash harden.sh rollback)"
  ok "Saturn Core running as saturn, at block $("$CLI_BIN" -datadir=$NODE_HOME getblockcount)"
  "$CLI_BIN" -datadir=$NODE_HOME -rpcuser=saturnpool -rpcpassword="$POOL_PW" getblockcount >/dev/null || die "the pool's new node login doesn't work"
  "$CLI_BIN" -datadir=$NODE_HOME -rpcuser=saturnpool -rpcpassword="$POOL_PW" -rpcwallet=$WALLET getbalances >/dev/null 2>&1 && die "the pool login can reach the wallet; it shouldn't"
  ok "pool login works and can't touch the wallet; payout login can only pay"

  step "6. Encrypt the pool wallet"
  "$CLI_BIN" -datadir=$NODE_HOME listwallets | grep -q "\"$WALLET\"" || "$CLI_BIN" -datadir=$NODE_HOME loadwallet $WALLET >/dev/null
  local PASSPHRASE="" NEWPASS=0
  mkdir -p $POOL_ETC
  if [ -f $POOL_ETC/payout.json ]; then PASSPHRASE=$(jq -r '.walletPassphrase // ""' $POOL_ETC/payout.json); fi
  if "$CLI_BIN" -datadir=$NODE_HOME -rpcwallet=$WALLET getwalletinfo | jq -e 'has("unlocked_until")' >/dev/null; then
    [ -n "$PASSPHRASE" ] && ok "$WALLET is already encrypted" || warn "$WALLET is encrypted but its passphrase isn't in $POOL_ETC/payout.json: add \"walletPassphrase\" there or payouts can't pay"
  else
    PASSPHRASE=$(randpw)
    # save it for the payout service before encrypting, so it can never be lost in between
    jq -n --arg pass "$PASSPHRASE" '{walletPassphrase:$pass}' > $POOL_ETC/payout.json; chmod 600 $POOL_ETC/payout.json
    cp -a $POOL_ETC/payout.json "$BK/wallet-passphrase.json"
    "$CLI_BIN" -datadir=$NODE_HOME -rpcwallet=$WALLET encryptwallet "$PASSPHRASE" >/dev/null
    NEWPASS=1
    ok "$WALLET encrypted. Its passphrase: ${bold}$PASSPHRASE${off}  (shown again at the end; write it down)"
  fi

  step "7. Pool software → $POOL_CODE, data → $POOL_DATA"
  mkdir -p $POOL_CODE/public $POOL_DATA $BACKUPS
  install -m 644 "$NEW/stratum.js" "$NEW/payout.js" $POOL_CODE/
  install -m 644 "$NEW/public/index.html" $POOL_CODE/public/
  [ -f $OLD_POOL/package.json ] && install -m 644 $OLD_POOL/package.json $POOL_CODE/
  rsync -a --delete $OLD_POOL/node_modules/ $POOL_CODE/node_modules/
  chown -R root:root $POOL_CODE; chmod -R go-w $POOL_CODE
  if [ -d $OLD_POOL/data ] && [ ! -e $POOL_DATA/.moved ]; then
    cp -a $OLD_POOL/data "$BK/pool-data"
    rsync -a --exclude '*.bak' --exclude '*.before-*' $OLD_POOL/data/ $POOL_DATA/
    touch $POOL_DATA/.moved
  fi
  chown -R saturnpool:saturnpool $POOL_DATA
  chmod 2770 $POOL_DATA
  find $POOL_DATA -type f -exec chmod 660 {} +
  # settings: the pool's file, and a payouts-only file holding the wallet passphrase
  [ -f $OLD_POOL/config.json ] && cp -a $OLD_POOL/config.json "$BK/config.json"
  local SRC=$OLD_POOL/config.json
  [ -f $POOL_ETC/config.json ] && SRC=$POOL_ETC/config.json
  jq --arg pw "$POOL_PW" --arg data "$POOL_DATA" --arg web "$POOL_CODE/public" \
    'del(.webPort) | .rpc = {host:"127.0.0.1", port:9998, user:"saturnpool", password:$pw} | .dataDir=$data | .webRoot=$web | .payoutWallet=(.payoutWallet // "vps-wallet")' \
    "$SRC" > $POOL_ETC/config.json.new
  mv $POOL_ETC/config.json.new $POOL_ETC/config.json
  chown root:saturnpool $POOL_ETC/config.json; chmod 640 $POOL_ETC/config.json
  local prev_cold=""
  [ -f $POOL_ETC/payout.json ] && prev_cold=$(jq -r '.coldAddress // ""' $POOL_ETC/payout.json)
  jq -n --arg pw "$PAY_PW" --arg pass "$PASSPHRASE" --arg cold "${COLD:-$prev_cold}" \
    '{rpc:{user:"saturnpay", password:$pw}, walletPassphrase:$pass} + (if $cold != "" then {coldAddress:$cold} else {} end)' > $POOL_ETC/payout.json.new
  mv $POOL_ETC/payout.json.new $POOL_ETC/payout.json
  chown root:saturnpay $POOL_ETC/payout.json; chmod 640 $POOL_ETC/payout.json
  chmod 755 $POOL_ETC
  ok "settings in $POOL_ETC (the passphrase file is readable by payouts only)"

  step "8. Services"
  local common="NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$POOL_DATA
UMask=0007
Restart=always
RestartSec=5"
  cat > /etc/systemd/system/saturn-stratum.service <<EOF
[Unit]
Description=Saturn Pool (stratum, website and API)
After=network-online.target saturn.service
Wants=network-online.target

[Service]
User=saturnpool
Group=saturnpool
WorkingDirectory=$POOL_CODE
Environment=SATURN_POOL_CONFIG=$POOL_ETC/config.json
ExecStart=$NODE_BIN $POOL_CODE/stratum.js
LimitNOFILE=65536
$common

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/saturn-payout.service <<EOF
[Unit]
Description=Saturn Pool payouts
After=saturn.service saturn-stratum.service

[Service]
User=saturnpay
# its own group reads the passphrase file; saturnpool lets it share the pool's data folder
Group=saturnpay
SupplementaryGroups=saturnpool
WorkingDirectory=$POOL_CODE
Environment=SATURN_POOL_CONFIG=$POOL_ETC/config.json
Environment=SATURN_PAYOUT_CONFIG=$POOL_ETC/payout.json
ExecStart=$NODE_BIN $POOL_CODE/payout.js
$common

[Install]
WantedBy=multi-user.target
EOF
  mkdir -p /etc/systemd/journald.conf.d
  printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/saturn.conf
  systemctl restart systemd-journald
  systemctl daemon-reload
  systemctl enable saturn-stratum saturn-payout >/dev/null 2>&1
  systemctl restart saturn-stratum saturn-payout   # (re)start with the new node logins
  for app in saturn-stratum saturn-payout saturn-pool; do pm2 delete "$app" >/dev/null 2>&1 || true; done
  pm2 save --force >/dev/null 2>&1 || true
  pm2 flush >/dev/null 2>&1 || true
  sleep 5
  systemctl is-active --quiet saturn-stratum || die "stratum didn't start: journalctl -u saturn-stratum -n 50  (undo: bash harden.sh rollback)"
  systemctl is-active --quiet saturn-payout || die "payouts didn't start: journalctl -u saturn-payout -n 50"
  curl -fsS --max-time 5 http://127.0.0.1:8081/stats >/dev/null || die "the pool API isn't answering on 8081"
  ok "stratum and payouts running under systemd; mining is back"
  # the website auto-update, pointed at the new place
  cat > /usr/local/sbin/saturn-update-site <<EOF
#!/bin/sh
# keeps the pool website current with the published one
tmp=\$(mktemp) && curl -fsSL --max-time 30 "https://raw.githubusercontent.com/saturn-cash/saturn-core/dist/pool/public/index.html" -o "\$tmp" && grep -q '<html' "\$tmp" && install -m 644 "\$tmp" $POOL_CODE/public/index.html; rm -f "\$tmp"
EOF
  chmod 755 /usr/local/sbin/saturn-update-site
  { crontab -l 2>/dev/null | grep -v 'update-site' || true; echo "*/5 * * * * /usr/local/sbin/saturn-update-site"; } | crontab -
  ok "website auto-update moved to /usr/local/sbin/saturn-update-site"

  step "9. HTTPS for $DOMAIN"
  local conflicts
  conflicts=$(grep -Rls "server_name[^;]*\b$DOMAIN\b" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -v "/$DOMAIN\$" || true)
  for f in $conflicts; do
    cp -aL "$f" "$BK/nginx-$(basename "$f")"
    if grep -E "server_name" "$f" | grep -qvE "server_name[[:space:]]+$DOMAIN;"; then
      warn "$f also serves other names; leaving it, but it may answer for $DOMAIN too (saved a copy in $BK)"
    else
      rm -f "$f"; warn "disabled $f (it served $DOMAIN; copy in $BK)"
    fi
  done
  if [ ! -f /etc/nginx/sites-available/$DOMAIN ] || ! grep -q "saturn harden" /etc/nginx/sites-available/$DOMAIN; then
    cat > /etc/nginx/sites-available/$DOMAIN <<EOF
# saturn harden.sh: the pool website and API, through nginx (certbot adds HTTPS below)
server {
    listen 80;
$( if [ -f /proc/net/if_inet6 ]; then echo "    listen [::]:80;"; fi )
    server_name $DOMAIN;
    client_max_body_size 512k;
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 200s;
    }
}
EOF
  fi
  ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
  nginx -t >/dev/null 2>&1 || die "nginx config test failed: nginx -t"
  systemctl reload nginx
  if [ -d /etc/letsencrypt/live/$DOMAIN ]; then
    ok "certificate already there"
  elif certbot --nginx -d $DOMAIN --non-interactive --agree-tos --register-unsafely-without-email --redirect >/dev/null 2>&1; then
    ok "HTTPS certificate issued (renews itself)"
  else
    warn "certbot couldn't get a certificate (is $DOMAIN pointing at this server and port 80 open?). HTTP still works; run again later"
  fi
  if curl -fsS --max-time 10 https://$DOMAIN/stats >/dev/null 2>&1; then ok "https://$DOMAIN works"; else warn "https://$DOMAIN isn't answering yet"; fi
  cat > /etc/nginx/conf.d/saturn-security.conf <<'EOF'
# saturn harden.sh
server_tokens off;
EOF
  nginx -t >/dev/null 2>&1 && systemctl reload nginx

  step "10. Firewall"
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  ufw allow 3333/tcp >/dev/null; ufw allow 9999/tcp >/dev/null; ufw allow 8081/tcp >/dev/null
  for rule in 3000 3000/tcp 8080 8080/tcp; do ufw --force delete allow "$rule" >/dev/null 2>&1 || true; done
  ufw --force enable >/dev/null
  ok "open: 22 (ssh), 80/443 (website), 3333 (stratum), 9999 (Saturn peers), 8081 (API for older apps)"

  step "11. SSH protection and updates"
  cat > /etc/fail2ban/jail.d/saturn-sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
EOF
  systemctl enable --now fail2ban >/dev/null 2>&1; systemctl restart fail2ban
  ok "fail2ban bans an address for an hour after 5 failed SSH logins"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  ok "security updates install automatically"
  if [ $SSH_KEYS_ONLY = 1 ]; then
    [ "$(key_count)" -ge 1 ] || die "no SSH key in /root/.ssh/authorized_keys; not turning off passwords"
    cat > /etc/ssh/sshd_config.d/10-saturn.conf <<'EOF'
# saturn harden.sh: keys only
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
    sshd -t && systemctl reload ssh
    ok "SSH: keys only (password logins off)"
  else
    warn "SSH still accepts passwords (fail2ban guards it). Once you've logged in with your SSH key, run again with --ssh-keys-only"
  fi

  step "12. Wallet backups"
  mkdir -p $BACKUPS $NODE_HOME/backups; chmod 700 $BACKUPS; chown saturn:saturn $NODE_HOME/backups
  cat > /etc/cron.daily/saturn-backup <<EOF
#!/bin/sh
# daily: the pool wallet (encrypted) and the pool's records; 14 days kept
d=\$(date +%F)
$CLI_BIN -datadir=$NODE_HOME -rpcwallet=$WALLET backupwallet $NODE_HOME/backups/$WALLET-\$d.dat && mv $NODE_HOME/backups/$WALLET-\$d.dat $BACKUPS/ && chmod 600 $BACKUPS/$WALLET-\$d.dat
tar -czf $BACKUPS/pool-data-\$d.tgz -C $POOL_DATA . $POOL_ETC 2>/dev/null; chmod 600 $BACKUPS/pool-data-\$d.tgz
find $BACKUPS -type f -mtime +14 -delete
EOF
  chmod 755 /etc/cron.daily/saturn-backup
  /etc/cron.daily/saturn-backup && ok "first backup made: $(ls -t $BACKUPS | head -2 | tr '\n' ' ')"

  step "Done"
  "$CLI_BIN" -datadir=$NODE_HOME getblockchaininfo | jq -r '"  chain: block \(.blocks)"'
  systemctl --no-pager --lines=0 status saturn saturn-stratum saturn-payout 2>/dev/null | grep -E '●|Active:' | sed 's/^/  /' || true
  if [ $NEWPASS = 1 ]; then
    echo
    echo "${bold}${yellow}  WALLET PASSPHRASE for $WALLET (write it down somewhere offline, then clear your screen):${off}"
    echo
    echo "      $PASSPHRASE"
    echo
    echo "  It's also in $POOL_ETC/payout.json for the payout service. Without it, a backup of the"
    echo "  wallet can't be opened. Keep a copy of $BACKUPS/$WALLET-*.dat off the server too."
  fi
  echo
  echo "  Logs:      journalctl -u saturn-stratum -f      journalctl -u saturn-payout -f"
  echo "  Payouts:   sudo -u saturnpay env SATURN_POOL_CONFIG=$POOL_ETC/config.json SATURN_PAYOUT_CONFIG=$POOL_ETC/payout.json $NODE_BIN $POOL_CODE/payout.js --status"
  echo "  Undo:      bash harden.sh rollback   (backups in $BK)"
}

# ------------------------------------------------------------------------------------------------
rollback() {
  # the originals are in the oldest backup that has them (later runs back up already-changed files)
  first() { ls -d /root/saturn-backup-*/"$1" 2>/dev/null | sort | head -1 || true; }
  local SVC CONF DUMP
  SVC=$(first saturn.service); CONF=$(first saturn.conf); DUMP=$(first pm2-dump.pm2)
  [ -n "$SVC" ] || die "no backup found in /root/saturn-backup-*"
  echo "restoring the service from $SVC"
  systemctl disable --now saturn-stratum saturn-payout 2>/dev/null || true
  systemctl stop saturn
  if [ -L "$OLD_DATADIR" ]; then
    rm "$OLD_DATADIR"
    rsync -a "$NODE_HOME/" "$OLD_DATADIR/"   # today's chain and wallets, not the old copy
    chown -R root:root "$OLD_DATADIR"
    [ -n "$CONF" ] && cp -a "$CONF" "$OLD_DATADIR/saturn.conf"
  fi
  cp -a "$SVC" /etc/systemd/system/saturn.service
  systemctl daemon-reload; systemctl start saturn
  # bring the pool's current records back to the old folder, then the old pm2 apps
  [ -d $POOL_DATA ] && rsync -a $POOL_DATA/ $OLD_POOL/data/ && chown -R root:root $OLD_POOL/data
  if [ -n "$DUMP" ]; then cp -a "$DUMP" /root/.pm2/dump.pm2 && pm2 resurrect >/dev/null 2>&1 || true; fi
  { crontab -l 2>/dev/null | grep -v saturn-update-site || true; echo "*/5 * * * * $OLD_POOL/update-site.sh"; } | crontab -
  ok "services restored. Note: $WALLET stays encrypted (passphrase in $POOL_ETC/payout.json); the old payout.js can't unlock it."
}

case "$MODE" in
  check) check ;;
  apply) apply ;;
  rollback) rollback ;;
  *) echo "usage: harden.sh check | apply [--cold-address sat1…] [--ssh-keys-only] [--yes] | rollback" >&2; exit 2 ;;
esac
