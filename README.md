# Lab Salt Console

A web console for open source [Salt](https://saltproject.io/), styled after the Clarity design system. It runs on the
Salt master behind nginx.

![Lab Salt Console dashboard](docs/images/02-dashboard.png)

It has two parts:

- **The console** (`www/`): static HTML, CSS and JavaScript. Everything that reads or changes Salt goes directly to
  `salt-api` (rest_cherrypy), so Salt itself checks what each user may do.
- **The console service** (`server/console_api.py`): a small Python service that runs with the Python shipped with
  Salt and keeps its data in one SQLite file. It listens on the master's event bus and records presence, job outcomes,
  an audit trail and notifications. It stores the shared saved targets, saved jobs and settings, and it runs console
  schedules.

It is built for lab and proof-of-concept use. This is an independent project, not affiliated with, endorsed by or part
of VMware, Broadcom or the commercial Salt products. It follows the general layout of those consoles, on top of plain
open source Salt.

Current version: see [CHANGELOG.md](CHANGELOG.md). Tested with Salt 3006 LTS on Ubuntu 24.04.

## Quick start

On a fresh Ubuntu 24.04 VM:

```bash
curl -fsSLO https://raw.githubusercontent.com/imtrinity94/lab-salt-console/main/tools/bootstrap-master.sh
```

```bash
sudo API_PASSWORD='ChooseAStrongPassword1' bash bootstrap-master.sh
```

Then open `https://<vm ip>/` and log in as `saltapi`. To explore every screen with sample data, without a login, open
`https://<vm ip>/?demo=1`.

**[docs/SETUP.md](docs/SETUP.md)** is the full guide, with screenshots. It covers:

- what gets installed;
- three ways to install: one command, the VCF Automation template, or step by step;
- a tour of the console;
- adding minions;
- updates, backups and certificates;
- troubleshooting, uninstalling, and releasing.

## What it does

| Area | What you get | Backed by |
|---|---|---|
| Dashboard | Key and minion counts, recent jobs, and charts of Salt events, minion presence and job outcomes over 1 to 24 hours | salt-api, console service |
| Reports | Key state, minion version, OS version and Salt master version, each with a chart, table and CSV / JSON download | keys, grains |
| Targets | All Minions plus shared glob, list, grain and compound targets; Minions, Highstate, Activity and Edit tabs per target | grains, job cache, console service |
| Minions | Minion list with presence (Present / Disconnected / Unknown) and Needs Reboot (Debian / Ubuntu); Details, Grains, Pillar, Packages, Activity and Targets tabs per minion | grains, `pillar.items`, `pkg.list_pkgs`, console service |
| Minion Keys | Accepted, Pending, Rejected and Denied; accept, reject and delete | wheel `key.*` |
| Activity | Completed (status, origin, Success / Failed / Not Returned), In Progress and Upcoming; a page per job with per-minion returns, JSON download and Stop Job | job cache, `saltutil.term_job`, console service |
| Jobs | Shared saved jobs: `salt` or `salt-run`, target, function, environment, states, arguments, pillar override, run as test | `local_async`, `runner_async`, console service |
| Schedules | Console schedules (recurring, once, or cron in their own time zone) that run saved jobs, with Run Now; minion-side schedules on a second tab | console service, `schedule.*` |
| Pillars | Pillar data per minion; edit pillar files | `pillar.items`, wheel `pillar_roots.*` |
| File Server | Browse, edit, rename and delete state files per saltenv | wheel `file_roots.*` |
| Highstate | States, Minions and Activity tabs, Limit by period, a chart of runs with and without changes, state drill-down | job cache |
| Notifications | Bell listing failed jobs, new pending keys, minions that disconnect and schedules that could not run | console service |
| Settings | Theme, automatic logout, items per page, login banner, presence expiration, console service status | browser storage, files on the master |
| Administration | Audit log of jobs and runner / wheel calls with the Salt user, plus changes made in the console (kept 90 days) | console service |
| Compliance | Shown as Coming soon; not part of this version | |

Every table has sorting, per-column filters, paging and show / hide columns.

| | |
|---|---|
| ![Minions](docs/images/03-minions.png) | ![Completed jobs and notifications](docs/images/12-notifications.png) |
| ![Schedules](docs/images/08-schedules.png) | ![Highstate](docs/images/09-highstate.png) |

### How the console service works

- **Login.** One login form signs you in to salt-api and to the console service. The service checks the same PAM
  password through Salt's external auth and issues a Salt eauth token, which it checks against the master's token store
  on every request. salt-api's own login returns a web session id that the service cannot check, which is why the
  service has a login of its own.
- **Presence.** With `presence_events: True`, the master reports its connected minions every 60 seconds. A minion is:
  - **Present** if it was reported connected, or returned job data, within the presence expiration (default 300
    seconds, set under Settings > Console Service);
  - **Disconnected** if it was seen before but not since;
  - **Unknown** if it has never been seen.
- **Schedules.** The service checks for due runs every 10 seconds. A due run publishes the saved job as root through
  Salt's LocalClient (or RunnerClient for `salt-run` jobs), so the job cache shows the user `root`. The Origin column
  and the audit log name the schedule that started it. A run found more than 5 minutes late (because the service was
  down) is skipped and recorded, never started late.
- **Read calls are not jobs.** The console's own page reads (grains, key lists, job cache reads, and the pings that
  `manage.status` sends) are left out of the audit log, job metrics and notifications.
- **Retention.** Event and presence counts, job outcomes, schedule runs and notifications are kept for 30 days; the
  audit log for 90 days.
- **If the service is down,** everything that talks directly to Salt keeps working, and pages that need the service
  say so.

### Known limits

- There is no role-based access control: whoever logs in gets the rights the master's `external_auth` gives that
  user. It is meant for POCs only.
- The service runs as root and its code lives in `/opt/salt-ui`, so anyone who can write there can change what runs
  as root.
- The Compliance and Vulnerability content of commercial consoles (CIS / STIG benchmarks, vendor advisory feeds) is
  licensed and not included.

## Repository layout

```
www/                       the console: index.html, app.css and one script per area (load order in tools/scripts.txt)
server/console_api.py      the console service
server/*.conf, *.service   nginx site, master setting and systemd unit installed by tools/install-server.sh
tools/bootstrap-master.sh  turns a fresh Ubuntu 24.04 VM into a Salt master running the console
tools/install-server.sh    installs or updates the console service, nginx site and master setting
tools/release.sh           release: version, script tags, changelog, checks, commit, tag, push
test/smoke.js              renders every page outside a browser, on sample data and against the live master
test/extra.json            extra pages for the smoke test
test/api_test.py           checks the console service end to end and removes everything it creates
docs/SETUP.md              setup and operations guide; screenshots in docs/images
master-lab.conf            Salt master settings used by the install
CHANGELOG.md               every release, newest first
```

## Releasing

Releases are made on the master. See [docs/SETUP.md, section 11](docs/SETUP.md#11-develop-and-release). In short,
write the notes in `CHANGELOG.new`, then run:

```bash
API_PW='<console password>' bash tools/release.sh <version>
```

The release stops unless the syntax checks, the smoke tests (on sample data and live) and the console service tests
all pass. Test jobs only touch the master's own minion (`test.ping`, and `manage.up` on the master).

Versions follow semantic versioning: a minor version for new features, a patch version for fixes.
