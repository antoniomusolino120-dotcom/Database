const SOURCES = [
  'https://cdn.jsdelivr.net/gh/RP92/comuni-italiani@main/data/comuni.json',
  'https://raw.githubusercontent.com/RP92/comuni-italiani/main/data/comuni.json'
];

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export function normalizeMunicipalityRows(input) {
  const raw = Array.isArray(input) ? input : Array.isArray(input?.comuni) ? input.comuni : [];
  const rows = raw.map((r, idx) => ({
    sourceId: String(r.codice || r.codiceCatastale || r.codiceIstat || r.codice_istat || r.istat || r.id || '').trim(),
    name: String(r.nome || r.comune || r.denominazione || r.name || '').trim(),
    province: String((typeof r.provincia === 'object' ? r.provincia?.nome : r.provincia) || r.nomeProvincia || (typeof r.province === 'object' ? r.province?.name : r.province) || '').trim(),
    provinceCode: String(r.sigla || (typeof r.provincia === 'object' ? r.provincia?.sigla : '') || r.siglaProvincia || r.provinceCode || '').trim().toUpperCase(),
    region: String((typeof r.regione === 'object' ? r.regione?.nome : r.regione) || r.nomeRegione || (typeof r.region === 'object' ? r.region?.name : r.region) || '').trim(),
    originalIndex: idx
  })).filter(r => r.name);

  rows.sort((a,b) => a.name.localeCompare(b.name, 'it', {sensitivity:'base'}) ||
    a.provinceCode.localeCompare(b.provinceCode) || a.province.localeCompare(b.province));

  return rows.map((r, i) => ({
    ...r,
    queueIndex: i + 1,
    queueCode: `COMUNE-${String(i + 1).padStart(5,'0')}`,
    municipalityId: r.sourceId || `${r.provinceCode || 'XX'}:${r.name.toLocaleLowerCase('it-IT')}`
  }));
}

export function buildMunicipalityQuery(variant, municipality) {
  const parts = [variant, municipality.name];
  if (municipality.provinceCode) parts.push(municipality.provinceCode);
  else if (municipality.province) parts.push(municipality.province);
  parts.push('Italia');
  return parts.filter(Boolean).join(' ');
}

export class MunicipalityService {
  constructor(db, event = () => {}) {
    this.db = db;
    this.event = event;
  }

  async fetchList() {
    let lastError;
    for (const url of SOURCES) {
      const t = timeoutSignal(20000);
      try {
        const res = await fetch(url, { signal:t.signal, cache:'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = normalizeMunicipalityRows(await res.json());
        if (rows.length < 7000) throw new Error(`Elenco incompleto (${rows.length})`);
        this.db.replaceMunicipalitiesIfEmpty(rows);
        this.db.setSetting('municipalitySource', {url, loadedAt:new Date().toISOString(), count:rows.length});
        this.event({type:'municipalities-loaded',count:rows.length,source:url});
        return rows.length;
      } catch (err) {
        lastError = err;
      } finally { t.clear(); }
    }
    throw new Error(`Impossibile caricare l'elenco dei comuni: ${lastError?.message || 'errore sconosciuto'}`);
  }

  async ensureLoaded() {
    const count = this.db.municipalityCount();
    if (count >= 7000) return count;
    return this.fetchList();
  }
}
