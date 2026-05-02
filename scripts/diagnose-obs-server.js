// Standalone diagnostic for "all OBS overlays are dead in 1.5.3."
// Run from PowerShell:    node scripts/diagnose-obs-server.js
//
// Checks:
//   1. Can a Node process bind 127.0.0.1:8787 on this machine RIGHT NOW?
//      - If EACCES: 8787 is in a Windows excluded-port range (Hyper-V,
//        WSL2, or Docker reserved it). SF can't open the server; every
//        overlay returns nothing → "cannot get chat".
//      - If EADDRINUSE: another process (or a stale SF socket) holds it.
//   2. Is StreamFusion's running obs-server reachable on 8787?
//      Hits /ping and reports the entitled flag and bound port.
//   3. Lists Windows excluded port ranges so we can see whether 8787 sits
//      inside one.

const http = require('http');
const { spawnSync } = require('child_process');

console.log('--- StreamFusion OBS server diagnostic ---');
console.log();

// 1) Try to bind 8787 ourselves, briefly. If SF is running and bound, we'll
//    get EADDRINUSE — that's actually the GOOD outcome here.
function tryBind(port) {
  return new Promise(function(resolve) {
    var srv = http.createServer(function(_, res) { res.end(); });
    var settled = false;
    srv.once('error', function(err) {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch (e) {}
      resolve({ ok: false, code: err && err.code, msg: err && err.message });
    });
    srv.listen(port, '127.0.0.1', function() {
      if (settled) return;
      settled = true;
      try { srv.close(); } catch (e) {}
      resolve({ ok: true });
    });
  });
}

// 2) Probe the live server (if SF is running).
function ping(port) {
  return new Promise(function(resolve) {
    var req = http.get({ host: '127.0.0.1', port: port, path: '/ping', timeout: 2000 }, function(res) {
      var body = '';
      res.on('data', function(d) { body += d; });
      res.on('end', function() {
        try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(body) }); }
        catch (e) { resolve({ ok: true, status: res.statusCode, body: body }); }
      });
    });
    req.on('error', function(err) { resolve({ ok: false, code: err && err.code, msg: err && err.message }); });
    req.on('timeout', function() { req.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); });
  });
}

// 3) Pull Windows excluded-port ranges via netsh.
function excludedRanges() {
  try {
    var r = spawnSync('netsh', ['interface', 'ipv4', 'show', 'excludedportrange', 'protocol=tcp'], { encoding: 'utf-8' });
    if (r.status !== 0) return '(could not run netsh — only available on Windows)';
    return r.stdout.trim();
  } catch (e) {
    return '(netsh not available on this OS)';
  }
}

(async function() {
  for (var p = 8787; p <= 8791; p++) {
    var bind = await tryBind(p);
    if (bind.ok) {
      console.log('PORT ' + p + ': free (no app is using it; SF would bind here).');
    } else if (bind.code === 'EADDRINUSE') {
      var live = await ping(p);
      if (live.ok && live.body && live.body.ok) {
        console.log('PORT ' + p + ': IN USE — SF (or compatible) is running here.');
        console.log('   /ping →', JSON.stringify(live.body));
      } else {
        console.log('PORT ' + p + ': in use, but does not look like SF (no /ping response).');
      }
    } else if (bind.code === 'EACCES') {
      console.log('PORT ' + p + ': RESERVED BY WINDOWS (EACCES). SF cannot bind here.');
    } else {
      console.log('PORT ' + p + ': error ' + bind.code + ' — ' + bind.msg);
    }
  }

  console.log();
  console.log('--- Windows TCP excluded port ranges ---');
  console.log(excludedRanges());
  console.log();
  console.log('Read: if 8787 (the SF default) shows EACCES above OR sits inside one of');
  console.log('the netsh-reported ranges, that is your problem. Workarounds, easiest first:');
  console.log('  1) Restart Windows. The dynamic ranges sometimes shift on reboot.');
  console.log('  2) Reserve 8787 explicitly so it is no longer in the dynamic pool:');
  console.log('     netsh int ipv4 add excludedportrange protocol=tcp startport=8787 numberofports=1');
  console.log('     (run from an elevated PowerShell, then restart SF)');
  console.log('  3) Wait for the StreamFusion 1.5.4 patch — it auto-falls-back to 8788–8791.');
})();
