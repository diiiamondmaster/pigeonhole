// Shared fake proxy infrastructure for the free-pool E2E test and visual
// harness. Spins up:
//   - two plain SOCKS5 fakes (NL fast, DE slower) that tunnel traffic,
//   - one credentialed HTTP proxy fake (PL - demands Proxy-Auth, answered
//     through Electron's login event) and one plain HTTP fake (US),
//   - one dead candidate (nothing listens),
//   - a "check" server (204 probes), a site server (pages + /ip echo),
//   - list sources in Geonode JSON + plain formats.
// Delays are engineered so verification latency ranks NL < DE < PL < US,
// which makes assignment deterministic.
import http from 'http';
import net from 'net';

const CHECK_PORT = 8194;
const SITE_PORT = 8195;
const SRC_PORT = 8193;

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
function socksFake({ delay = 0, creds = null } = {}) {
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
export async function startPoolFakes() {
  const socks = {};
  const https_ = {};
  const closeable = [];
  const listen = (srv, port) => new Promise(r => srv.listen(port, '127.0.0.1', () => r()));

  for (const f of fakes) {
    const impl = f.kind === 'socks' ? socksFake(f) : httpFake(f);
    await listen(impl.server, f.port);
    closeable.push(impl.server);
    if (f.kind === 'socks') socks[f.name] = impl; else https_[f.name] = impl;
  }

  // check server: answers 204 to any path
  const checkSrv = http.createServer((req, res) => httpReply(res, 204, {}, ''));
  await listen(checkSrv, CHECK_PORT);
  closeable.push(checkSrv);

  // site server: the origin the webviews load + a /ip echo
  const siteSrv = http.createServer((req, res) => {
    if (/\/ip\b/.test(req.url || '')) return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ ip: '9.9.9.9' }));
    return httpReply(res, 200, { 'content-type': 'text/html' }, '<!doctype html><html><body><h1 id="mk">pool-ok</h1></body></html>');
  });
  await listen(siteSrv, SITE_PORT);
  closeable.push(siteSrv);

  // sources server
  const geoSocks = { data: [
    { ip: '127.0.0.1', port: 8301, country: 'NL' },
    { ip: '127.0.0.1', port: 8302, country: 'DE' },
    { ip: '127.0.0.1', port: 8305, country: 'XX' }      // dead candidate
  ] };
  const geoHttp = { data: [
    { ip: '127.0.0.1', port: 8304, country: 'PL' },     // credentialed (declared in plain.txt)
    { ip: '127.0.0.1', port: 8303, country: 'US' }
  ] };
  const plainTxt = 'u1:p9@127.0.0.1:8304\n';
  const srcSrv = http.createServer((req, res) => {
    if (req.url === '/geo-socks.json') return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify(geoSocks));
    if (req.url === '/geo-http.json') return httpReply(res, 200, { 'content-type': 'application/json' }, JSON.stringify(geoHttp));
    if (req.url === '/plain.txt') return httpReply(res, 200, { 'content-type': 'text/plain' }, plainTxt);
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
    ports: { check: CHECK_PORT, site: SITE_PORT, src: SRC_PORT },
    logs: { nl: socks.nl.log, de: socks.de.log, pl: https_.pl.log, us: https_.us.log },
    servers: { nl: socks.nl.server, de: socks.de.server, pl: https_.pl.server, us: https_.us.server },
    kill: (name) => { const f = name === 'nl' ? socks.nl : name === 'de' ? socks.de : name === 'pl' ? https_.pl : https_.us; f.kill(); },
    sourcesEnv,
    siteUrl: (p = '/pool-target.html') => `http://127.0.0.1:${SITE_PORT}${p}`,
    checkUrl: `http://127.0.0.1:${CHECK_PORT}/204`,
    close: () => closeable.forEach(s => { try { s.close(); } catch { } })
  };
}
