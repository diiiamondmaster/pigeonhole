// Shared fake proxy infrastructure for the free-pool E2E tests and visual
// harness. Spins up:
//   - two plain SOCKS5 fakes (NL fast, DE slower) that tunnel traffic,
//   - one credentialed HTTP proxy fake (PL - demands Proxy-Auth, answered
//     through Electron's login event) and one plain HTTP fake (US),
//   - one dead candidate (nothing listens),
//   - a "check" server (204 probes), a site server (pages + /ip echo + hit
//     counter), a "trace" server (tier-2 content / throughput / whoami),
//   - list sources in Geonode JSON + plain formats, mutable at runtime.
// Delays are engineered so verification latency ranks NL < DE < PL < US,
// which makes assignment deterministic.
// startPoolFakes(opts) can override delays, add tunnel-filtering SOCKS
// fakes (a "liar" that answers probes but breaks real pages, a "ghost" that
// only answers 204 pings) and swap the served source lists mid-test.
import http from 'http';
import net from 'net';

const CHECK_PORT = 8194;
const SITE_PORT = 8195;
const SRC_PORT = 8193;
const TRACE_PORT = 8196;

const fakes = [
  { name: 'nl', kind: 'socks', port: 8301, delay: 0, country: 'NL', creds: null },
  { name: 'de', kind: 'socks', port: 8302, delay: 100, country: 'DE', creds: null },
  { name: 'us', kind: 'http', port: 8303, delay: 250, country: 'US', creds: null, ip: '203.0.113.7' },
  { name: 'pl', kind: 'http', port: 8304, delay: 120, authDelay: 400, country: 'PL', creds: { u: 'u1', p: 'p9' }, ip: '198.51.100.44' }
];

function httpReply(res, code, headers, body) {
  res.writeHead(code, headers);
  res.end(body);
}

// ---- SOCKS5 fake (optional username/password auth) with transit logging ----
// tunnelFilter(host, port): when set, a target the filter rejects gets a
// SOCKS success reply and then a dead pipe - the client sees a connection
// that "works" at handshake level but carries no traffic (the "liar" and
// "ghost" test proxies).
function socksFake({ delay = 0, creds = null, tunnelFilter = null } = {}) {
  const log = [];
  const conns = new Set();
  const server = net.createServer(sock => {
    conns.add(sock);
    sock.on('close', () => conns.delete(sock));
    let stage = 0;
    let sniffed = false;
    sock.on('data', (buf) => {
      if (stage === 0) {
        // greeting: VER(1) NMETHODS(1) METHODS(NMETHODS) - methods start at byte 2
        const methods = [...buf.slice(2, 2 + (buf[1] || 0))];
        if (creds) {
          if (!methods.includes(2)) { sock.end(Buffer.from([5, 0xff])); return; }   // needs user/pass
          sock.write(Buffer.from([5, 2]));                                         // select username/password
          stage = 'auth';
          return;
        }
        if (!methods.includes(0)) { sock.end(Buffer.from([5, 0xff])); return; }
        sock.write(Buffer.from([5, 0]));
        stage = 1;
        return;
      }
      if (stage === 'auth') {
        // client auth subnegotiation: [VER=1, ULEN, USER, PLEN, PASS]
        if (buf[0] !== 1) { sock.end(); return; }
        const ulen = buf[1];
        const user = buf.slice(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        const pass = buf.slice(3 + ulen, 3 + ulen + plen).toString();
        if (user !== creds.u || pass !== creds.p) {
          sock.write(Buffer.from([1, 0xff]));      // auth failure
          return sock.end();
        }
        sock.write(Buffer.from([1, 0]));            // auth success
        stage = 1;
        return;
      }
      if (stage === 1) {
        if (buf[0] !== 5 || buf[1] !== 1) return;
        const atyp = buf[3];
        let host, off;
        if (atyp === 1) { host = [buf[4], buf[5], buf[6], buf[7]].join('.'); off = 8; }
        else if (atyp === 3) { const len = buf[4]; host = buf.slice(5, 5 + len).toString(); off = 5 + len; }
        else return;
        const tport = (buf[off] << 8) | buf[off + 1];
        stage = 2;
        setTimeout(() => {
          if (tunnelFilter && !tunnelFilter(host, tport)) {
            // lie: accept the tunnel, then drop it on the floor
            try { sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); } catch { }
            setTimeout(() => { try { sock.destroy(); } catch { } }, 20);
            log.push(`${Date.now()} REFUSED-TUNNEL ${host}:${tport}`);
            return;
          }
          const up = net.connect(tport, host, () => {
            try { sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); } catch { }
            up.pipe(sock);
            sock.pipe(up);
            sock.on('data', chunk => {          // sniff the first request line
              if (!sniffed) {
                sniffed = true;
                log.push(`${Date.now()} ${String(chunk.toString('latin1')).split('\r\n')[0]}  [-> ${host}:${tport}]`);
              }
            });
          });
          up.on('error', () => { try { sock.end(); } catch { } });
        }, delay);
      }
    });
    sock.on('error', () => { });
  });
  const kill = () => { conns.forEach(c => { try { c.destroy(); } catch { } }); try { server.close(); } catch { } };
  return { server, log, kill };
}

// ---- HTTP proxy fake: absolute-form forwarder, optional Proxy-Auth, /ip echo ----
// authDelay: how long an unauthorized (407) answer takes - the pool health
// check measures only the 407 roundtrip, so this controls its probe latency.
function httpFake({ port, delay, creds, ip, authDelay = 0 }) {
  const log = [];
  const conns = new Set();
  const server = http.createServer((req, res) => {
    const target = req.url;        // absolute form when used as a proxy
    const auth = req.headers['proxy-authorization'] || '';
    log.push(`${Date.now()} ${req.method} ${target} ${auth || 'noauth'}`);
    if (creds) {
      const want = 'Basic ' + Buffer.from(creds.u + ':' + creds.p).toString('base64');
      if (auth !== want) {
        return setTimeout(() => httpReply(res, 407, { 'Proxy-Authenticate': 'Basic realm="pl"' }, 'auth required'), authDelay);
      }
    }
    setTimeout(() => {
      if (/\/ip\b/.test(target || '')) {
        return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ip: ip || '9.9.9.9' }));
      }
      let u;
      try { u = new URL(target); } catch { return httpReply(res, 403, {}, 'fake proxy: bad target'); }
      const mod = u.protocol === 'https:' ? null : http;
      if (!mod) return httpReply(res, 403, {}, 'fake proxy: http only');
      const preq = mod.get({ host: u.hostname, port: u.port, path: u.pathname + u.search }, up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      preq.on('error', () => { try { httpReply(res, 502, {}, 'upstream error'); } catch { } });
    }, delay);
  });
  return { server, log, port };
}

// ---- infrastructure ----
export async function startPoolFakes(opts = {}) {
  const { delays = {}, extraFakes = [] } = opts;
  const socks = {};
  const https_ = {};
  const extras = {};
  const closeable = [];
  const listen = (srv, port) => new Promise(r => srv.listen(port, '127.0.0.1', () => r()));

  for (const f of fakes) {
    const cfg = { ...f, delay: delays[f.name] != null ? delays[f.name] : f.delay };
    const impl = f.kind === 'socks' ? socksFake(cfg) : httpFake(cfg);
    await listen(impl.server, f.port);
    closeable.push(impl.server);
    if (f.kind === 'socks') socks[f.name] = impl; else https_[f.name] = impl;
  }
  for (const f of extraFakes) {
    const impl = socksFake(f);      // extras are always SOCKS with a filter
    await listen(impl.server, f.port);
    closeable.push(impl.server);
    extras[f.name] = impl;
  }

  // check server: answers 204 to any path
  const checkSrv = http.createServer((req, res) => httpReply(res, 204, {}, ''));
  await listen(checkSrv, CHECK_PORT);
  closeable.push(checkSrv);

  // site server: the origin the webviews load + a /ip echo + a hit counter
  // (the counter proves whether a page was reloaded after a swap)
  let countHits = 0;
  const siteSrv = http.createServer((req, res) => {
    const u = req.url || '';
    if (/\/ip\b/.test(u)) return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ip: '9.9.9.9' }));
    if (/^\/count/.test(u)) {
      countHits++;
      return httpReply(res, 200, { 'content-type': 'text/html' }, `<!doctype html><html><body><h1 id="mk">hits-${countHits}</h1></body></html>`);
    }
    return httpReply(res, 200, { 'content-type': 'text/html' }, '<!doctype html><html><body><h1 id="mk">pool-ok</h1></body></html>');
  });
  await listen(siteSrv, SITE_PORT);
  closeable.push(siteSrv);

  // trace server: tier-2 content, throughput payload and the user's location
  // oracle (deliberately on its own port so tunnel-filter fakes can allow
  // probes but break real pages - and the other way around)
  const BULK = Buffer.alloc(12 * 1024, 'x');
  const traceSrv = http.createServer((req, res) => {
    const u = req.url || '';
    if (/^\/trace/.test(u)) return httpReply(res, 200, { 'content-type': 'text/plain' }, 'fl=fake\nh=ok\nip=9.9.9.9\nts=1234\nwarp=off\n');
    if (/^\/bulk/.test(u)) return httpReply(res, 200, { 'content-type': 'application/octet-stream' }, BULK);
    if (/^\/whoami/.test(u)) return httpReply(res, 200, { 'content-type': 'text/plain' }, 'loc=NL\nip=1.2.3.4\n');
    httpReply(res, 404, {}, 'nf');
  });
  await listen(traceSrv, TRACE_PORT);
  closeable.push(traceSrv);

  // sources server - the served lists are mutable so a test can introduce a
  // better proxy mid-run and watch the supervisor upgrade to it
  const DEFAULT_GEO_SOCKS = [
    { ip: '127.0.0.1', port: 8301, country: 'NL' },
    { ip: '127.0.0.1', port: 8302, country: 'DE' },
    { ip: '127.0.0.1', port: 8305, country: 'XX' }      // dead candidate
  ];
  const DEFAULT_GEO_HTTP = [
    { ip: '127.0.0.1', port: 8304, country: 'PL' },     // credentialed (declared in plain.txt)
    { ip: '127.0.0.1', port: 8303, country: 'US' }
  ];
  const DEFAULT_PLAIN = 'u1:p9@127.0.0.1:8304\n';
  let served = {
    geoSocks: DEFAULT_GEO_SOCKS,
    geoHttp: DEFAULT_GEO_HTTP,
    plain: DEFAULT_PLAIN
  };
  const srcSrv = http.createServer((req, res) => {
    if (req.url === '/geo-socks.json') return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ data: served.geoSocks }));
    if (req.url === '/geo-http.json') return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ data: served.geoHttp }));
    if (req.url === '/plain.txt') return httpReply(res, 200, { 'content-type': 'text/plain' }, served.plain);
    httpReply(res, 404, {}, 'nf');
  });
  await listen(srcSrv, SRC_PORT);
  closeable.push(srcSrv);

  const sourcesEnv = JSON.stringify([
    { url: `http://127.0.0.1:${SRC_PORT}/geo-socks.json`, protocol: 'socks5', geonode: true },
    { url: `http://127.0.0.1:${SRC_PORT}/geo-http.json`, protocol: 'http', geonode: true },
    { url: `http://127.0.0.1:${SRC_PORT}/plain.txt`, protocol: 'http' }
  ]);

  return {
    ports: { check: CHECK_PORT, site: SITE_PORT, src: SRC_PORT, trace: TRACE_PORT },
    logs: {
      nl: socks.nl.log, de: socks.de.log, pl: https_.pl.log, us: https_.us.log,
      ...Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, v.log]))
    },
    servers: {
      nl: socks.nl.server, de: socks.de.server, pl: https_.pl.server, us: https_.us.server,
      ...Object.fromEntries(Object.entries(extras).map(([k, v]) => [k, v.server]))
    },
    kill: (name) => {
      const f = name === 'nl' ? socks.nl : name === 'de' ? socks.de : name === 'pl' ? https_.pl
        : name === 'us' ? https_.us : extras[name];
      if (f) f.kill();
    },
    sourcesEnv,
    getCount: () => countHits,
    setSources: (patch) => { served = { ...served, ...patch }; },
    resetSources: () => { served = { geoSocks: DEFAULT_GEO_SOCKS, geoHttp: DEFAULT_GEO_HTTP, plain: DEFAULT_PLAIN }; },
    siteUrl: (p = '/pool-target.html') => `http://127.0.0.1:${SITE_PORT}${p}`,
    countUrl: () => `http://127.0.0.1:${SITE_PORT}/count`,
    checkUrl: `http://127.0.0.1:${CHECK_PORT}/204`,
    traceUrl: `http://127.0.0.1:${TRACE_PORT}/trace`,
    bulkUrl: `http://127.0.0.1:${TRACE_PORT}/bulk`,
    whoamiUrl: `http://127.0.0.1:${TRACE_PORT}/whoami`,
    close: () => closeable.forEach(s => { try { s.close(); } catch { } })
  };
}
