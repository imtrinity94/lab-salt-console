# Lab Salt Console

A web console for open source [Salt](https://saltproject.io/), styled after the Clarity design system. It runs on the Salt
master behind nginx and has two parts:

- **The console** (`www/`): static HTML, CSS and JavaScript. Everything that reads or changes Salt goes straight to
  `salt-api` (rest_cherrypy), so Salt itself enforces what a user may do.
- **The console service** (`server/console_api.py`): a small Python service, run with the Python that ships with Salt and
  kept in one SQLite file. It listens on the master event bus and records presence, job outcomes, an audit trail and
  notifications; it stores the shared saved targets, saved jobs and settings; and it runs console schedules.

Built for lab and proof-of-concept use. It is an independent project and is not affiliated with, endorsed by or a part of
VMware, Broadcom, or the commercial Salt products; it mimics the general layout of such consoles on top of plain open source Salt.

Current version: see [CHANGELOG.md](CHANGELOG.md). Tested with Salt 3006 LTS on Ubuntu 24.04.

## What it does

| Area | What you get | Backed by |
|---|---|---|
| Dashboard | Key and minion counts, recent jobs, and charts of Salt events, minion presence and job outcomes over 1 to 24 hours | salt-api, console service |
| Reports | Key State, Minion version, OS version, Salt master version; chart, table, CSV / JSON download | keys, grains |
| Targets | All Minions plus shared glob, list, grain and compound targets; per-target Minions / Highstate / Activity / Edit tabs | grains, job cache, console service |
| Minions | Minion list with presence (Present / Disconnected / Unknown) and Needs Reboot (Debian / Ubuntu); per-minion Details, Grains, Pillar, Packages, Activity, Targets | grains, `pillar.items`, `pkg.list_pkgs`, console service |
| Minion Keys | Accepted, Pending, Rejected, Denied; accept, reject and delete | wheel `key.*` |
| Activity | Completed (status, origin, Success / Failed / Not Returned), In Progress, Upcoming; job page with per-minion returns, JSON download, Stop Job | job cache, `saltutil.term_job`, console service |
| Jobs | Shared saved jobs: `salt` or `salt-run`, target, function, environment, states, arguments, pillar override, run as test | `local_async`, `runner_async`, console service |
| Schedules | Console schedules (recurring, once, cron in their own time zone) that run saved jobs, with Run Now; minion-side schedules on a second tab | console service, `schedule.*` |
| Pillars | Pillar data per minion; edit pillar files | `pillar.items`, wheel `pillar_roots.*` |
| File Server | Browse, edit, rename and delete state files per saltenv | wheel `file_roots.*` |
| Highstate | States / Minions / Activity tabs, Limit by period, changes vs no changes trend chart, state drill-down | job cache |
| Notifications | Bell with failed jobs, new pending keys, minions that disconnect, schedules that could not run | console service |
| Settings | Theme, automatic logout, items per page, login banner, presence expiration, console service status | browser storage, files on the master |
| Administration | Audit Log: jobs and runner / wheel calls with the Salt user, plus console changes (90 days) | console service |
| Compliance | Shown as Coming soon; not part of this version | |

Every table has sorting, per-column filters, paging and show / hide columns.

### How the console service works

- **Login.** The one login form signs in to salt-api and to the console service. The service checks the same PAM
  credentials through Salt's external auth and issues a Salt eauth token, which it checks against the master's token store
  on every request. salt-api's own login returns a web session id, which the service cannot check, so it needs its own.
- **Presence.** `presence_events: True` makes the master report connected minions every 60 seconds. A minion is Present
  when it was reported connected, or returned job data, within the presence expiration (default 300 seconds, set under
  Settings > Console Service), Disconnected when seen before but not since, and Unknown when never seen.
- **Schedules.** Checked every 10 seconds. A due run publishes the saved job as root through Salt's LocalClient (or
  RunnerClient for `salt-run` jobs), so it shows as user `root` in the job cache; the Origin column and the audit log say
  which schedule started it. A run found more than 5 minutes late (service was down) is skipped and recorded, never run late.
- **Read calls are not jobs.** The console's own page reads (grains, key lists, job cache reads, the pings `manage.status`
  sends) are left out of the audit log, job metrics and notifications.
- **Retention.** Event and presence counts, job outcomes, schedule runs and notifications 30 days; audit log 90 days.
- **If it is down,** everything that talks straight to Salt keeps working, and the pages that need the service say so.

### Known limits

- No role-based access control: whoever logs in has the rights the master's `external_auth` gives that user. Intended for
  POCs only.
- The service runs as root and its code lives in `/opt/salt-ui`; whoever can write there can change what runs as root.
- Compliance and Vulnerability content of commercial consoles (CIS / STIG benchmarks, vendor advisory feeds) is licensed
  and not included.

## Install on a Salt master

Prerequisites: `salt-master`, `salt-api` and `nginx` on the master, and a local account for logging in through PAM.

1. Copy the repository to `/opt/salt-ui`.
2. Salt master settings: use [master-lab.conf](master-lab.conf) as `/etc/salt/master.d/lab.conf`. It enables PAM external auth
   for the user `saltapi`, the netapi clients the console uses, and `rest_cherrypy` on `127.0.0.1:8000` without TLS
   (nginx terminates TLS). Change the user name to yours. It also keeps job results for 30 days (`keep_jobs_seconds`),
   which the Highstate history views rely on. The master runs as root (`user: root`) because PAM authentication needs it.
3. Put a TLS certificate at `/etc/ssl/certs/salt-ui.crt` and its key at `/etc/ssl/private/salt-ui.key`.
4. As root, run:

```
bash /opt/salt-ui/tools/install-server.sh
```

   It installs [server/master-console.conf](server/master-console.conf) (presence events; restarts salt-master and salt-api
   only when it changed), the nginx site [server/nginx-salt-ui.conf](server/nginx-salt-ui.conf) (`www/`, `/salt-api/` and
   `/console-api/`), and the systemd unit [server/salt-console.service](server/salt-console.service), then starts the service
   and waits for it to answer. Run it again after every change under `server/`.
5. Open `https://<master>/` and log in with the PAM user.

## Sample data mode

Open `https://<master>/?demo=1` to explore every screen with built-in sample data. No login is needed and no call reaches
salt-api or the console service. Remove `?demo=1` to work with the real master.

## Repository layout

```
www/                  the console (index.html, app.css and one script per area; load order in tools/scripts.txt)
server/console_api.py the console service
server/*.conf, *.service  nginx site, master setting and systemd unit installed by tools/install-server.sh
test/smoke.js         renders every route outside a browser, against sample data and against the live master
test/extra.json       extra routes for the smoke test
test/api_test.py      checks the console service end to end and removes everything it creates
tools/install-server.sh  installs or updates the console service on the master
tools/release.sh      release script: version, script tags, changelog, checks, commit, tag, push
master-lab.conf       sample Salt master settings
CHANGELOG.md          every release, newest first
```

## Releasing

On the master, with Node.js installed for the checks. After changes under `server/`, install them first:

```
sudo bash /opt/salt-ui/tools/install-server.sh
```

Then release:

```
cd /opt/salt-ui
```

```
API_PW='<salt-api password>' bash tools/release.sh 1.4.0
```

The script sets the version, rebuilds the script tags in `index.html` from `tools/scripts.txt`, merges `CHANGELOG.new`
into `CHANGELOG.md`, runs `node --check` on every script, the smoke test on sample data and on the live master, and
`test/api_test.py` against the running console service, and stops if anything fails or if the service is not running the
current `server/console_api.py`. It then commits, tags `v<version>` and pushes to `origin`.

Test jobs only touch the master's own minion (`test.ping`, and `manage.up` on the master).

Versions follow semantic versioning: minor for new features, patch for fixes.
