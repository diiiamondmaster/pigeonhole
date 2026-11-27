#!/usr/bin/env node
// Embed build/icon.ico into a Windows exe's resources (RT_ICON /
// RT_GROUP_ICON) and stamp the Win version info to match the release.
//
//   node scripts/patch-exe-icon.mjs <exe> [icon.ico] [version]
//
// Runs on Linux (pure-JS PE editing via resedit). This is the step the
// manual zip build was always missing: electron.exe carries Electron's own
// icon, and renaming it to Pigeonhole.exe kept that icon. With this, the
// amber pigeonhole mark travels with the exe.
import fs from 'fs';
import path from 'path';
import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit';

const exePath = process.argv[2];
const icoPath = process.argv[3] || path.resolve('build/icon.ico');
const version = process.argv[4] || null;

if (!exePath || !fs.existsSync(exePath)) {
  console.error('usage: node scripts/patch-exe-icon.mjs <exe> [icon.ico] [version]');
  process.exit(1);
}

const buf = fs.readFileSync(exePath);
const exe = NtExecutable.from(buf);
const res = NtExecutableResource.from(exe);

// ---- replace the icon group ----
// replaceIconsForResource mutates res.entries in place: unused RT_ICONs are
// dropped, new frames are appended, and the group header is regenerated.
// Electron's exe carries one group: id 1, lang 1033 (en-US) - replacing THAT
// (instead of inventing a second group) also cleans up its old frames.
const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
const icons = iconFile.icons.map((i) => i.data);
Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, icons);
console.log(`[patch-exe] embedded ${icons.length} icon frames -> RT_GROUP_ICON #1 (lang 1033)`);

// ---- version stamp (Properties > Details) ----
if (version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-.](.+))?$/.exec(version);
  if (m) {
    const quadruple = [Number(m[1]), Number(m[2]), Number(m[3]), 0];   // major.minor.patch.0
    const strings = [{
      lang: 1033, codepage: 1200,
      values: {
        ProductName: 'Pigeonhole',
        FileDescription: 'Pigeonhole - per-workspace browser with isolated identities',
        FileVersion: version,
        ProductVersion: version,
        OriginalFilename: path.basename(exePath)
      }
    }];
    const vi = Resource.VersionInfo.create({ strings });
    vi.lang = 1033;   // match Electron's VS_VERSIONINFO identity so it is replaced, not duplicated
    vi.setFileVersion(quadruple[0], quadruple[1], quadruple[2], quadruple[3], 1033);
    vi.setProductVersion(quadruple[0], quadruple[1], quadruple[2], quadruple[3], 1033);
    const oldCount = res.entries.filter((e) => e.type === 16 /* RT_VERSION */).length;
    vi.outputToResourceEntries(res.entries);
    console.log(`[patch-exe] version stamp -> ${version} (replaced ${oldCount} old block(s))`);
  }
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`[patch-exe] wrote ${exePath} (${Math.round(fs.statSync(exePath).size / 1e6)} MB)`);
