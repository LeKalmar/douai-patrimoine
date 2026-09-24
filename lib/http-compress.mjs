/**
 * http-compress.mjs
 * ────────────────────────────────────────────────────────────────────────────
 * Négociation de `Content-Encoding` pour les réponses servies par le serveur
 * local (scripts/dev-server.mjs) et les fonctions `api/*.mjs`.
 *
 * Pourquoi ce fichier : tant que le site était servi par Vercel, la
 * compression était posée par le CDN, jamais par notre code — d'où son
 * absence complète ici. En hébergement local (`npm run dev`, y compris servi
 * aux autres postes du réseau), plus aucun intermédiaire ne la pose : la
 * réponse de `/api/inventaire` partait telle quelle, soit 21,2 Mo par
 * chargement de `inventaire.html`. Mesuré sur l'export courant (26 228
 * notices) :
 *
 *     brut       21,25 Mo
 *     gzip n. 6   3,15 Mo   (508 ms)
 *     brotli q5   2,40 Mo   (759 ms)
 *
 * Soit ~9× moins d'octets sur le fil. Le coût CPU de la compression n'est
 * payé qu'une fois par entrée de cache (voir `compressibleBody()` ci-dessous,
 * qui mémorise les variantes à côté du corps brut) et non à chaque requête —
 * sans quoi on remplacerait un transfert lent par un serveur lent.
 *
 * Brotli d'abord quand le client l'accepte (tous les navigateurs visés le
 * font) : 24 % de moins que gzip pour ~250 ms de plus, amortis sur toute la
 * durée de vie de l'entrée de cache. Le corps brut reste servi tel quel à un
 * client qui n'annonce ni l'un ni l'autre (curl sans `--compressed`,
 * `scripts/verify-json-parity.mjs`).
 *
 * Seuil : en dessous de MIN_BYTES, compresser coûte plus (CPU + en-têtes)
 * que ça ne rapporte.
 */
import zlib from 'node:zlib';

const MIN_BYTES = 1024;

/* Qualité choisie pour le meilleur rapport octets/CPU sur des corps mis en
   cache : brotli q5 approche q11 (2,40 vs ~2,2 Mo ici) pour une fraction de
   son temps, qui se compte en secondes sur 21 Mo. */
const BROTLI_OPTS = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } };
const GZIP_OPTS = { level: 6 };

/** 'br' | 'gzip' | null — ce que le client accepte, par ordre de préférence. */
export function negotiateEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (accept.includes('br')) return 'br';
  if (accept.includes('gzip')) return 'gzip';
  return null;
}

/**
 * Enveloppe un corps (string ou Buffer) en un objet qui compresse à la
 * demande et retient le résultat. À stocker en cache tel quel : la deuxième
 * requête qui demande la même variante ne recompresse pas.
 */
export function compressibleBody(body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const variants = new Map();
  return {
    raw,
    /** Buffer compressé pour l'encodage demandé, ou `raw` si non compressible. */
    encoded(encoding) {
      if (!encoding || raw.length < MIN_BYTES) return raw;
      let hit = variants.get(encoding);
      if (!hit) {
        hit = encoding === 'br' ? zlib.brotliCompressSync(raw, BROTLI_OPTS)
                                : zlib.gzipSync(raw, GZIP_OPTS);
        variants.set(encoding, hit);
      }
      return hit;
    },
  };
}

/**
 * Écrit `body` (objet de compressibleBody(), string ou Buffer) sur `res` avec
 * l'encodage négocié. Pose toujours `Vary: Accept-Encoding` — sans lui, un
 * cache intermédiaire pourrait resservir une réponse brotli à un client qui
 * ne l'accepte pas.
 */
export function sendCompressed(req, res, body, { status = 200 } = {}) {
  const payload = (body && typeof body.encoded === 'function') ? body : compressibleBody(body);
  const encoding = negotiateEncoding(req);
  const out = payload.encoded(encoding);

  const prevVary = res.getHeader('Vary');
  res.setHeader('Vary', prevVary ? `${prevVary}, Accept-Encoding` : 'Accept-Encoding');
  if (out !== payload.raw) res.setHeader('Content-Encoding', encoding);
  res.setHeader('Content-Length', String(out.length));
  res.statusCode = status;
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(out);
}
