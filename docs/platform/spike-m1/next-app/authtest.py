import http.client, json, sys, urllib.parse
def req(method, path, host, jar, proto=None, body=None):
    c = http.client.HTTPConnection('127.0.0.1', 3111)
    h = {'Host': host}
    if proto: h['x-forwarded-proto'] = proto; h['x-forwarded-host'] = host
    if jar: h['Cookie'] = '; '.join(f'{k}={v}' for k, v in jar.items())
    if body: h['Content-Type'] = 'application/x-www-form-urlencoded'
    c.request(method, path, body=body, headers=h); r = c.getresponse(); data = r.read().decode()
    for k, v in r.getheaders():
        if k.lower() == 'set-cookie':
            nv = v.split(';')[0]; n, val = nv.split('=', 1)
            jar[n] = val
    return r.status, data
def flow(host, login_proto, read_proto):
    jar = {}
    _, d = req('GET', '/api/auth/csrf', host, jar, login_proto)
    tok = json.loads(d)['csrfToken']
    names_before = set(jar)
    st, d = req('POST', '/api/auth/callback/credentials', host, jar, login_proto, f'csrfToken={tok}&password=ok&json=true')
    sess_cookie = [k for k in jar if 'session-token' in k]
    st2, d2 = req('GET', '/api/session', host, jar, read_proto)
    j = json.loads(d2)
    return dict(cookie=sess_cookie, loginStatus=st, sessionOk=bool(j['session']))
print(sys.argv[1], '=>', 'login https/leer https:', flow('t2.test', 'https', 'https'), '| login https/leer SIN proxy headers:', flow('t2.test', 'https', None), '| login http/leer http:', flow('t2.test', None, None))
