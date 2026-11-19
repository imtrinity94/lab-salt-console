#!/bin/bash
# tools/release.sh <version>
# Sets the version, rebuilds the script list in index.html from tools/scripts.txt, merges CHANGELOG.new,
# runs the syntax and smoke checks (sample data and live; live needs API_PW) and the console service checks,
# then commits, tags and pushes to origin. Install service changes first with: sudo bash tools/install-server.sh
set -eo pipefail
V="$1"
cd /opt/salt-ui
sed -i "s/^const VERSION = '.*';/const VERSION = '$V';/" www/app.js
python3 - "$V" <<'PY'
import os, re, sys
v = sys.argv[1]
scripts = [l.strip() for l in open('tools/scripts.txt') if l.strip()]
h = open('www/index.html').read()
tags = ''.join('<script src="%s?v=%s"></script>\n' % (s, v) for s in scripts)
h = re.sub(r'(?:<script src="[^"]+"></script>\s*)+', lambda m: tags, h, count=1)
h = re.sub(r'app\.css\?v=[0-9.]+', 'app.css?v=' + v, h)
open('www/index.html', 'w').write(h)
if os.path.exists('CHANGELOG.new'):
    c = open('CHANGELOG.md').read()
    n = open('CHANGELOG.new').read().strip()
    head, rest = c.split('\n\n', 1)
    open('CHANGELOG.md', 'w').write(head + '\n\n' + n + '\n\n' + rest)
    os.remove('CHANGELOG.new')
PY
for f in $(cat tools/scripts.txt); do node --check "www/$f"; done
DEMO=1 node test/smoke.js 2>&1 | grep -v -e NODE_TLS -e trace-warnings
API_PW="$API_PW" node test/smoke.js 2>&1 | grep -v -e NODE_TLS -e trace-warnings
/opt/saltstack/salt/bin/python3.11 -m py_compile server/console_api.py && rm -rf server/__pycache__
started=$(systemctl show -p ActiveEnterTimestamp --value salt-console)
if [ -z "$started" ] || [ "$(stat -c %Y server/console_api.py)" -gt "$(date -d "$started" +%s)" ]; then
  echo "The console service is not running the current server/console_api.py: run sudo bash tools/install-server.sh first"; exit 1
fi
API_PW="$API_PW" python3 test/api_test.py
git add -A
git commit -q -m "Lab Salt Console $V"
git tag "v$V"
if git remote get-url origin >/dev/null 2>&1; then
  git push origin main && git push origin "v$V" || echo "WARNING: release v$V committed and tagged locally, but the push to origin failed"
fi
git log --oneline | head -n 3
