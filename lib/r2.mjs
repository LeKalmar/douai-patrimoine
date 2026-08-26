/**
 * Client Cloudflare R2 minimal (API S3-compatible), sans dépendance npm.
 * Implémente la signature AWS SigV4 à la main avec node:crypto — le projet
 * revendique explicitement "aucune dépendance npm" (voir CLAUDE.md), donc pas
 * de @aws-sdk/client-s3 ici.
 *
 * Config via variables d'environnement (jamais commitées) :
 *   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Utilisé par : api/recolement.mjs, api/spolies.mjs, api/exemplaires-manuels.mjs,
 * api/vignette.mjs, scripts/build-inventory.mjs, scripts/upload-xml-to-r2.mjs,
 * scripts/test-r2.mjs.
 */
import { createHmac, createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const REGION = 'auto';
const SERVICE = 's3';

export function r2Configured() {
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_BUCKET &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY
  );
}

function getConfig() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'R2 non configuré : R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY manquant(s).'
    );
  }
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key, data) {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

// Encodage AWS "URI-encode chaque segment de chemin, préserve les '/'".
function uriEscape(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function canonicalUri(path) {
  return path.split('/').map(uriEscape).join('/');
}

// Chaîne de requête canonique SigV4 : paires "clé=valeur" URI-encodées,
// triées par clé encodée, jointes par "&" — utilisé pour ListObjectsV2
// (seule requête signée du projet à porter une query string).
function canonicalQueryString(query) {
  if (!query) return '';
  return Object.keys(query)
    .sort()
    .map(k => `${uriEscape(k)}=${uriEscape(String(query[k]))}`)
    .join('&');
}

function amzDate() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
}

function sign({ method, path, host, payloadHash, extraHeaders, accessKeyId, secretAccessKey, query }) {
  const date = amzDate();
  const dateStamp = date.slice(0, 8);

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, ...extraHeaders };
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map(h => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeadersStr = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri(path),
    canonicalQueryString(query),
    canonicalHeaders,
    signedHeadersStr,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
  return headers;
}

function rawRequest(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ method, hostname, path, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function r2Fetch(method, key, body, extraHeaders = {}) {
  const { accountId, bucket, accessKeyId, secretAccessKey } = getConfig();
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key}`;
  const payloadHash = sha256Hex(body || '');
  // R2 exige un Content-Length explicite sur les requêtes avec corps (sinon
  // Node bascule en Transfer-Encoding: chunked, que R2 rejette avec un 411
  // MissingContentLength — observé en pratique sur un gros PUT). On ne
  // l'ajoute que si un corps est réellement envoyé : sur un GET/DELETE sans
  // corps, Node ne transmet pas toujours un Content-Length:0 déclaré ici,
  // ce qui désynchronise la signature (SignatureDoesNotMatch) si on
  // l'inclut quand même dans les en-têtes signés.
  const allExtraHeaders = body ? { ...extraHeaders, 'content-length': String(Buffer.byteLength(body)) } : { ...extraHeaders };
  const headers = sign({ method, path, host, payloadHash, extraHeaders: allExtraHeaders, accessKeyId, secretAccessKey });
  return rawRequest(host, canonicalUri(path), method, headers, body);
}

function stripTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1] : null;
}
function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Liste les objets R2 sous un préfixe (API S3 ListObjectsV2), triés par clé
 * croissante par R2 — jusqu'à `maxKeys` entrées. Parsing XML minimal (pas de
 * dépendance npm) : suffisant, la forme de la réponse S3 est stable et les
 * clés utilisées par ce projet ne contiennent aucun caractère XML spécial.
 */
export async function r2List(prefix, maxKeys = 100) {
  const { accountId, bucket, accessKeyId, secretAccessKey } = getConfig();
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const path = `/${bucket}`;
  const query = { 'list-type': '2', prefix, 'max-keys': String(maxKeys) };
  const payloadHash = sha256Hex('');
  const headers = sign({ method: 'GET', path, host, payloadHash, extraHeaders: {}, accessKeyId, secretAccessKey, query });
  const res = await rawRequest(host, `${canonicalUri(path)}?${canonicalQueryString(query)}`, 'GET', headers, null);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`R2 List ${prefix} a échoué (${res.status}) : ${res.body.toString('utf8').slice(0, 300)}`);
  }
  const xml = res.body.toString('utf8');
  const items = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const key = stripTag(block, 'Key');
    if (!key) continue;
    const lastModified = stripTag(block, 'LastModified');
    const size = stripTag(block, 'Size');
    items.push({ key: decodeXmlEntities(key), lastModified, size: size ? parseInt(size, 10) : 0 });
  }
  return items;
}

/**
 * Lit un objet R2. Renvoie {body, etag} ou null si absent (404).
 * `raw:true` renvoie body sous forme de Buffer plutôt que de string décodée
 * en UTF-8 — nécessaire pour un objet dont la taille dépasse la limite de
 * longueur d'une string V8 (~512 Mo, cf. xml/bib.xml) : un `.toString('utf8')`
 * sur un buffer de cette taille lèverait ERR_STRING_TOO_LONG.
 */
export async function r2Get(key, { raw = false } = {}) {
  const res = await r2Fetch('GET', key, '');
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`R2 GET ${key} a échoué (${res.status}) : ${res.body.toString('utf8').slice(0, 300)}`);
  }
  return { body: raw ? res.body : res.body.toString('utf8'), etag: res.headers.etag };
}

/**
 * Écrit un objet R2. opts.ifMatch / opts.ifNoneMatch pour une écriture
 * conditionnelle (extension S3 supportée par R2) — lève une erreur
 * { conflict: true } en cas de 409/412 pour permettre un retry en amont.
 */
export async function r2Put(key, body, opts = {}) {
  const extraHeaders = { 'content-type': opts.contentType || 'application/json; charset=utf-8' };
  if (opts.ifMatch) extraHeaders['if-match'] = opts.ifMatch;
  if (opts.ifNoneMatch) extraHeaders['if-none-match'] = opts.ifNoneMatch;
  const res = await r2Fetch('PUT', key, body, extraHeaders);
  if (res.status === 409 || res.status === 412) {
    const err = new Error(`R2 PUT ${key} : conflit d'écriture (etag)`);
    err.conflict = true;
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`R2 PUT ${key} a échoué (${res.status}) : ${res.body.toString('utf8').slice(0, 300)}`);
  }
  return { etag: res.headers.etag };
}

export async function r2Delete(key) {
  const res = await r2Fetch('DELETE', key, '');
  if (res.status < 200 || res.status >= 300 && res.status !== 404) {
    throw new Error(`R2 DELETE ${key} a échoué (${res.status})`);
  }
}

/**
 * Lecture-modification-écriture atomique via ETag (compare-and-swap) :
 * relit l'objet, applique `mutate(currentValue)`, réécrit avec If-Match
 * (ou If-None-Match: '*' si l'objet n'existait pas encore), et retente en
 * cas de conflit (un autre écrivain a modifié l'objet entre-temps). Évite
 * qu'une écriture concurrente n'écrase silencieusement celle d'un collègue.
 */
export async function r2CasUpdate(key, mutate, initialValue) {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const current = await r2Get(key);
    const data = current ? JSON.parse(current.body) : (typeof initialValue === 'function' ? initialValue() : initialValue);
    const updated = mutate(data);
    const body = JSON.stringify(updated);
    try {
      await r2Put(key, body, current ? { ifMatch: current.etag } : { ifNoneMatch: '*' });
      return updated;
    } catch (err) {
      if (err.conflict && attempt < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, 40 * 2 ** attempt + Math.random() * 40));
        continue;
      }
      throw err;
    }
  }
}
