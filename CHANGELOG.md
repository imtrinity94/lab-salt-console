# Changelog - Lab Salt Console

## 1.0.0 - 2026-11-18

- First version: single page web UI on open source salt-api (rest_cherrypy, PAM login), served by nginx on the Salt master.
- Workspaces: Dashboard, Targets, Minion Keys (Accepted, Pending, Rejected, Denied), Activity (Completed, In Progress), Config (Jobs, Schedules, Pillars, File Server, Highstate).
- Run Command, Run Job and Run Highstate against a target; job detail page with per-minion returns.
- Saved targets and saved jobs are kept in the browser (localStorage); everything else is read live from Salt.
