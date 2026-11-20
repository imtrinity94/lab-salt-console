#!/bin/bash
# tools/install-server.sh - installs or updates the console service on this Salt master. Run as root. Safe to run again.
#  - /etc/salt/master.d/console.conf (presence events); restarts salt-master and salt-api only when it changed
#  - nginx site with the web root, /salt-api/ and /console-api/; enables it, and reloads nginx when it changed
#  - systemd unit salt-console; always restarts the service so code changes take effect
# Needs the TLS certificate at /etc/ssl/certs/salt-ui.crt and its key at /etc/ssl/private/salt-ui.key
# (tools/bootstrap-master.sh creates a self-signed pair on a new master).
set -eo pipefail
cd "$(dirname "$0")/.."
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
/opt/saltstack/salt/bin/python3.11 -m py_compile server/console_api.py && rm -rf server/__pycache__
install -d -m 700 /var/lib/salt-console
changed() { ! cmp -s "$1" "$2"; }
if changed server/master-console.conf /etc/salt/master.d/console.conf; then
  install -m 644 server/master-console.conf /etc/salt/master.d/console.conf
  echo "master settings changed: restarting salt-master and salt-api"
  systemctl restart salt-master
  sleep 15
  systemctl restart salt-api
fi
SITE=/etc/nginx/sites-available/salt-ui
if changed server/nginx-salt-ui.conf "$SITE" || [ ! -e /etc/nginx/sites-enabled/salt-ui ]; then
  [ -f "$SITE" ] && cp "$SITE" "$SITE.bak"
  install -m 644 server/nginx-salt-ui.conf "$SITE"
  ln -sf "$SITE" /etc/nginx/sites-enabled/salt-ui
  rm -f /etc/nginx/sites-enabled/default
  if nginx -t 2>/dev/null; then
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
    echo "nginx updated"
  else
    if [ -f "$SITE.bak" ]; then cp "$SITE.bak" "$SITE"; fi
    nginx -t
    exit 1
  fi
fi
install -m 644 server/salt-console.service /etc/systemd/system/salt-console.service
systemctl daemon-reload
systemctl enable salt-console >/dev/null 2>&1
systemctl restart salt-console
for _ in $(seq 1 20); do
  if curl -s -m 2 http://127.0.0.1:8001/health | grep -q '"ok": true'; then curl -s http://127.0.0.1:8001/health; echo; exit 0; fi
  sleep 1
done
echo "salt-console did not answer on 127.0.0.1:8001"; journalctl -u salt-console -n 30 --no-pager; exit 1
