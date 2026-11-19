#!/usr/bin/env python3
"""test/api_test.py - checks the console service through nginx, the way the browser uses it.
Runs real jobs only against the master's own minion (test.ping, and manage.up on the master), and removes every
test object it creates. Usage: API_PW=<salt-api password> python3 test/api_test.py"""
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://127.0.0.1'
MINION = 'lab-salt01'
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE  # the master's own self-signed certificate on 127.0.0.1


def req(method, path, body=None, token=None, expect=200):
    data = None if body is None else json.dumps(body).encode()
    headers = {'Content-Type': 'application/json', 'Accept': 'application/json'}
    if token:
        headers['X-Auth-Token'] = token
    r = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=90) as resp:
            code, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    out = json.loads(raw) if raw else None
    if code != expect:
        raise AssertionError('%s %s -> HTTP %s, expected %s: %s' % (method, path, code, expect, out))
    return out


results = []


def check(name):
    def wrap(fn):
        try:
            fn()
            results.append((name, None))
        except Exception as e:
            results.append((name, '%s: %s' % (type(e).__name__, e)))
        return fn
    return wrap


def wait_for(fn, timeout=90, every=3):
    end = time.time() + timeout
    while True:
        v = fn()
        if v or time.time() > end:
            return v
        time.sleep(every)


pw = os.environ['API_PW']
SA = req('POST', '/salt-api/login', {'username': 'saltapi', 'password': pw, 'eauth': 'pam'})['return'][0]['token']
TOK = req('POST', '/console-api/login', {'username': 'saltapi', 'password': pw, 'eauth': 'pam'})['token']


def C(method, path, body=None, expect=200):
    return req(method, '/console-api' + path, body, TOK, expect)


def salt_job(jid):
    return req('POST', '/salt-api/', [{'client': 'runner', 'fun': 'jobs.list_job', 'jid': jid}], SA)['return'][0]


@check('wrong password and missing or forged tokens are refused')
def _():
    req('POST', '/console-api/login', {'username': 'saltapi', 'password': 'wrong-' + pw}, None, 401)
    req('GET', '/console-api/status', None, None, 401)
    req('GET', '/console-api/status', None, 'f' * 64, 401)
    req('GET', '/console-api/status', None, SA, 401)  # a salt-api session id is not an eauth token


@check('event bus connected and events recorded')
def _():
    st = wait_for(lambda: (lambda s: s if s['events'] > 0 else None)(C('GET', '/status')))
    assert st and st['bus'] == 'connected', st


@check('presence reports the master minion as Present')
def _():
    p = wait_for(lambda: (lambda x: x if x['minions'].get(MINION, {}).get('status') == 'Present' else None)(C('GET', '/presence')))
    assert p, 'no Present entry for %s' % MINION


state = {}


@check('shared jobs: version check refuses a stale write, a good write assigns ids')
def _():
    cur = C('GET', '/shared/jobs')
    state['jobs_before'] = cur
    C('PUT', '/shared/jobs', {'version': cur['version'] + 5, 'items': cur['items']}, 409)
    C('PUT', '/shared/jobs', {'version': cur['version'], 'items': cur['items'] + [{'name': 'x'}, {'name': 'x'}]}, 400)
    test_jobs = [{'name': '[TEST] api ping', 'command': 'salt', 'fun': 'test.ping', 'tgt': MINION, 'tt': 'list', 'args': ''},
                 {'name': '[TEST] api runner', 'command': 'salt-run', 'fun': 'manage.up', 'tgt': '', 'tt': 'glob', 'args': ''}]
    r = C('PUT', '/shared/jobs', {'version': cur['version'], 'items': cur['items'] + test_jobs})
    assert r['version'] == cur['version'] + 1, r
    mine = [j for j in r['items'] if j['name'].startswith('[TEST] api ')]
    assert len(mine) == 2 and all(len(j['id']) == 32 for j in mine), mine
    state['ping_job'], state['runner_job'] = mine[0]['id'], mine[1]['id']
    state['jobs_version'] = r['version']


@check('schedule validation refuses bad input')
def _():
    j = state['ping_job']
    C('POST', '/schedules', {'name': '[TEST] bad', 'jobId': j, 'type': 'recurring', 'every': 30}, 400)
    C('POST', '/schedules', {'name': '[TEST] bad', 'jobId': j, 'type': 'cron', 'cron': '61 * * * *'}, 400)
    C('POST', '/schedules', {'name': '[TEST] bad', 'jobId': 'nope', 'type': 'once', 'at': time.time() + 600}, 400)
    C('POST', '/schedules', {'name': '[TEST] bad', 'jobId': j, 'type': 'once', 'at': time.time() - 600}, 400)
    C('POST', '/schedules', {'name': '[TEST] bad', 'jobId': j, 'type': 'cron', 'cron': '0 2 * * *', 'tz': 'Mars/Base'}, 400)


@check('recurring schedule: next run and Upcoming are right')
def _():
    start = time.time() + 1800
    s = C('POST', '/schedules', {'name': '[TEST] api recurring', 'jobId': state['ping_job'], 'type': 'recurring', 'every': 3600, 'start': start, 'tz': 'Asia/Kolkata'})
    state['s1'] = s['id']
    assert abs(s['nextRun'] - start) < 1, s
    up = [x for x in C('GET', '/upcoming?hours=4')['items'] if x['scheduleId'] == s['id']]
    assert len(up) == 4 and abs(up[1]['time'] - start - 3600) < 1, up


@check('cron schedule is evaluated in its own time zone')
def _():
    s = C('POST', '/schedules', {'name': '[TEST] api cron', 'jobId': state['ping_job'], 'type': 'cron', 'cron': '30 2 * * *', 'tz': 'Asia/Kolkata', 'enabled': False})
    state['s2'] = s['id']
    assert s['nextRun'] is None, 'disabled schedule must have no next run'
    s = C('PUT', '/schedules/' + s['id'], dict(s, enabled=True))
    t = time.gmtime(s['nextRun'])
    assert (t.tm_hour, t.tm_min) == (21, 0), 'expected 02:30 IST = 21:00 UTC, got %s' % time.strftime('%H:%M', t)


@check('run now: a minion job is published, returns, and is attributed to the schedule')
def _():
    r = C('POST', '/schedules/%s/run' % state['s1'])
    assert r['minions'] == [MINION], r
    j = wait_for(lambda: (lambda x: x if MINION in (x.get('Result') or {}) else None)(salt_job(r['jid'])), 60)
    assert j and j['Result'][MINION]['return'] is True, j
    o = C('POST', '/origins', {'jids': [r['jid'], '20000101000000000000']})
    assert o == {r['jid']: '[TEST] api recurring'}, o
    s = [x for x in C('GET', '/schedules')['items'] if x['id'] == state['s1']][0]
    assert s['lastJid'] == r['jid'] and not s['lastError'], s


@check('run now: a salt-run job is started on the master')
def _():
    s = C('POST', '/schedules', {'name': '[TEST] api runner', 'jobId': state['runner_job'], 'type': 'once', 'at': time.time() + 86400, 'enabled': True})
    state['s3'] = s['id']
    assert s['target'] == 'master (salt-run)', s
    r = C('POST', '/schedules/%s/run' % s['id'])
    j = wait_for(lambda: (lambda x: x if x.get('Result') else None)(salt_job(r['jid'])), 60)
    ret = list(j['Result'].values())[0]['return']
    assert MINION in json.dumps(ret), ret


@check('the scheduler starts a due run by itself and records it')
def _():
    at = time.time() + 15
    s = C('POST', '/schedules', {'name': '[TEST] api once', 'jobId': state['ping_job'], 'type': 'once', 'at': at})
    state['s4'] = s['id']
    assert abs(s['nextRun'] - at) < 1, s
    done = wait_for(lambda: [x for x in C('GET', '/schedules')['items'] if x['id'] == s['id'] and x['lastJid']], 60, 5)
    assert done, 'the schedule did not run within 60 seconds'
    x = done[0]
    assert x['nextRun'] is None and not x['lastError'] and x['lastRun'] >= at, x
    j = wait_for(lambda: (lambda r: r if MINION in (r.get('Result') or {}) else None)(salt_job(x['lastJid'])), 60)
    assert j and j['Result'][MINION]['return'] is True, j


@check('audit log records the runs with the user who clicked Run Now')
def _():
    a = C('GET', '/audit?limit=200')['items']
    assert any(x['action'] == 'ran schedule now' and x['user'] == 'saltapi' and x['target'] == '[TEST] api recurring' for x in a)
    assert not any(x['action'].startswith(('runner.jobs.', 'wheel.key.list')) for x in a), 'read-only calls leaked into the audit log'


@check('notifications and metrics answer')
def _():
    n = C('GET', '/notifications?limit=5')
    assert 'unread' in n and isinstance(n['items'], list), n
    C('POST', '/notifications/read', {'ids': []})
    m = C('GET', '/metrics?hours=1')
    assert len(m['events']) == 48 and len(m['jobs']['ok']) == 48 and sum(m['events']) > 0, m


@check('clean-up: test schedules and jobs removed')
def _():
    for k in ('s1', 's2', 's3', 's4'):
        if state.get(k):
            C('DELETE', '/schedules/' + state[k])
    left = [x for x in C('GET', '/schedules')['items'] if x['name'].startswith('[TEST] ')]
    assert not left, left
    cur = C('GET', '/shared/jobs')
    keep = [j for j in cur['items'] if not j['name'].startswith('[TEST] api ')]
    C('PUT', '/shared/jobs', {'version': cur['version'], 'items': keep})
    assert not [j for j in C('GET', '/shared/jobs')['items'] if j['name'].startswith('[TEST] ')]


fail = [r for r in results if r[1]]
for name, err in results:
    print(('ok   ' if not err else 'FAIL ') + name + ('' if not err else ' -> ' + err))
print('service: %d/%d checks ok' % (len(results) - len(fail), len(results)))
sys.exit(1 if fail else 0)
