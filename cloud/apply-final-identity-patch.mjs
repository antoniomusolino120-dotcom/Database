import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';

const ENDPOINT = String(process.env.SHEET_ENDPOINT || '').trim();
const BATCH_SIZE = Math.max(10, Math.min(100, Number(process.env.BATCH_SIZE || 50)));
const EXPECTED = 635;

if (!ENDPOINT) throw new Error('SHEET_ENDPOINT mancante');

const encoded = [
  'cloud/final-identity-patch.part1.b64',
  'cloud/final-identity-patch.part2.b64',
].map(p => fs.readFileSync(p, 'utf8').trim()).join('');

const patch = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'));
if (!Array.isArray(patch) || patch.length !== EXPECTED) {
  throw new Error(`Patch identity inattesa: ${Array.isArray(patch) ? patch.length : 'non-array'}, attese ${EXPECTED}`);
}

async function post(rows) {
  let last;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type':'text/plain;charset=utf-8'},
        body: JSON.stringify({action:'upsertMunicipalities', rows}),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`Bridge HTTP ${res.status}`);
      const data = await res.json();
      if (data?.ok !== true) throw new Error(data?.error || 'upsertMunicipalities fallita');
      return data;
    } catch (err) {
      last = err;
      if (attempt < 6) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  throw last;
}

const rows = patch.map(item => {
  if (!Array.isArray(item) || item.length !== 6) throw new Error(`Riga patch malformata: ${JSON.stringify(item)}`);
  const [sheetRow, municipalityId, name, province, provinceCode, region] = item;
  if (!Number.isInteger(sheetRow) || sheetRow < 2 || sheetRow > 7895) throw new Error(`sheetRow non valida: ${sheetRow}`);
  const queueCode = `COMUNE-${String(sheetRow - 1).padStart(5, '0')}`;
  return {
    queueCode,
    municipalityId: String(municipalityId),
    name: String(name),
    province: String(province),
    provinceCode: String(provinceCode),
    region: String(region),
    status: 'TODO',
    foundCount: 0,
    newCount: 0,
    duplicateCount: 0,
    foreignCount: 0,
    lastScanAt: '',
    errorText: '',
  };
});

const ids = new Set(rows.map(r => r.municipalityId));
if (ids.size !== rows.length) throw new Error(`ID duplicati nella patch: ${rows.length - ids.size}`);
console.log(JSON.stringify({patchRows:rows.length, first:rows[0], last:rows.at(-1)}, null, 2));

for (let i = 0; i < rows.length; i += BATCH_SIZE) {
  const batch = rows.slice(i, i + BATCH_SIZE);
  await post(batch);
  console.log(`written ${Math.min(i + batch.length, rows.length)}/${rows.length}`);
}
console.log('Final identity patch complete.');
