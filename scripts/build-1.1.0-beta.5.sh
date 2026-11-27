#!/bin/bash
# build-1.1.0-beta.5.sh - portable Windows zip for the fifth 1.1 beta.
# Gates: stage -> official asar pack -> JS syntax scan -> zip swap -> official
# extract + version check -> real-Electron runtime boot gate.
set -euo pipefail
DIR=/home/z/my-project/pigeonhole
STAGE=/tmp/stage11b5
ASAR=/tmp/app-11b5.asar
ASAR_CLI=$DIR/node_modules/@electron/asar/bin/asar.mjs
SRC_ZIP=/home/z/my-project/download/Pigeonhole-1.0.6-win-x64.zip
OUT_ZIP=/home/z/my-project/download/Pigeonhole-1.1.0-beta.5-win-x64.zip
ELECTRON=$DIR/node_modules/electron/dist/electron

echo "== stage asar payload"
rm -rf "$STAGE"
mkdir -p "$STAGE/assets" "$STAGE/app" "$STAGE/main"
cp -r "$DIR/app/." "$STAGE/app/"
cp -r "$DIR/main/." "$STAGE/main/"
cp "$DIR/preload.js" "$DIR/package.json" "$DIR/LICENSE" "$STAGE/"
cp -r "$DIR/assets/screenshots" "$STAGE/assets/"
rm -f "$STAGE/app/js/.DS_Store" 2>/dev/null || true

echo "== pack asar with the OFFICIAL tool"
node "$ASAR_CLI" pack "$STAGE" "$ASAR"
ls -la "$ASAR"
node "$ASAR_CLI" list "$ASAR" | wc -l

echo "== syntax check every JS file that ships"
node --experimental-vm-modules - <<'EOF'
const fs = require('fs'), vm = require('vm');
(async () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  });
  walk('/tmp/stage11b5');
  let bad = 0;
  for (const f of files) {
    try { new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: f }); }
    catch (e) { bad++; console.error('SYNTAX FAIL', f, e.message); }
  }
  console.log(files.length + ' JS files parsed,', bad + ' failures');
  if (bad) process.exit(1);
})();
EOF

echo "== swap asar into the release zip"
python3 - <<'EOF'
import zipfile, os
src = '/home/z/my-project/download/Pigeonhole-1.0.6-win-x64.zip'
out = '/home/z/my-project/download/Pigeonhole-1.1.0-beta.5-win-x64.zip'
asar = open('/tmp/app-11b5.asar', 'rb').read()
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
    skipped = 0
    for item in zin.infolist():
        if item.filename == 'resources/app.asar':
            skipped += 1
            continue
        zout.writestr(item, zin.read(item.filename))
    zi = zipfile.ZipInfo('resources/app.asar', date_time=(2026, 11, 27, 3, 0, 0))
    zi.compress_type = zipfile.ZIP_DEFLATED
    zout.writestr(zi, asar)
print('swapped app.asar; skipped', skipped, 'old copies')
print('output size:', os.path.getsize(out))
EOF

echo "== verify: unzip + official-extract + version"
rm -rf /tmp/verify11b5 && mkdir -p /tmp/verify11b5
python3 -c "
import zipfile
z = zipfile.ZipFile('/home/z/my-project/download/Pigeonhole-1.1.0-beta.5-win-x64.zip')
names = z.namelist()
assert 'resources/app.asar' in names and 'Pigeonhole.exe' in names
assert len(names) == 76, len(names)   # app/inject lives INSIDE the asar
z.extract('resources/app.asar', '/tmp/verify11b5')
print('zip ok,', len(names), 'entries')
"
node "$ASAR_CLI" extract /tmp/verify11b5/resources/app.asar /tmp/verify11b5/src
python3 -c "
import json, os
pkg = json.load(open('/tmp/verify11b5/src/package.json'))
assert pkg['version'] == '1.1.0-beta.5', pkg['version']
assert os.path.exists('/tmp/verify11b5/src/main/disposable.js')
assert os.path.exists('/tmp/verify11b5/src/main/proxypool.js')
assert os.path.exists('/tmp/verify11b5/src/app/inject/gconsent.js')
assert os.path.exists('/tmp/verify11b5/src/app/js/providers.js')
print('asar ok: version', pkg['version'], '| disposable + pool + gconsent + providers shipped')
"

echo "== runtime boot test (mandatory gate)"
pgrep -f 'Xvfb :97' >/dev/null || { Xvfb :97 -screen 0 1280x800x24 >/tmp/xvfb-11b5.log 2>&1 & sleep 1.5; }
rm -rf /tmp/boot11b5home
set +e
HOME=/tmp/boot11b5home DISPLAY=:97 ELECTRON_ENABLE_LOGGING=1 \
  timeout 20 "$ELECTRON" /tmp/verify11b5/resources/app.asar --no-sandbox --disable-gpu \
  > /tmp/boot-11b5.log 2>&1
BOOT_CODE=$?
set -e
echo "boot exit code: $BOOT_CODE (124 = still running = PASS)"
[ "$BOOT_CODE" = "124" ] || { echo "BOOT FAILED"; tail -20 /tmp/boot-11b5.log; exit 1; }
grep -q 'chrome ready' /tmp/boot-11b5.log && echo "renderer started"
test -d /tmp/boot11b5home/.config/Pigeonhole && echo "app data dir created"

echo "== done: $OUT_ZIP"
