# Lab Salt Console

A web console for open source [Salt](https://saltproject.io/), styled after the Clarity design system. It talks straight to
`salt-api` (rest_cherrypy) on the Salt master and is served by nginx on the same host. There is no server-side code of its own:
the console is static HTML, CSS and JavaScript.

Built for lab and proof-of-concept use. It is an independent project and is not affiliated with, endorsed by or a part of
VMware, Broadcom, or the commercial Salt products; it mimics the general layout of such consoles on top of plain open source Salt.

Current version: see [CHANGELOG.md](CHANGELOG.md). Tested with Salt 3006 LTS on Ubuntu 24.04.

## What it does

| Area | What you get | Backed by |
|---|---|---|
| Dashboard | Accepted and pending keys, minions up and down, recent jobs | `key.list_all`, `manage.status`, job cache |
| Reports | Key State, Minion version, OS version, Salt master version; chart, table, CSV / JSON download | keys, grains |
| Targets | All Minions plus your own glob, list, grain and compound targets; per-target Minions / Highstate / Activity / Edit tabs | `grains.items`, job cache |
| Minions | Minion list with presence and Needs Reboot (Debian / Ubuntu); per-minion Details, Grains, Pillar, Packages, Activity, Targets | grains, `pillar.items`, `pkg.list_pkgs` |
| Minion Keys | Accepted, Pending, Rejected, Denied; accept, reject and delete | wheel `key.*` |
| Activity | Completed (status, Success / Failed / Not Returned) and In Progress; job page with per-minion returns, JSON download, Stop Job | job cache, `saltutil.term_job` |
| Jobs | Saved jobs: `salt` or `salt-run`, target, function, environment, states, arguments, pillar override, run as test | `local_async`, `runner_async` |
| Schedules | List, add and delete schedules on minions | `schedule.*` |
| Pillars | Pillar data per minion; edit pillar files | `pillar.items`, wheel `pillar_roots.*` |
| File Server | Browse, edit, rename and delete state files per saltenv | wheel `file_roots.*` |
| Highstate | States / Minions / Activity tabs, Limit by period, changes vs no changes trend chart, state drill-down | job cache |
| Settings | Light / dark theme, automatic logout, items per page, login banner | browser storage, one file on the master |

Every table has sorting, per-column filters, paging and show / hide columns.

### Known limits

- Saved targets and saved jobs live in the browser (localStorage), so another browser does not see them.
- Presence is "answered just now" (`manage.status`), not a history.
- No role-based access control: whoever logs in has the rights the master's `external_auth` gives that user.
- Compliance and Vulnerability features of commercial consoles are not included; they depend on licensed content.

## Install on a Salt master

Prerequisites: `salt-master`, `salt-api` and `nginx` on the master, and a local account for logging in through PAM.

1. Copy the repository to `/opt/salt-ui`.
2. Salt master settings: use [master-lab.conf](master-lab.conf) as `/etc/salt/master.d/lab.conf`. It enables PAM external auth
   for the user `saltapi`, the netapi clients the console uses, and `rest_cherrypy` on `127.0.0.1:8000` without TLS
   (nginx terminates TLS). Change the user name to yours. It also keeps job results for 30 days (`keep_jobs_seconds`),
   which the Highstate history views rely on.
3. nginx: use [nginx-salt-ui.conf](nginx-salt-ui.conf) as `/etc/nginx/sites-available/salt-ui`, enable it, and point
   `ssl_certificate` / `ssl_certificate_key` at your certificate. It serves `www/` and proxies `/salt-api/` to salt-api.
4. Restart `salt-master`, `salt-api` and `nginx`, then open `https://<master>/` and log in with the PAM user.

The master runs as root (`user: root` in the sample config) because PAM authentication needs it.

## Sample data mode

Open `https://<master>/?demo=1` to explore every screen with built-in sample data. No login is needed and no call reaches
salt-api. Remove `?demo=1` to work with the real master.

## Repository layout

```
www/            the console (index.html, app.css and one script per area; load order in tools/scripts.txt)
test/smoke.js   renders every route outside a browser, against sample data and against the live salt-api
test/extra.json extra routes for the smoke test
tools/release.sh  release script: version, script tags, changelog, checks, commit, tag, push
master-lab.conf   sample Salt master settings
nginx-salt-ui.conf  sample nginx site
CHANGELOG.md    every release, newest first
```

## Releasing

On the master, with Node.js installed for the checks:

```
cd /opt/salt-ui
```

```
API_PW='<salt-api password>' bash tools/release.sh 1.4.0
```

The script sets the version, rebuilds the script tags in `index.html` from `tools/scripts.txt`, merges `CHANGELOG.new`
into `CHANGELOG.md`, runs `node --check` on every script and the smoke test on sample data and on the live master, and
stops if anything fails. It then commits, tags `v<version>` and pushes to `origin`.

Versions follow semantic versioning: minor for new features, patch for fixes.
