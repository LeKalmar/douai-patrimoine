/**
 * Client Cloudflare R2 minimal (API S3-compatible), sans dépendance npm.
 * Implémente la signature AWS SigV4 à la main avec node:crypto — le projet
 * revendique explicitement "aucune dépendance npm" (voir CLAUDE.md), donc pas
 * de @aws-sdk/client-s3 ici.
 *
 * Config via variables d'environnement (jamais commitées) :
 *   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *
 * Utilisé par : api/recolement.mjs, api/spolies.mjs, scripts/build-inventory.mjs,
 * scripts/upload-xml-to-r2.mjs, scripts/test-r2.mjs.
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

function amzDate() {
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
}

function sign({ method, path, host, payloadHash, extraHeaders, accessKeyId, secretAccessKey }) {
  const date = amzDate();
  const dateStamp = date.slice(0, 8);

  const headers = { host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': date, ...extraHeaders };
  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map(h => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeadersStr = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri(path),
    '', // pas de query string
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

/** Lit un objet R2. Renvoie {body, etag} ou null si absent (404). */
export async function r2Get(key) {
  const res = await r2Fetch('GET', key, '');
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`R2 GET ${key} a échoué (${res.status}) : ${res.body.toString('utf8').slice(0, 300)}`);
  }
  return { body: res.body.toString('utf8'), etag: res.headers.etag };
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
