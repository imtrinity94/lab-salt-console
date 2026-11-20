# Changelog - Lab Salt Console

## 1.4.1 - 2026-11-20

- Setup guide: docs/SETUP.md covers the architecture, three ways to install (one command, the VCF Automation template, step by step), a tour of the console with screenshots, adding minions, updates, backup and restore, certificates, logs, troubleshooting, uninstalling and releasing.
- tools/bootstrap-master.sh turns a fresh Ubuntu 24.04 VM into a Salt master running the console in one command. It is safe to run again: existing settings, certificate, password and console data are kept.
- tools/install-server.sh now also works on a master that has no nginx site yet: it enables the site, removes nginx's default site, and only backs up a site file that exists.
- master-lab.conf now includes keep_jobs_seconds: 2592000 (30 days), so a new master keeps the job history the Highstate views use. The lab master already had it.
- README: screenshots, a quick start, and links to the guide. Social preview image in docs/images/social-preview.png.

## 1.4.0 - 2026-11-19

- Console service on the master (server/console_api.py, systemd unit salt-console, one SQLite file in /var/lib/salt-console). It listens on the Salt event bus, keeps the console's shared data and runs schedules. Install or update it with sudo bash tools/install-server.sh.
- Login: the one login form now signs in to salt-api and to the console service, which checks the same PAM credentials and issues a Salt eauth token.
- Saved targets and saved jobs are stored on the master and shared by every browser; lists saved in a browser before 1.4.0 are moved to the master on first login. Writes are version checked, so a change made from another browser is not silently overwritten.
- Presence: Present / Disconnected / Unknown from the master's presence events (presence_events: True) and job returns, with a shared expiration setting (default 300 seconds) under Settings > Console Service.
- Schedules: console schedules (Recurring, Once, Cron in the schedule's own time zone) that run saved jobs, with Run Now, enable / disable, edit and delete; runs that come due while the service is down are skipped and recorded, never run late. Minion-side schedules stay under a second tab.
- Activity: Upcoming lists schedule runs due in the next 7 days; Completed has an Origin column (Schedule: name, or Ad-Hoc).
- Dashboard: Salt events, minion presence and job outcomes (succeeded, failed, missed returns, in progress) over 1 to 24 hours, with CSV / JSON download.
- Notifications bell: failed jobs, new pending minion keys, minions that disconnect, schedules that could not run; mark one or all as read.
- Administration > Audit Log: jobs and runner / wheel calls with the Salt user, plus console changes, kept 90 days.
- Compliance appears in the navigation marked Coming soon.
- Tests: test/api_test.py checks the service end to end (auth, version conflicts, schedule validation and time zones, Run Now for minion and salt-run jobs, origins, audit, metrics) and removes everything it creates; tools/release.sh runs it.

## 1.3.1 - 2026-11-18

- Speed: finished job results are cached for the life of the page, and the screens that read many job results read fewer of them (Activity > Completed status for the 15 most recent jobs, Highstate from up to 10 highstate jobs, minion Activity from the 15 most recent jobs). A runner call takes most of a second on the lab master, so the earlier limits made these pages slow.
- Reliability: read-only calls of any kind are retried once after an HTTP 500, and error messages now name the Salt function that failed.
- Reports: count column header now reads Minions / Keys.

## 1.3.0 - 2026-11-18

- Reports: Key State, Minion version, OS version and Salt master version, each with a chart, a filterable table and CSV / JSON download; version reports can be limited to a target.
- Minions workspace: list of all accepted minions with presence and a Needs Reboot flag (Debian and Ubuntu), and a page per minion with Details, Grains, Pillar, Packages, Activity and Targets tabs.
- Jobs: full job definition (name, description, salt or salt-run, target, function, environment, states, one argument per line, pillar override, run as test), edit and delete; salt-run jobs are submitted to the master and shown in Activity.
- Activity: Completed shows status with Success / Failed / Not Returned for the 40 most recent jobs; the job page can download the return as JSON and stop a running job.
- File Server and Pillar files: saltenv selector, rename and delete.
- Settings: light / dark theme, automatic logout, default items per page, and a login banner stored on the master.
- Reliability: runner and wheel calls to salt-api are now sent one at a time and read-only ones retried once, because concurrent runner calls can fail inside salt-api with HTTP 500. The release script now stops when a smoke test fails.

## 1.2.0 - 2026-11-18

- Target page: breadcrumb, ACTIONS menu, minion count and Minions / Highstate / Activity / Edit tabs for each target.
- Row actions on minion tables: checkbox column, three-dot row menu and expandable details; Run Highstate / Run Job / Run Command act on the ticked rows when any are selected.
- Highstate: Limit by (all time, 24 hours, 7 days, 30 days), results merged from up to 15 highstate jobs with the newest result per minion, JID columns, Activity tab with status and Success / Failed / Not Returned counts, and the minions with changes vs no changes trend chart.
- Minion Keys uses the grid selection, so ticks survive sorting and filtering.
- Master: job results are now kept for 30 days (keep_jobs_seconds).

## 1.1.0 - 2026-11-18

- Datagrid behaviour on every table: sortable columns, per-column filters, Clear Filters, items per page with paging, show/hide columns.
- Header: help/about button and user menu. Navigation: icons, collapse button, state remembered per browser.
- Sample data mode: open the console with ?demo=1 to explore it without touching the master.
- Code split into modules (grid.js, demo.js, shell.js, boot.js); tools/release.sh and test/smoke.js check every route against sample data and the live salt-api before a release is committed.

## 1.0.0 - 2026-11-18

- First version: single page web UI on open source salt-api (rest_cherrypy, PAM login), served by nginx on the Salt master.
- Workspaces: Dashboard, Targets, Minion Keys (Accepted, Pending, Rejected, Denied), Activity (Completed, In Progress), Config (Jobs, Schedules, Pillars, File Server, Highstate).
- Run Command, Run Job and Run Highstate against a target; job detail page with per-minion returns.
- Saved targets and saved jobs are kept in the browser (localStorage); everything else is read live from Salt.
