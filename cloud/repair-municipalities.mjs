const EXPECTED_TOTAL = 7894;
const START_NR = Number(process.env.START_NR || 1790);
const APPLY = String(process.env.APPLY || '') === '1';
const ENDPOINT = String(process.env.SHEET_ENDPOINT || '').trim();
const BATCH_SIZE = Math.max(25, Math.min(200, Number(process.env.BATCH_SIZE || 100)));

const SUT_URL = 'https://raw.githubusercontent.com/aborruso/archivioDatiPubbliciPreziosi/36f99cc057ebef653b44c8ba8b921e8b81a656bc/docs/sistemaUnicoTerritoriale/comuniSistemaUnicoTerritoriale.csv';
const AUX_URL = 'https://raw.githubusercontent.com/opendatasicilia/comuni-italiani/af99645c2f83d5734e7aca526f2c0355a5c0fef8/dati/comuni.csv';
const PROVINCES_URL = 'https://raw.githubusercontent.com/samuelefrasca/Province-Italia/1ac4373fffef58c97754d5fb5e68ade3b336a271/data/province.json';

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Database municipality repair/1.1' } });
  if (!res.ok) throw new Error(`Fetch ${url} -> HTTP ${res.status}`);
  return res.text();
}

function clean(v) { return String(v ?? '').trim(); }
function upper(v) { return clean(v).toLocaleUpperCase('it-IT'); }

function parseSut(text) {
  const csv = parseCsv(text);
  const header = csv.shift().map(upper);
  const idx = name => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Colonna SUT mancante: ${name}`);
    return i;
  };
  const iNr = idx('NR.');
  const iName = idx('DESCRIZIONE COMUNE');
  const iSigla = idx('SIGLA');
  const iIstat = idx('CODICE ISTAT');
  return csv.map(r => ({
    nr: Number(r[iNr]),
    sourceName: clean(r[iName]),
    provinceCode: upper(r[iSigla]),
    municipalityId: clean(r[iIstat]).padStart(6, '0'),
  }));
}

function parseAux(text) {
  const csv = parseCsv(text);
  const header = csv.shift().map(clean);
  const idx = name => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`Colonna AUX mancante: ${name}`);
    return i;
  };
  const iName = idx('comune');
  const iId = idx('pro_com_t');
  const byId = new Map();
  for (const r of csv) {
    const municipalityId = clean(r[iId]).padStart(6, '0');
    const name = clean(r[iName]);
    if (municipalityId && name) byId.set(municipalityId, { municipalityId, name });
  }
  return { byId };
}

function parseProvinces(text) {
  const parsed = JSON.parse(text);
  const bySigla = new Map();
  for (const [regionName, items] of Object.entries(parsed || {})) {
    for (const item of Array.isArray(items) ? items : []) {
      const sigla = upper(item?.sigla);
      const province = clean(item?.nome);
      const region = clean(item?.regione || regionName);
      if (!sigla || !province || !region) continue;
      if (bySigla.has(sigla)) throw new Error(`Sigla provincia duplicata nella fonte province: ${sigla}`);
      bySigla.set(sigla, { province, region });
    }
  }
  if (bySigla.size < 100) throw new Error(`Fonte province incompleta: solo ${bySigla.size} sigle`);
  return bySigla;
}

function canonicalName(sut, aux) {
  if (sut.municipalityId === '024129') return 'Castegnero Nanto';
  if (sut.municipalityId === '008063') return 'Vallecrosia al mare';
  if (aux?.name) return aux.name;
  return sut.sourceName.toLocaleLowerCase('it-IT').replace(/(^|[\s/'’-])([a-zà-ÿ])/giu, (_, p, c) => p + c.toLocaleUpperCase('it-IT'));
}

function assertSource(rows) {
  if (rows.length !== EXPECTED_TOTAL) throw new Error(`Fonte SUT inattesa: ${rows.length} comuni, attesi ${EXPECTED_TOTAL}`);
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.nr !== i + 1) throw new Error(`Sequenza NR interrotta a indice ${i}: trovato ${r.nr}`);
    if (!/^\d{6}$/.test(r.municipalityId)) throw new Error(`Codice ISTAT non valido NR ${r.nr}: ${r.municipalityId}`);
    if (ids.has(r.municipalityId)) throw new Error(`Codice ISTAT duplicato: ${r.municipalityId}`);
    ids.add(r.municipalityId);
  }
  const expect = (nr, id, name, sigla) => {
    const r = rows[nr - 1];
    if (!r || r.municipalityId !== id || upper(r.sourceName) !== upper(name) || r.provinceCode !== sigla) {
      throw new Error(`Controllo fonte fallito NR ${nr}: ${JSON.stringify(r)}`);
    }
  };
  expect(1790, '075096', 'CASTRO', 'LE');
  expect(1791, '016065', 'CASTRO', 'BG');
  expect(1792, '060023', 'CASTRO DEI VOLSCI', 'FR');
  const caste = rows.find(r => r.municipalityId === '024129');
  if (!caste || upper(caste.sourceName) !== 'CASTEGNERO NANTO') throw new Error('Castegnero Nanto 024129 assente dalla fonte corrente');
  if (rows.some(r => r.municipalityId === '024027' || r.municipalityId === '024071' || r.municipalityId === '018082')) {
    throw new Error('La fonte corrente contiene ancora Castegnero/Nanto/Lirio soppressi');
  }
  const valle = rows.find(r => r.municipalityId === '008063');
  if (!valle || upper(valle.sourceName) !== 'VALLECROSIA AL MARE') throw new Error('Ridenominazione Vallecrosia al mare non presente');
}

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

const [sutText, auxText, provincesText] = await Promise.all([
  fetchText(SUT_URL),
  fetchText(AUX_URL),
  fetchText(PROVINCES_URL),
]);
const source = parseSut(sutText);
assertSource(source);
const aux = parseAux(auxText);
const provinces = parseProvinces(provincesText);

const normalized = source.map(sut => {
  const auxRow = aux.byId.get(sut.municipalityId);
  const geo = provinces.get(sut.provinceCode);
  if (!geo?.province || !geo?.region) throw new Error(`Provincia/regione non risolta per ${sut.nr} ${sut.sourceName} ${sut.municipalityId} ${sut.provinceCode}`);
  return {
    queueCode: `COMUNE-${String(sut.nr).padStart(5, '0')}`,
    municipalityId: sut.municipalityId,
    name: canonicalName(sut, auxRow),
    province: geo.province,
    provinceCode: sut.provinceCode,
    region: geo.region,
    status: 'TODO',
    foundCount: 0,
    newCount: 0,
    duplicateCount: 0,
    foreignCount: 0,
    lastScanAt: '',
    errorText: '',
  };
});

const suffix = normalized.filter((_, i) => i + 1 >= START_NR);
if (suffix.length !== EXPECTED_TOTAL - START_NR + 1) throw new Error(`Suffix inatteso: ${suffix.length}`);

console.log(JSON.stringify({
  mode: APPLY ? 'apply' : 'validate',
  sourceCount: source.length,
  provinceCount: provinces.size,
  startNr: START_NR,
  suffixCount: suffix.length,
  first: suffix[0],
  last: suffix[suffix.length - 1],
}, null, 2));

if (APPLY) {
  for (let i = 0; i < suffix.length; i += BATCH_SIZE) {
    const batch = suffix.slice(i, i + BATCH_SIZE);
    await post('upsertMunicipalities', { rows: batch });
    console.log(`written ${Math.min(i + batch.length, suffix.length)}/${suffix.length}`);
  }
  console.log('Municipality suffix rebuild complete.');
}
