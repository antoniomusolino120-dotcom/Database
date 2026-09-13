import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from 'node:zlib';
import { FINAL_PATCH_GZIP_BASE64 } from './comuni-final-patch-2026-09-13.mjs';

const ENDPOINT = String(process.env.SHEET_ENDPOINT || '').trim();
const APPLY = String(process.env.APPLY || '') === '1';
const BATCH_SIZE = Math.max(10, Math.min(250, Number(process.env.BATCH_SIZE || 100)));
const EXPECTED_PATCH_ROWS = 2385;

function clean(v) { return String(v ?? '').trim(); }

async function post(action, payload = {}) {
  if (!ENDPOINT) throw new Error('SHEET_ENDPOINT mancante');
  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...payload }),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
      const data = await res.json();
      if (data?.ok !== true) throw new Error(data?.error || `Azione ${action} fallita`);
      return data;
    } catch (err) {
      last = err;
      if (attempt < 6) await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw last;
}

function decodePatch() {
  const buf = Buffer.from(FINAL_PATCH_GZIP_BASE64, 'base64');
  const decoders = [
    ['gzip', gunzipSync],
    ['zlib', inflateSync],
    ['deflate-raw', inflateRawSync],
    ['brotli', brotliDecompressSync],
  ];
  const errors = [];
  for (const [name, fn] of decoders) {
    try {
      const text = fn(buf).toString('utf8');
      const parsed = JSON.parse(text);
      console.log(`patch codec: ${name}`);
      return parsed;
    } catch (err) {
      errors.push(`${name}: ${err?.message || err}`);
    }
  }
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    console.log('patch codec: raw-json');
    return parsed;
  } catch (err) {
    errors.push(`raw-json: ${err?.message || err}`);
  }
  throw new Error(`Impossibile decodificare patch (${buf.length} bytes, head=${buf.subarray(0,8).toString('hex')}): ${errors.join(' | ')}`);
}

const patch = decodePatch();
const entries = Object.entries(patch);
if (entries.length !== EXPECTED_PATCH_ROWS) {
  throw new Error(`Patch inattesa: ${entries.length} righe, attese ${EXPECTED_PATCH_ROWS}`);
}

const rows = entries.map(([municipalityId, p]) => {
  if (!Array.isArray(p) || p.length !== 12) throw new Error(`Patch malformata per ID ${municipalityId}`);
  const row = {
    queueCode: clean(p[0]),
    municipalityId: clean(municipalityId),
    name: clean(p[1]),
    province: clean(p[2]),
    provinceCode: clean(p[3]),
    region: clean(p[4]),
    status: clean(p[5]),
    foundCount: Number(p[6] || 0),
    newCount: Number(p[7] || 0),
    duplicateCount: Number(p[8] || 0),
    foreignCount: Number(p[9] || 0),
    lastScanAt: clean(p[10]),
    errorText: clean(p[11]),
  };
  if (!/^COMUNE-\d{5}$/.test(row.queueCode)) throw new Error(`Codice coda non valido per ID ${municipalityId}: ${row.queueCode}`);
  if (!row.name || !row.province || !row.provinceCode || !row.region) throw new Error(`Identità incompleta per ID ${municipalityId}`);
  if (!['TODO', 'COMPLETED'].includes(row.status)) throw new Error(`Status non valido per ID ${municipalityId}: ${row.status}`);
  if (row.status === 'TODO') {
    if (row.foundCount || row.newCount || row.duplicateCount || row.foreignCount || row.lastScanAt || row.errorText) {
      throw new Error(`Riga TODO non azzerata per ID ${municipalityId}`);
    }
  }
  return row;
});

const completed = rows.filter(r => r.status === 'COMPLETED').length;
const todo = rows.filter(r => r.status === 'TODO').length;
console.log(JSON.stringify({ mode: APPLY ? 'apply' : 'validate', patchRows: rows.length, patchCompleted: completed, patchTodo: todo, first: rows[0], last: rows.at(-1) }, null, 2));

if (APPLY) {
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await post('upsertMunicipalities', { rows: batch });
    console.log(`written ${Math.min(i + batch.length, rows.length)}/${rows.length}`);
  }
  console.log('Exact municipality patch complete.');
}
