/**
 * marc-xml.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Parseur MARC-XML minimaliste partagé par les scripts de build (inventaire
 * principal + magasins). Le MARC-XML étant très régulier, quelques regex
 * suffisent et sont nettement plus rapides que d'instancier un DOM complet
 * sur des fichiers de plusieurs dizaines de Mo.
 *
 * Aucune dépendance npm. Node ≥ 18.
 * ────────────────────────────────────────────────────────────────────────────
 */

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

export function* iterateRecords(xml) {
  const re = /<record\b[^>]*>([\s\S]*?)<\/record>/g;
  let m;
  while ((m = re.exec(xml))) yield m[1];
}

export function parseRecord(recordXml) {
  const rec = { controlfields: {}, datafields: [] };

  const leader = recordXml.match(/<leader>([^<]*)<\/leader>/);
  if (leader) rec.leader = decodeXml(leader[1]);

  const cfRe = /<controlfield\s+tag="([^"]+)">([^<]*)<\/controlfield>/g;
  let m;
  while ((m = cfRe.exec(recordXml))) {
    rec.controlfields[m[1]] = decodeXml(m[2]);
  }

  const dfRe = /<datafield\s+tag="([^"]+)"[^>]*>([\s\S]*?)<\/datafield>/g;
  while ((m = dfRe.exec(recordXml))) {
    const tag = m[1];
    const inner = m[2];
    const subfields = [];
    const sfRe = /<subfield\s+code="([^"]+)">([\s\S]*?)<\/subfield>/g;
    let sm;
    while ((sm = sfRe.exec(inner))) {
      // Ignorer le sous-champ '#' que Syracuse ajoute partout (métadonnée
      // interne, jamais utile côté site public).
      if (sm[1] === '#') continue;
      subfields.push({ code: sm[1], value: decodeXml(sm[2]) });
    }
    rec.datafields.push({ tag, subfields });
  }

  return rec;
}

// Retourne la première valeur trouvée pour un couple (tag, code), ou null.
export function getSubfield(record, tag, code) {
  for (const df of record.datafields) {
    if (df.tag !== tag) continue;
    for (const sf of df.subfields) {
      if (sf.code === code) return sf.value;
    }
  }
  return null;
}

// Retourne TOUS les $s pour tous les $tag (utile pour $940$s multi-cotes).
export function getAllSubfields(record, tag, code) {
  const out = [];
  for (const df of record.datafields) {
    if (df.tag !== tag) continue;
    for (const sf of df.subfields) {
      if (sf.code === code) out.push(sf.value);
    }
  }
  return out;
}

// Convertit un record parsé en objet plat { "200$a": "...", "700$a": "..." }
// Les répétitions sont concaténées avec le séparateur fourni (multiSep).
export function flatten(record, whitelist = null, multiSep = '§') {
  const out = {};
  for (const df of record.datafields) {
    if (whitelist && !whitelist.includes(df.tag)) continue;
    for (const sf of df.subfields) {
      const key = `${df.tag}$${sf.code}`;
      if (out[key] === undefined) out[key] = sf.value;
      else out[key] = out[key] + multiSep + sf.value;
    }
  }
  return out;
}
