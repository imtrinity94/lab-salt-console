# Changelog - Lab Salt Console

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
