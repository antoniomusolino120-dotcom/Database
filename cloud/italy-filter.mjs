function numberValue(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(String(value).trim().replace(',','.'));
  return Number.isFinite(n)?n:null;
}

// Bounding box volutamente larga: deve escludere solo risultati chiaramente fuori Italia.
// I casi di confine restano affidati al filtro testuale isExplicitForeign già presente nel collector.
export const ITALY_SAFE_BOUNDS={minLat:35.0,maxLat:47.7,minLng:5.5,maxLng:19.5};

export function isClearlyOutsideItaly(item={}){
  const lat=numberValue(item.lat ?? item.latitude);
  const lng=numberValue(item.lng ?? item.lon ?? item.longitude);
  if(lat!==null&&lng!==null){
    const b=ITALY_SAFE_BOUNDS;
    if(lat<b.minLat||lat>b.maxLat||lng<b.minLng||lng>b.maxLng)return true;
  }

  const address=String(item.address||'').replace(/\s+/g,' ').trim();
  if(!address)return false;

  // Google Maps spesso omette "United States" e lascia solo "City, ST ZIP".
  const usStates='AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
  if(new RegExp(`,\\s*(?:${usStates})\\s+\\d{5}(?:-\\d{4})?\\b`,'i').test(address))return true;

  // Canada: es. Toronto, ON M5V 3A8.
  if(/,\s*[A-Z]{2}\s+[A-Z]\d[A-Z]\s?\d[A-Z]\d\b/i.test(address))return true;

  return false;
}
