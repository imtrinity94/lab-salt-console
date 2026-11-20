#!/bin/bash
# tools/bootstrap-master.sh - turns a fresh Ubuntu 24.04 server into a Salt master running the Lab Salt Console.
# Run as root. Safe to run again: existing settings, certificate, passwords and console data are kept.
#
#   curl -fsSLO https://raw.githubusercontent.com/imtrinity94/lab-salt-console/main/tools/bootstrap-master.sh
#   sudo API_PASSWORD='<password for the console login>' bash bootstrap-master.sh
#
# Settings (environment variables, all optional):
#   API_USER      local account used to log in to the console and salt-api (default saltapi)
#   API_PASSWORD  its password; when empty a random one is generated and saved in /root/.salt-api-credentials
#   SALT_PIN      apt pin for the salt-* packages (default 3006.*, the LTS line; empty = newest)
#   MINION_ID     id of the master's own minion (default: short host name)
#   REPO_URL      repository to install from (default https://github.com/imtrinity94/lab-salt-console.git)
#   REPO_REF      branch or tag to install (default main)
# What it does: Salt package repository and pin; salt-master, salt-api, salt-minion, nginx, git and Node.js;
# master settings (PAM external auth for API_USER, rest_cherrypy on 127.0.0.1:8000); the login account;
# a self-signed TLS certificate; the console in /opt/salt-ui; accepts the master's own minion key;
# then tools/install-server.sh (presence events, nginx site, console service).
# Log: /var/log/salt-console-bootstrap.log
set -eo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
# cloud-init and some automation tools run scripts without HOME, which git needs
export HOME="${HOME:-/root}"
. /etc/os-release
[ "$ID" = ubuntu ] || echo "WARNING: written for Ubuntu 24.04, this is $PRETTY_NAME"

API_USER=${API_USER:-saltapi}
SALT_PIN=${SALT_PIN-3006.*}
MINION_ID=${MINION_ID:-$(hostname -s)}
REPO_URL=${REPO_URL:-https://github.com/imtrinity94/lab-salt-console.git}
REPO_REF=${REPO_REF:-main}
APP=/opt/salt-ui
MYIP=$(hostname -I | awk '{print $1}')
FQDN=$(hostname -f 2>/dev/null || hostname)
export DEBIAN_FRONTEND=noninteractive
exec > >(tee -a /var/log/salt-console-bootstrap.log) 2>&1
step() { echo; echo "== $(date '+%F %T') $*"; }

step "1/8 Salt package repository (pin: ${SALT_PIN:-none})"
apt-get update -y
apt-get install -y curl ca-certificates git openssl
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://packages.broadcom.com/artifactory/api/security/keypair/SaltProjectKey/public -o /etc/apt/keyrings/salt-archive-keyring.pgp
curl -fsSL https://github.com/saltstack/salt-install-guide/releases/latest/download/salt.sources -o /etc/apt/sources.list.d/salt.sources
if [ -n "$SALT_PIN" ]; then
  printf 'Package: salt-*\nPin: version %s\nPin-Priority: 1001\n' "$SALT_PIN" > /etc/apt/preferences.d/salt-pin-1001
fi
apt-get update -y

step "2/8 packages"
apt-get install -y salt-master salt-api salt-minion nginx nodejs
salt-call --version

step "3/8 console files in $APP ($REPO_URL, $REPO_REF)"
if [ -d "$APP/.git" ]; then
  echo "$APP is already a git checkout; leaving it as it is (update it with git pull)"
else
  if [ -e "$APP" ]; then mv "$APP" "$APP.before-console.$(date +%Y%m%d%H%M%S)"; echo "moved the existing $APP aside"; fi
  git clone --branch "$REPO_REF" "$REPO_URL" "$APP"
fi
git config --global --add safe.directory "$APP"

step "4/8 master settings"
mkdir -p /etc/salt/master.d /etc/salt/minion.d /srv/salt /srv/pillar
if [ ! -f /etc/salt/master.d/lab.conf ]; then
  sed "s/^    saltapi:/    $API_USER:/" "$APP/master-lab.conf" > /etc/salt/master.d/lab.conf
  echo "wrote /etc/salt/master.d/lab.conf (external auth for $API_USER)"
else
  echo "/etc/salt/master.d/lab.conf exists; kept"
fi
[ -f /etc/salt/minion.d/lab.conf ] || printf 'master: 127.0.0.1\nid: %s\n' "$MINION_ID" > /etc/salt/minion.d/lab.conf
if [ ! -f /srv/salt/lab/motd.sls ]; then
  mkdir -p /srv/salt/lab
  printf '# Sample state: sudo salt "*" state.apply lab.motd\nlab_motd:\n  file.managed:\n    - name: /etc/motd\n    - contents: This host is managed by the lab Salt master.\n' > /srv/salt/lab/motd.sls
fi

step "5/8 login account $API_USER"
id "$API_USER" >/dev/null 2>&1 || useradd -M -s /usr/sbin/nologin "$API_USER"
if [ -n "$API_PASSWORD" ]; then
  echo "$API_USER:$API_PASSWORD" | chpasswd
  printf 'url=https://%s/\nusername=%s\npassword=%s\n' "$MYIP" "$API_USER" "$API_PASSWORD" > /root/.salt-api-credentials
elif [ ! -f /root/.salt-api-credentials ]; then
  API_PASSWORD=$(openssl rand -hex 12)
  echo "$API_USER:$API_PASSWORD" | chpasswd
  printf 'url=https://%s/\nusername=%s\npassword=%s\n' "$MYIP" "$API_USER" "$API_PASSWORD" > /root/.salt-api-credentials
  echo "generated a password for $API_USER: see /root/.salt-api-credentials"
else
  echo "password unchanged (see /root/.salt-api-credentials)"
fi
chmod 600 /root/.salt-api-credentials

step "6/8 TLS certificate"
if [ ! -f /etc/ssl/certs/salt-ui.crt ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 -subj "/CN=$FQDN" \
    -addext "subjectAltName=DNS:$FQDN,DNS:$(hostname -s),IP:$MYIP" \
    -keyout /etc/ssl/private/salt-ui.key -out /etc/ssl/certs/salt-ui.crt
  chmod 600 /etc/ssl/private/salt-ui.key
  echo "created a self-signed certificate for $FQDN / $MYIP (replace it with a CA-signed one when you have one)"
else
  echo "certificate exists; kept"
fi

step "7/8 Salt services and the master's own minion key"
systemctl enable salt-master salt-api salt-minion nginx
systemctl restart salt-master
sleep 10
systemctl restart salt-api
systemctl restart salt-minion
for _ in $(seq 1 30); do
  if salt-key -l acc 2>/dev/null | grep -qx "$MINION_ID"; then break; fi
  if salt-key -l un 2>/dev/null | grep -qx "$MINION_ID"; then salt-key -y -a "$MINION_ID"; break; fi
  sleep 4
done

step "8/8 console service and nginx site"
bash "$APP/tools/install-server.sh"

sleep 5
PING=$(salt --out=txt "$MINION_ID" test.ping 2>/dev/null | tr -d '\n' || true)
LOGIN=$(curl -s -o /dev/null -w '%{http_code}' -H 'Accept: application/json' -d "username=$API_USER" \
  -d "password=$(grep '^password=' /root/.salt-api-credentials | cut -d= -f2-)" -d eauth=pam http://127.0.0.1:8000/login || true)
echo
echo "Done. Salt $(salt-call --version | awk '{print $2}'), local minion [$PING], salt-api login HTTP $LOGIN"
echo "Console:  https://$MYIP/   (user $API_USER, password in /root/.salt-api-credentials)"
echo "Sample data mode: https://$MYIP/?demo=1"
