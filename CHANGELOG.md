# Changelog - Lab Salt Console

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
