#!/usr/bin/env node
// solo-export-fixer: put the images back into a website export that only ships links to them.
// Zero dependencies. Usage: node bin/fix.js <export.zip | folder> [-o outDir] [--dry-run]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const TEXT_EXT = /\.(html?|css|csv|json|txt|xml)$/i;

function readZip(buf) { // minimal ZIP reader (stored + deflate), reads the central directory
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a ZIP file');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = {};
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad ZIP directory');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42), name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.slice(ds, ds + csize);
    if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression in ' + name);
    out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
  }
  return out;
}
function readDir(dir, base = dir, out = {}) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) readDir(full, base, out);
    else out[path.relative(base, full).split(path.sep).join('/')] = fs.readFileSync(full);
  }
  return out;
}
const unescapeUrl = u => u.replace(/&amp;/g, '&');
function findUrls(name, text) { // returns the exact strings as they appear in the file
  const found = new Set();
  const all = text.match(/https?:\/\/[^\s"'<>)\\,]+/g) || [];
  const isCsv = /\.csv$/i.test(name);
  if (isCsv) { for (const u of all) found.add(u); return found; } // the image-link sheet: every URL counts
  const attr = /(?:src|srcset|poster|data-src|content)\s*=\s*["']([^"']+)["']/gi; let m;
  while ((m = attr.exec(text))) for (const part of m[1].split(/\s*,\s+/)) {
    const u = part.trim().split(/\s+/)[0];
    if (/^https?:\/\//.test(u) && (m[0].toLowerCase().startsWith('content') ? IMG_EXT.test(u.split('?')[0]) : true)) found.add(u);
  }
  const css = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
  while ((m = css.exec(text))) found.add(m[1]);
  for (const u of all) if (IMG_EXT.test(u.split(/[?#]/)[0])) found.add(u);
  return found;
}
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/avif': '.avif', 'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico', 'image/bmp': '.bmp' };
async function download(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'solo-export-fixer' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      return { type, body: Buffer.from(await r.arrayBuffer()) };
    } catch (err) { if (i >= tries) throw err; await new Promise(s => setTimeout(s, 800 * i)); }
  }
}
async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const oi = args.indexOf('-o');
  const input = args.find((a, i) => !a.startsWith('-') && (oi < 0 || i !== oi + 1));
  if (!input) { console.log('Usage: solo-export-fixer <export.zip | folder> [-o outDir] [--dry-run]'); process.exit(1); }
  const outDir = oi >= 0 ? args[oi + 1] : input.replace(/\.zip$/i, '').replace(/[\\/]+$/, '') + '-complete';
  const files = fs.statSync(input).isDirectory() ? readDir(input) : readZip(fs.readFileSync(input));
  const names = Object.keys(files);
  const texts = names.filter(n => TEXT_EXT.test(n));
  const seen = new Map(); // clean url -> { raws:Set, local }
  for (const n of texts) for (const raw of findUrls(n, files[n].toString('utf8'))) {
    const clean = unescapeUrl(raw);
    if (!seen.has(clean)) seen.set(clean, { raws: new Set(), local: null });
    seen.get(clean).raws.add(raw);
  }
  console.log(`${names.length} files in the export, ${seen.size} linked files to fetch.`);
  if (dry) { for (const u of seen.keys()) console.log('  ' + u); return; }
  const failed = []; let ok = 0, skipped = 0; const queue = [...seen.entries()];
  async function worker() {
    for (let item; (item = queue.shift());) {
      const [url, rec] = item;
      try {
        const { type, body } = await download(url);
        const urlExt = (path.extname(new URL(url).pathname).match(IMG_EXT) || [''])[0].toLowerCase();
        if (!type.startsWith('image/') && !urlExt) { skipped++; continue; } // a page link, not an image
        const ext = EXT_BY_TYPE[type] || urlExt || '.bin';
        const stem = path.basename(new URL(url).pathname, path.extname(new URL(url).pathname)).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'image';
        rec.local = `images/${stem}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)}${ext}`;
        files[rec.local] = body; ok++;
      } catch (err) { failed.push([url, err.message]); }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  const pairs = [];
  for (const rec of seen.values()) if (rec.local) for (const raw of rec.raws) pairs.push([raw, rec.local]);
  pairs.sort((a, b) => b[0].length - a[0].length); // longest first so a URL never clobbers a longer one
  for (const n of texts) {
    if (/\.csv$/i.test(n)) continue; // keep the original sheet as a record
    let t = files[n].toString('utf8'); const depth = n.split('/').length - 1;
    for (const [raw, local] of pairs) t = t.split(raw).join('../'.repeat(depth) + local);
    files[n] = Buffer.from(t);
  }
  for (const [n, b] of Object.entries(files)) {
    const dest = path.join(outDir, n);
    if (!path.resolve(dest).startsWith(path.resolve(outDir) + path.sep)) continue; // never write outside outDir
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, b);
  }
  if (failed.length) fs.writeFileSync(path.join(outDir, 'FAILED-DOWNLOADS.txt'), failed.map(f => f.join('\t')).join('\n') + '\n');
  console.log(`Saved ${ok} images, ${failed.length} failed, ${skipped} non-image links left alone.`);
  console.log(`Complete site written to: ${outDir}`);
  if (failed.length) { console.log('See FAILED-DOWNLOADS.txt for the links that could not be fetched.'); process.exitCode = 2; }
}
main().then(() => process.exit(process.exitCode || 0), e => { console.error('Error: ' + e.message); process.exit(1); });
