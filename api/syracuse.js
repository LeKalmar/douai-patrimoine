// api/syracuse.js
export default async function handler(req, res) {
  const { endpoint, payload } = req.body;

  const allowed = {
    'search':   'https://www.bm-douai.fr/Portal/Recherche/Search.svc/GetRecord',
    'holdings': 'https://www.bm-douai.fr/Portal/Services/ILSClient.svc/GetHoldings',
  };
  const url = allowed[endpoint];
  if (!url) return res.status(400).json({ error: 'endpoint inconnu' });

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': 'https://www.bm-douai.fr/',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    // Cache CDN Vercel : 1 h navigateur, 24 h edge
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}