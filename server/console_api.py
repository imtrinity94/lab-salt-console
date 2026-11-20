#!/opt/saltstack/salt/bin/python3.11
"""Lab Salt Console service.

Runs on the Salt master next to salt-api, behind nginx at /console-api/. It
 - listens on the Salt event bus and records presence, job outcomes, an audit trail and notifications,
 - keeps the console's shared data (saved targets, saved jobs, settings) so every browser sees the same lists,
 - runs console schedules (recurring, once, cron) by publishing saved jobs,
 - serves dashboard metrics built from those records.
Clients log in at /login with the same PAM credentials salt-api uses and get a Salt eauth token, which every other
request carries in X-Auth-Token and which is checked against the master's own token store.
All data lives in one SQLite file (CONSOLE_DB, default /var/lib/salt-console/console.db).
Runs as root with the Python that ships with Salt, because it reads the master event bus and token store.
"""
import json
import logging
import os
import re
import shlex
import signal
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import salt.auth
import salt.client
import salt.config
import salt.runner
import salt.utils.event
from croniter import croniter

VERSION = '1.4.1'
DB_PATH = os.environ.get('CONSOLE_DB', '/var/lib/salt-console/console.db')
HOST = '127.0.0.1'
PORT = int(os.environ.get('CONSOLE_PORT', '8001'))
RETENTION_DAYS = {'event_counts': 30, 'presence_counts': 30, 'jobs_seen': 30, 'schedule_runs': 30, 'notifications': 30, 'audit': 90}
MISSED_RETURN_SEC = 600   # a job counts as "missed returns" when targeted minions are still silent this long after it started
LATE_SCHEDULE_SEC = 300   # a schedule run found this late (service was down) is skipped and recorded, never run late
DEFAULT_SETTINGS = {'presenceExpirationSec': 300}
TARGET_TYPES = ('glob', 'list', 'grain', 'compound', 'pcre', 'pillar', 'nodegroup', 'ipcidr')
# Read-only calls the console itself makes on every page. They stay out of the audit log, job metrics and notifications.
QUIET_FUN = re.compile(
    r'^(saltutil\.(find_job|running)|grains\.items?|pillar\.items|pkg\.list_pkgs|schedule\.list|file\.file_exists|test\.version|sys\.\w+'
    r'|runner\.(jobs|manage|fileserver|config)\.\w+'
    r'|wheel\.(key\.(list\w*|finger\w*|name_match)|file_roots\.(list_env|list_roots|read|find)|pillar_roots\.(list_env|list_roots|read|find)))$')

log = logging.getLogger('salt-console')
STOP = threading.Event()
STATE = {'startedAt': time.time(), 'bus': 'starting', 'events': 0, 'lastEvent': None, 'scheduler': 'starting', 'lastTick': None}
OPTS = salt.config.master_config('/etc/salt/master')
STORE = None
AUTH = None


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence (minion TEXT PRIMARY KEY, last_seen REAL NOT NULL, first_seen REAL NOT NULL);
CREATE TABLE IF NOT EXISTS event_counts (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS presence_counts (minute INTEGER PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs_seen (jid TEXT PRIMARY KEY, ts REAL NOT NULL, kind TEXT, fun TEXT, user TEXT, tgt TEXT,
  minions INTEGER NOT NULL DEFAULT 0, returned INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS jobs_seen_ts ON jobs_seen(ts);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, user TEXT, kind TEXT, action TEXT,
  target TEXT, detail TEXT, jid TEXT);
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);
CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, kind TEXT, key TEXT, text TEXT,
  link TEXT, read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS notifications_key ON notifications(key, read);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL, next_run REAL, last_run REAL, last_jid TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS schedule_runs (jid TEXT PRIMARY KEY, schedule_id TEXT, name TEXT, ts REAL NOT NULL);
"""


class Store:
    """One SQLite connection shared by all threads, serialised by a lock. WAL mode keeps readers and the writer apart."""

    def __init__(self, path):
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=30)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.execute('PRAGMA journal_mode=WAL')
            self.db.execute('PRAGMA synchronous=NORMAL')
            self.db.executescript(SCHEMA)

    def all(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.all(sql, args)
        return rows[0] if rows else None

    def run(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).lastrowid

    def tx(self):
        return _Tx(self)


class _Tx:
    def __init__(self, store):
        self.store = store

    def __enter__(self):
        self.store.lock.acquire()
        self.store.db.execute('BEGIN IMMEDIATE')
        return self.store.db

    def __exit__(self, etype, evalue, tb):
        try:
            self.store.db.execute('COMMIT' if etype is None else 'ROLLBACK')
        finally:
            self.store.lock.release()
        return False


# ---------------------------------------------------------------- helpers
def utc(t):
    return time.strftime('%Y-%m-%d %H:%M UTC', time.gmtime(t)) if t else ''


def fmt_tgt(t):
    return ','.join(str(x) for x in t) if isinstance(t, (list, tuple)) else str(t if t is not None else '')


def short(v, n=500):
    try:
        s = v if isinstance(v, str) else json.dumps(v, default=str)
    except Exception:
        s = str(v)
    return s if len(s) <= n else s[:n - 3] + '...'


def kv_get(k, default):
    r = STORE.one('SELECT v, version FROM kv WHERE k=?', (k,))
    return (json.loads(r['v']), r['version']) if r else (default, 0)


def kv_put(k, value, expect=None):
    with STORE.tx() as db:
        r = db.execute('SELECT version FROM kv WHERE k=?', (k,)).fetchone()
        cur = r[0] if r else 0
        if expect is not None and int(expect) != cur:
            raise ApiError(409, 'The %s were changed by someone else (version %d, you had %s). Reload and try again.' % (k, cur, expect))
        db.execute('INSERT INTO kv(k, v, version) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, version=excluded.version',
                   (k, json.dumps(value), cur + 1))
        return cur + 1


def settings():
    v, _ = kv_get('settings', {})
    out = dict(DEFAULT_SETTINGS)
    out.update({k: v[k] for k in DEFAULT_SETTINGS if k in v})
    return out


def audit(ts, user, kind, action, target='', detail='', jid=None):
    STORE.run('INSERT INTO audit(ts, user, kind, action, target, detail, jid) VALUES(?,?,?,?,?,?,?)',
              (ts, user, kind, action, short(target, 300), short(detail), jid))


def notify(ts, kind, key, text, link, refresh=True):
    """One unread notification per key: a repeat updates the existing one (refresh=True) or is ignored."""
    with STORE.tx() as db:
        r = db.execute('SELECT id FROM notifications WHERE key=? AND read=0', (key,)).fetchone()
        if r and refresh:
            db.execute('UPDATE notifications SET ts=?, text=?, link=? WHERE id=?', (ts, text, link, r[0]))
        elif not r:
            db.execute('INSERT INTO notifications(ts, kind, key, text, link, read) VALUES(?,?,?,?,?,0)', (ts, kind, key, text, link))


def qint(qs, k, default, lo, hi):
    try:
        v = int(qs.get(k, [default])[0])
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


# ---------------------------------------------------------------- event recorder
class Recorder:
    def __init__(self):
        self.buf = {}
        self.last_flush = time.time()

    def flush(self, force=False):
        if not self.buf or (not force and time.time() - self.last_flush < 10):
            return
        buf, self.buf, self.last_flush = self.buf, {}, time.time()
        with STORE.tx() as db:
            for minute, n in buf.items():
                db.execute('INSERT INTO event_counts(minute, n) VALUES(?,?) ON CONFLICT(minute) DO UPDATE SET n=n+excluded.n', (minute, n))

    def handle(self, tag, data):
        ts = time.time()
        minute = int(ts // 60)
        self.buf[minute] = self.buf.get(minute, 0) + 1
        STATE['events'] += 1
        STATE['lastEvent'] = ts
        parts = tag.split('/')
        if tag.startswith('salt/job/') and len(parts) >= 4:
            if parts[3] == 'new':
                self.job_new(parts[2], data, ts)
            elif parts[3] == 'ret' and len(parts) >= 5:
                self.job_ret(parts[2], parts[4], data, ts)
        elif (tag.startswith('salt/run/') or tag.startswith('salt/wheel/')) and len(parts) >= 4:
            if parts[3] == 'new':
                self.master_new(parts[1], parts[2], data, ts)
            elif parts[3] == 'ret':
                self.master_ret(parts[2], data, ts)
        elif tag == 'salt/presence/present':
            ids = [str(x) for x in (data.get('present') or [])]
            self.seen(ids, ts)
            STORE.run('INSERT INTO presence_counts(minute, n) VALUES(?,?) ON CONFLICT(minute) DO UPDATE SET n=MAX(n, excluded.n)', (minute, len(ids)))
        elif tag == 'salt/presence/change':
            for mid in data.get('lost') or []:
                notify(ts, 'presence', 'lost:%s' % mid, 'Minion %s disconnected from the master.' % mid, '#/minions/%s' % mid)
            for mid in data.get('new') or []:
                STORE.run('UPDATE notifications SET read=1 WHERE key=? AND read=0', ('lost:%s' % mid,))
            self.seen([str(x) for x in (data.get('new') or [])], ts)
        elif tag == 'salt/auth' and data.get('act') == 'pend' and data.get('id'):
            notify(ts, 'key', 'pend:%s' % data['id'], 'New minion key waiting for acceptance: %s' % data['id'], '#/keys/minions_pre', refresh=False)
        elif tag == 'salt/key' and data.get('id') and data.get('act') in ('accept', 'reject', 'delete'):
            STORE.run('UPDATE notifications SET read=1 WHERE key=? AND read=0', ('pend:%s' % data['id'],))
        elif tag == 'minion_start' or (tag.startswith('salt/minion/') and tag.endswith('/start')):
            mid = data.get('id') or (parts[2] if len(parts) > 2 else None)
            if mid:
                self.seen([str(mid)], ts)
        self.flush()

    def seen(self, ids, ts):
        if not ids:
            return
        with STORE.tx() as db:
            for mid in ids:
                db.execute('INSERT INTO presence(minion, last_seen, first_seen) VALUES(?,?,?) '
                           'ON CONFLICT(minion) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen)', (mid, ts, ts))

    def job_new(self, jid, d, ts):
        fun, user = str(d.get('fun') or ''), str(d.get('user') or '')
        tgt = fmt_tgt(d.get('tgt'))
        # manage.status / manage.up publish their own test.ping to all minions as root; that is a read, not a job someone ran
        if QUIET_FUN.match(fun) or (fun == 'test.ping' and user == 'root' and tgt == '*'):
            return
        minions = d.get('minions') or []
        STORE.run('INSERT OR IGNORE INTO jobs_seen(jid, ts, kind, fun, user, tgt, minions) VALUES(?,?,?,?,?,?,?)',
                  (jid, ts, 'minion', fun, user, tgt, len(minions)))
        audit(ts, user, 'job', fun, '%s (%s)' % (tgt, d.get('tgt_type') or 'glob'), d.get('arg') or '', jid)

    def job_ret(self, jid, mid, d, ts):
        self.seen([mid], ts)
        fun = str(d.get('fun') or '')
        if QUIET_FUN.match(fun):
            return
        rc = d.get('retcode')
        ok = d.get('success') is not False and not (isinstance(rc, int) and rc > 0)
        with STORE.tx() as db:
            db.execute('UPDATE jobs_seen SET returned=returned+1, failed=failed+? WHERE jid=?', (0 if ok else 1, jid))
            row = db.execute('SELECT failed FROM jobs_seen WHERE jid=?', (jid,)).fetchone()
        if not ok and row:
            n = row[0]
            notify(ts, 'job', 'job:%s' % jid, '%s failed on %s.' % (fun, mid if n == 1 else '%d minions' % n), '#/job/%s' % jid)

    def master_new(self, kind, jid, d, ts):
        fun, user = str(d.get('fun') or ''), str(d.get('user') or '')
        args = d.get('fun_args') or []
        if QUIET_FUN.match(fun) or (fun == 'runner.salt.cmd' and args[:1] == ['test.version']):
            return
        STORE.run('INSERT OR IGNORE INTO jobs_seen(jid, ts, kind, fun, user, tgt, minions) VALUES(?,?,?,?,?,?,1)',
                  (jid, ts, kind, fun, user, 'master'))
        audit(ts, user, kind, fun, 'master', args, jid)

    def master_ret(self, jid, d, ts):
        ok = d.get('success') is not False
        with STORE.tx() as db:
            cur = db.execute('UPDATE jobs_seen SET returned=returned+1, failed=failed+? WHERE jid=?', (0 if ok else 1, jid))
            known = cur.rowcount > 0
        if known and not ok:
            notify(ts, 'job', 'job:%s' % jid, '%s failed on the master.' % (d.get('fun') or 'Runner'), '#/job/%s' % jid)


def event_loop(rec):
    backoff = 1
    while not STOP.is_set():
        ev = None
        try:
            ev = salt.utils.event.get_master_event(OPTS, OPTS['sock_dir'], listen=True)
            STATE['bus'] = 'connected'
            backoff = 1
            while not STOP.is_set():
                e = ev.get_event(wait=5, full=True, auto_reconnect=True)
                if isinstance(e, dict) and e.get('tag'):
                    try:
                        rec.handle(str(e['tag']), e['data'] if isinstance(e.get('data'), dict) else {})
                    except Exception:
                        log.exception('could not record event %s', e.get('tag'))
                else:
                    rec.flush()
        except Exception:
            log.exception('event bus connection failed; retrying in %ss', backoff)
            STATE['bus'] = 'reconnecting'
        finally:
            if ev is not None:
                try:
                    ev.destroy()
                except Exception:
                    pass
        STOP.wait(backoff)
        backoff = min(backoff * 2, 60)
    rec.flush(force=True)


# ---------------------------------------------------------------- jobs and schedules
def conv(v):
    try:
        return json.loads(v)
    except ValueError:
        return v


def job_args(job):
    """Arguments as the console stores them: one per line, key=value for keyword arguments (older jobs: one line)."""
    arg, kw = [], {}
    text = str(job.get('args') or '')
    lines = text.split('\n') if job.get('command') else shlex.split(text)
    for line in lines:
        item = line.strip()
        if not item:
            continue
        m = re.match(r'^([A-Za-z_]\w*)=(.*)$', item)
        if m:
            kw[m.group(1)] = conv(m.group(2))
        else:
            arg.append(conv(item))
    return arg, kw


def build_call(job):
    fun = str(job.get('fun') or '').strip()
    if not fun:
        raise ApiError(400, 'The saved job has no function.')
    arg, kw = job_args(job)
    if re.match(r'^state\.(apply|sls|highstate)$', fun):
        mods = [m.strip() for m in str(job.get('states') or '').split(',') if m.strip()]
        if mods and fun != 'state.highstate':
            arg.insert(0, ','.join(mods))
        if job.get('saltenv'):
            kw['saltenv'] = job['saltenv']
        if str(job.get('pillar') or '').strip():
            try:
                kw['pillar'] = json.loads(job['pillar'])
            except ValueError:
                raise ApiError(400, 'The pillar override of job %s is not valid JSON.' % job.get('name'))
        if job.get('test'):
            kw['test'] = True
    return fun, arg, kw


def submit(job, tgt, tt, user):
    fun, arg, kw = build_call(job)
    if job.get('command') == 'salt-run':
        rc = salt.runner.RunnerClient(dict(OPTS))
        pub = rc.asynchronous(fun, {'fun': fun, 'arg': arg, 'kwarg': kw}, user=user)
        return pub['jid'], []
    lc = salt.client.LocalClient(mopts=dict(OPTS))
    try:
        pub = lc.run_job(tgt, fun, arg, tgt_type=tt, kwarg=kw)
    finally:
        try:
            lc.destroy()
        except Exception:
            pass
    if not pub or not pub.get('jid'):
        raise ApiError(409, 'No minions matched the target %s: %s.' % (tt, tgt))
    return pub['jid'], pub.get('minions') or []


def num_or_none(v):
    try:
        return float(v) if v not in (None, '') else None
    except (TypeError, ValueError):
        raise ApiError(400, 'Expected a number, got %r.' % (v,))


def validate_schedule(b, jobs, created=None):
    name = str(b.get('name') or '').strip()
    if not name or len(name) > 80:
        raise ApiError(400, 'Name is required (80 characters at most).')
    if b.get('jobId') not in {j.get('id') for j in jobs}:
        raise ApiError(400, 'Choose one of the saved jobs.')
    tz = str(b.get('tz') or 'UTC')
    try:
        ZoneInfo(tz)
    except Exception:
        raise ApiError(400, 'Unknown time zone %s.' % tz)
    s = {'name': name, 'jobId': b['jobId'], 'tgt': str(b.get('tgt') or '').strip(), 'tt': str(b.get('tt') or '').strip(),
         'type': b.get('type'), 'tz': tz, 'enabled': bool(b.get('enabled', True)), 'created': created or time.time()}
    if s['tt'] and s['tt'] not in TARGET_TYPES:
        raise ApiError(400, 'Unknown target type %s.' % s['tt'])
    if s['type'] == 'recurring':
        every = int(num_or_none(b.get('every')) or 0)
        if every < 60:
            raise ApiError(400, 'Run every must be at least 60 seconds.')
        s.update(every=every, start=num_or_none(b.get('start')), end=num_or_none(b.get('end')))
        if s['start'] and s['end'] and s['end'] <= s['start']:
            raise ApiError(400, 'The end must be after the start.')
    elif s['type'] == 'once':
        s['at'] = num_or_none(b.get('at'))
        if not s['at']:
            raise ApiError(400, 'Choose the date and time to run.')
    elif s['type'] == 'cron':
        expr = ' '.join(str(b.get('cron') or '').split())
        if len(expr.split()) != 5 or not croniter.is_valid(expr):
            raise ApiError(400, 'A cron expression has five fields (minute hour day month weekday), for example 30 2 * * 1-5.')
        s['cron'] = expr
    else:
        raise ApiError(400, 'Type must be recurring, once or cron.')
    return s


def compute_next(s, after):
    """Next run strictly after the given time, or None when the schedule has no further runs."""
    t = s.get('type')
    if t == 'once':
        return s['at'] if s['at'] > after else None
    if t == 'recurring':
        every, start, end = s['every'], s.get('start') or s['created'], s.get('end')
        n = start if after < start else start + (int((after - start) // every) + 1) * every
        return None if end and n > end else n
    if t == 'cron':
        base = datetime.fromtimestamp(after, ZoneInfo(s.get('tz') or 'UTC'))
        return croniter(s['cron'], base).get_next(float)
    return None


def occurrences(s, nxt, until, limit=20):
    out, t = [], nxt
    while t is not None and t <= until and len(out) < limit:
        out.append(t)
        t = compute_next(s, t)
    return out


def eff_target(s, job):
    if job and job.get('command') == 'salt-run':
        return 'master (salt-run)'
    job = job or {}
    return '%s: %s' % (s.get('tt') or job.get('tt') or 'glob', s.get('tgt') or job.get('tgt') or '*')


def run_schedule(sid, user, ts):
    row = STORE.one('SELECT data FROM schedules WHERE id=?', (sid,))
    if not row:
        raise ApiError(404, 'Schedule not found.')
    s = json.loads(row['data'])
    job = next((j for j in kv_get('jobs', [])[0] if j.get('id') == s['jobId']), None)
    if not job:
        raise ApiError(409, 'The saved job this schedule runs no longer exists.')
    jid, minions = submit(job, s.get('tgt') or job.get('tgt') or '*', s.get('tt') or job.get('tt') or 'glob', user)
    STORE.run('INSERT OR REPLACE INTO schedule_runs(jid, schedule_id, name, ts) VALUES(?,?,?,?)', (jid, sid, s['name'], ts))
    return s, jid, minions


def scheduler_loop():
    STATE['scheduler'] = 'running'
    while not STOP.wait(10):
        ts = time.time()
        STATE['lastTick'] = ts
        try:
            due = STORE.all('SELECT id, data, next_run FROM schedules WHERE next_run IS NOT NULL AND next_run <= ?', (ts,))
        except Exception:
            log.exception('could not read schedules')
            continue
        for row in due:
            s = json.loads(row['data'])
            jid, err = None, None
            if ts - row['next_run'] > LATE_SCHEDULE_SEC:
                err = 'Skipped the run due %s because the console service was not running then.' % utc(row['next_run'])
            else:
                try:
                    jid = run_schedule(row['id'], 'console-schedule', ts)[1]
                except ApiError as e:
                    err = e.msg
                except Exception as e:
                    log.exception('schedule %s failed to start', s.get('name'))
                    err = 'Could not start the job: %s' % e
            nxt = compute_next(s, ts) if s.get('enabled', True) else None
            STORE.run('UPDATE schedules SET next_run=?, last_run=?, last_jid=?, last_error=? WHERE id=?', (nxt, ts, jid, err, row['id']))
            if jid:
                audit(ts, 'console-schedule', 'schedule', 'ran schedule', s['name'], '', jid)
            else:
                audit(ts, 'console-schedule', 'schedule', 'schedule not run', s['name'], err)
                notify(ts, 'schedule', 'sched:%s' % row['id'], 'Schedule %s did not run: %s' % (s['name'], err), '#/schedules')


def retention_loop():
    if STOP.wait(60):
        return
    while True:
        try:
            ts = time.time()
            with STORE.tx() as db:
                db.execute('DELETE FROM event_counts WHERE minute < ?', (int((ts - RETENTION_DAYS['event_counts'] * 86400) // 60),))
                db.execute('DELETE FROM presence_counts WHERE minute < ?', (int((ts - RETENTION_DAYS['presence_counts'] * 86400) // 60),))
                for table in ('jobs_seen', 'schedule_runs', 'notifications', 'audit'):
                    db.execute('DELETE FROM %s WHERE ts < ?' % table, (ts - RETENTION_DAYS[table] * 86400,))
        except Exception:
            log.exception('retention clean-up failed')
        if STOP.wait(3600):
            return


# ---------------------------------------------------------------- authentication
class Auth:
    """Salt eauth tokens, issued by /login and checked against the master's token store. Valid tokens are cached for 60 s.
    (salt-api's own /login returns a web session id, not an eauth token, so it cannot be checked here.)"""

    def __init__(self):
        self.la = salt.auth.LoadAuth(OPTS)
        self.cache = {}
        self.lock = threading.Lock()

    def login(self, username, password, eauth):
        """Checks the credentials through Salt's external auth and returns a new eauth token, or None."""
        users = (OPTS.get('external_auth') or {}).get(eauth) or {}
        if not username or not password or (username not in users and '*' not in users):
            return None
        with self.lock:
            tok = self.la.mk_token({'username': username, 'password': password, 'eauth': eauth})
        return tok if tok and tok.get('token') else None

    def logout(self, token):
        with self.lock:
            self.cache.pop(token, None)
            tok = self.la.get_tok(token)
            if tok:
                self.la.rm_token(token)

    def check(self, token):
        if not token or not re.match(r'^[0-9a-f]{20,128}$', token):
            return None
        ts = time.time()
        with self.lock:
            hit = self.cache.get(token)
            if hit and hit[1] > ts:
                return hit[0]
            tok = self.la.get_tok(token)
            if not tok or float(tok.get('expire', 0)) < ts:
                self.cache.pop(token, None)
                return None
            user = str(tok.get('name') or 'unknown')
            self.cache[token] = (user, min(ts + 60, float(tok['expire'])))
            if len(self.cache) > 500:
                self.cache = {k: v for k, v in self.cache.items() if v[1] > ts}
            return user


# ---------------------------------------------------------------- API
def r_login(h):
    b = h.body()
    eauth = str(b.get('eauth') or 'pam')
    tok = AUTH.login(str(b.get('username') or ''), str(b.get('password') or ''), eauth)
    if not tok:
        time.sleep(1)  # slows down password guessing a little
        raise ApiError(401, 'Login failed. Check the user name and password.')
    audit(time.time(), tok.get('name'), 'console', 'logged in', '', eauth)
    return {'token': tok['token'], 'expire': tok['expire'], 'user': tok.get('name')}


def r_status(h, user, qs):
    return dict(STATE, version=VERSION, user=user, now=time.time(), db=DB_PATH)


def r_presence(h, user, qs):
    exp, ts = settings()['presenceExpirationSec'], time.time()
    out = {r['minion']: {'lastSeen': r['last_seen'], 'firstSeen': r['first_seen'], 'status': 'Present' if ts - r['last_seen'] <= exp else 'Disconnected'}
           for r in STORE.all('SELECT minion, last_seen, first_seen FROM presence')}
    return {'expirationSec': exp, 'now': ts, 'minions': out}


def r_shared_get(h, user, qs, name):
    items, ver = kv_get(name, [])
    return {'version': ver, 'items': items}


def r_shared_put(h, user, qs, name):
    b = h.body()
    items = b.get('items')
    if not isinstance(items, list) or not all(isinstance(x, dict) for x in items):
        raise ApiError(400, 'items must be a list of objects.')
    if len(json.dumps(items)) > 1000000:
        raise ApiError(413, 'The %s list is too large.' % name)
    names = [str(x.get('name') or '').strip() for x in items]
    if not all(names):
        raise ApiError(400, 'Every saved item needs a name.')
    if len(set(names)) != len(names):
        raise ApiError(400, 'Names must be unique.')
    if name == 'jobs':
        for x in items:
            x['id'] = str(x.get('id') or uuid.uuid4().hex)
    ver = kv_put(name, items, b.get('version'))
    audit(time.time(), user, 'console', 'saved %s' % name, '', '%d items: %s' % (len(items), ', '.join(names)))
    return {'version': ver, 'items': items}


def r_settings_get(h, user, qs):
    return settings()


def r_settings_put(h, user, qs):
    b = h.body()
    cur = settings()
    if 'presenceExpirationSec' in b:
        v = int(num_or_none(b['presenceExpirationSec']) or 0)
        if not 60 <= v <= 86400:
            raise ApiError(400, 'Presence expiration must be between 60 and 86400 seconds.')
        cur['presenceExpirationSec'] = v
    kv_put('settings', cur)
    audit(time.time(), user, 'console', 'changed settings', '', cur)
    return cur


def sched_view(row, jobs):
    s = json.loads(row['data'])
    j = jobs.get(s.get('jobId'))
    return dict(s, id=row['id'], nextRun=row['next_run'], lastRun=row['last_run'], lastJid=row['last_jid'], lastError=row['last_error'],
                jobName=j['name'] if j else None, jobFun=j.get('fun') if j else None, target=eff_target(s, j))


def jobs_by_id():
    return {j.get('id'): j for j in kv_get('jobs', [])[0]}


def r_sched_list(h, user, qs):
    jobs = jobs_by_id()
    rows = STORE.all('SELECT * FROM schedules')
    return {'items': sorted((sched_view(r, jobs) for r in rows), key=lambda x: x['name'].lower())}


def save_schedule(sid, s, ts):
    if s['type'] == 'once' and s['enabled'] and s['at'] <= ts:
        raise ApiError(400, 'The date and time to run must be in the future.')
    nxt = compute_next(s, ts) if s['enabled'] else None
    STORE.run('INSERT INTO schedules(id, data, next_run) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data, next_run=excluded.next_run',
              (sid, json.dumps(s), nxt))


def r_sched_create(h, user, qs):
    ts = time.time()
    s = validate_schedule(h.body(), kv_get('jobs', [])[0])
    sid = uuid.uuid4().hex
    save_schedule(sid, s, ts)
    audit(ts, user, 'schedule', 'created schedule', s['name'], s)
    return sched_view(STORE.one('SELECT * FROM schedules WHERE id=?', (sid,)), jobs_by_id())


def r_sched_update(h, user, qs, sid):
    row = STORE.one('SELECT data FROM schedules WHERE id=?', (sid,))
    if not row:
        raise ApiError(404, 'Schedule not found.')
    ts = time.time()
    s = validate_schedule(h.body(), kv_get('jobs', [])[0], created=json.loads(row['data']).get('created'))
    save_schedule(sid, s, ts)
    audit(ts, user, 'schedule', 'changed schedule', s['name'], s)
    return sched_view(STORE.one('SELECT * FROM schedules WHERE id=?', (sid,)), jobs_by_id())


def r_sched_delete(h, user, qs, sid):
    row = STORE.one('SELECT data FROM schedules WHERE id=?', (sid,))
    if not row:
        raise ApiError(404, 'Schedule not found.')
    STORE.run('DELETE FROM schedules WHERE id=?', (sid,))
    audit(time.time(), user, 'schedule', 'deleted schedule', json.loads(row['data'])['name'])
    return {'deleted': sid}


def r_sched_run(h, user, qs, sid):
    ts = time.time()
    s, jid, minions = run_schedule(sid, user, ts)
    STORE.run('UPDATE schedules SET last_run=?, last_jid=?, last_error=NULL WHERE id=?', (ts, jid, sid))
    audit(ts, user, 'schedule', 'ran schedule now', s['name'], '', jid)
    return {'jid': jid, 'minions': minions}


def r_upcoming(h, user, qs):
    hours = qint(qs, 'hours', 168, 1, 24 * 31)
    until = time.time() + hours * 3600
    jobs = jobs_by_id()
    items = []
    for row in STORE.all('SELECT id, data, next_run FROM schedules WHERE next_run IS NOT NULL'):
        s = json.loads(row['data'])
        j = jobs.get(s.get('jobId'))
        for t in occurrences(s, row['next_run'], until):
            items.append({'time': t, 'scheduleId': row['id'], 'schedule': s['name'], 'job': j['name'] if j else None,
                          'fun': j.get('fun') if j else None, 'target': eff_target(s, j)})
    items.sort(key=lambda x: x['time'])
    return {'hours': hours, 'items': items[:500]}


def r_origins(h, user, qs):
    jids = [str(j) for j in (h.body().get('jids') or [])][:1000]
    out = {}
    for i in range(0, len(jids), 200):
        part = jids[i:i + 200]
        for r in STORE.all('SELECT jid, name FROM schedule_runs WHERE jid IN (%s)' % ','.join('?' * len(part)), part):
            out[r['jid']] = r['name']
    return out


def r_notes(h, user, qs):
    limit = qint(qs, 'limit', 30, 1, 200)
    items = STORE.all('SELECT id, ts, kind, text, link, read FROM notifications ORDER BY ts DESC LIMIT ?', (limit,))
    unread = STORE.one('SELECT COUNT(*) AS n FROM notifications WHERE read=0')['n']
    return {'unread': unread, 'items': items}


def r_notes_read(h, user, qs):
    b = h.body()
    if b.get('all'):
        STORE.run('UPDATE notifications SET read=1 WHERE read=0')
    else:
        ids = [int(i) for i in (b.get('ids') or []) if str(i).isdigit()][:500]
        if ids:
            STORE.run('UPDATE notifications SET read=1 WHERE id IN (%s)' % ','.join('?' * len(ids)), ids)
    return r_notes(h, user, {})


def r_audit(h, user, qs):
    limit = qint(qs, 'limit', 500, 1, 5000)
    return {'items': STORE.all('SELECT id, ts, user, kind, action, target, detail, jid FROM audit ORDER BY id DESC LIMIT ?', (limit,))}


def r_metrics(h, user, qs):
    hours = qint(qs, 'hours', 12, 1, 24)
    ts = time.time()
    nb, start = 48, ts - hours * 3600
    step = hours * 3600 / nb

    def bucket(t):
        i = int((t - start) // step)
        return i if 0 <= i < nb else None
    events = [0] * nb
    for r in STORE.all('SELECT minute, n FROM event_counts WHERE minute >= ?', (int(start // 60),)):
        i = bucket(r['minute'] * 60 + 30)
        if i is not None:
            events[i] += r['n']
    presence = [None] * nb
    for r in STORE.all('SELECT minute, n FROM presence_counts WHERE minute >= ?', (int(start // 60),)):
        i = bucket(r['minute'] * 60 + 30)
        if i is not None:
            presence[i] = max(presence[i] or 0, r['n'])
    jobs = {k: [0] * nb for k in ('ok', 'failed', 'missed', 'running')}
    for r in STORE.all('SELECT ts, minions, returned, failed FROM jobs_seen WHERE ts >= ? AND minions > 0', (start,)):
        i = bucket(r['ts'])
        if i is None:
            continue
        k = 'failed' if r['failed'] else 'ok' if r['returned'] >= r['minions'] else 'missed' if ts - r['ts'] > MISSED_RETURN_SEC else 'running'
        jobs[k][i] += 1
    first = STORE.one('SELECT MIN(minute) AS m FROM event_counts')['m']
    return {'hours': hours, 'start': start, 'step': step, 'events': events, 'presence': presence, 'jobs': jobs,
            'recordingSince': first * 60 if first is not None else None}


ROUTES = [(m, re.compile('^' + p + '$'), f) for m, p, f in (
    ('GET', '/status', r_status), ('GET', '/presence', r_presence),
    ('GET', '/shared/(targets|jobs)', r_shared_get), ('PUT', '/shared/(targets|jobs)', r_shared_put),
    ('GET', '/settings', r_settings_get), ('PUT', '/settings', r_settings_put),
    ('GET', '/schedules', r_sched_list), ('POST', '/schedules', r_sched_create),
    ('PUT', '/schedules/([0-9a-f]{32})', r_sched_update), ('DELETE', '/schedules/([0-9a-f]{32})', r_sched_delete),
    ('POST', '/schedules/([0-9a-f]{32})/run', r_sched_run),
    ('GET', '/upcoming', r_upcoming), ('POST', '/origins', r_origins),
    ('GET', '/notifications', r_notes), ('POST', '/notifications/read', r_notes_read),
    ('GET', '/audit', r_audit), ('GET', '/metrics', r_metrics))]


class Api(BaseHTTPRequestHandler):
    server_version = 'salt-console/' + VERSION
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        log.debug('%s %s', self.address_string(), fmt % args)

    def send_json(self, code, obj):
        body = json.dumps(obj, default=str).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > 2000000:
            raise ApiError(413, 'Request too large.')
        raw = self.rfile.read(n) if n else b''
        try:
            b = json.loads(raw) if raw else {}
        except ValueError:
            raise ApiError(400, 'The request body is not valid JSON.')
        if not isinstance(b, dict):
            raise ApiError(400, 'The request body must be a JSON object.')
        return b

    def dispatch(self, method):
        try:
            u = urlparse(self.path)
            path, qs = u.path.rstrip('/') or '/', parse_qs(u.query)
            if path == '/health':
                return self.send_json(200, {'ok': True, 'version': VERSION, 'bus': STATE['bus']})
            if path == '/login' and method == 'POST':
                return self.send_json(200, r_login(self))
            user = AUTH.check(self.headers.get('X-Auth-Token', ''))
            if path == '/logout' and method == 'POST' and user:
                AUTH.logout(self.headers.get('X-Auth-Token', ''))
                return self.send_json(200, {'loggedOut': True})
            if not user:
                raise ApiError(401, 'A valid salt-api token is required.')
            for m, rx, fn in ROUTES:
                mt = rx.match(path)
                if mt and m == method:
                    return self.send_json(200, fn(self, user, qs, *mt.groups()))
            if any(rx.match(path) for _, rx, _ in ROUTES):
                raise ApiError(405, 'Method %s is not allowed on %s.' % (method, path))
            raise ApiError(404, 'Not found: %s' % path)
        except ApiError as e:
            self.send_json(e.status, {'error': e.msg})
        except Exception as e:
            log.exception('%s %s failed', method, self.path)
            self.send_json(500, {'error': 'Internal error in the console service: %s' % e})

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_PUT(self):
        self.dispatch('PUT')

    def do_DELETE(self):
        self.dispatch('DELETE')


def main():
    global STORE, AUTH
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format='%(levelname)s %(threadName)s: %(message)s')
    STORE = Store(DB_PATH)
    AUTH = Auth()
    rec = Recorder()
    for target, args in ((event_loop, (rec,)), (scheduler_loop, ()), (retention_loop, ())):
        threading.Thread(target=target, args=args, name=target.__name__, daemon=True).start()
    srv = ThreadingHTTPServer((HOST, PORT), Api)
    srv.daemon_threads = True

    def stop(signum, frame):
        log.info('stopping on signal %s', signum)
        STOP.set()
        threading.Thread(target=srv.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log.info('Lab Salt Console service %s listening on %s:%d, data in %s', VERSION, HOST, PORT, DB_PATH)
    srv.serve_forever()
    rec.flush(force=True)


if __name__ == '__main__':
    main()
