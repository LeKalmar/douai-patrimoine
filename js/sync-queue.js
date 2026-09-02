/* ════════════════════════════════════════════════════════════════════════
   FILE D'ATTENTE DE SYNCHRONISATION VERS LES ENDPOINTS D'ÉTAT PARTAGÉ

   Cinq pages (livres-spolies, exemplarisation, transfert-magasins,
   reliures, rotobib) suivaient le même patron, recopié ligne pour ligne :
   le localStorage fait foi localement, chaque changement est empilé dans une
   file `rp_*_pending_sync`, et la file est vidée en arrière-plan vers
   /api/<quelque chose> — à la reconnexion, toutes les 20 s, et au retour de
   l'événement `online`. Un correctif appliqué à l'une ne l'était pas aux
   autres ; ce module leur donne une implémentation unique.

   ─── PAS DE PERTE EN CAS DE PANNE ───
   Un patch n'est retiré de la file qu'après une réponse HTTP réellement
   favorable. Réseau coupé, 401, 503, 5xx : on s'arrête sur place, la file
   reste intacte dans le localStorage et sera rejouée au prochain essai —
   dans l'ordre, ce qui compte pour des patchs qui se succèdent sur le même
   enregistrement.

   ─── CE QUI RESTE HORS DE CE MODULE ───
   recolement.html garde sa propre file. Elle n'est pas identique aux cinq
   autres : elle regroupe les patchs par lots de 200 (patch `batch` côté
   api/recolement.mjs, pour qu'une longue session hors ligne ne se rejoue pas
   en un aller-retour réseau par scan), elle écrit via safeSetLocal() plutôt
   que localStorage.setItem() directement, et son indicateur affiche en plus
   l'état « stockage local plein » — trois comportements issus d'incidents
   réels sur le récolement (voir CLAUDE.md). Les rapatrier ici derrière trois
   options qu'une seule page utiliserait n'aurait pas simplifié grand-chose,
   au prix d'un risque sur le chemin d'écriture des données de récolement.
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* Tous les accès aux globales du navigateur passent par `global` plutôt
     que par leur nom nu. Dans une page, les deux reviennent au même ; mais
     cela rend le module exécutable — donc testable — hors navigateur, avec
     un environnement fourni de l'extérieur. */

  function authHeaders() {
    const token = global.sessionStorage.getItem('rp_admin_token');
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Basic ' + token;
    return h;
  }

  /* options :
       storageKey  — clé localStorage de la file (rp_*_pending_sync)
       endpoint    — URL, ou fonction (item) => URL pour les pages qui
                     écrivent vers plusieurs endpoints (exemplarisation,
                     transfert-magasins postent aussi vers /api/recolement)
       bodyOf      — facultatif : (item) => corps JSON envoyé. Par défaut
                     l'élément lui-même ; les files multi-endpoints stockent
                     {endpoint, patch} et ne postent que `patch`.
       statusId    — id de l'élément d'état (défaut 'sync-status') */
  function createSyncQueue(options) {
    const storageKey = options.storageKey;
    const endpointOf = typeof options.endpoint === 'function'
      ? options.endpoint
      : function () { return options.endpoint; };
    const bodyOf = options.bodyOf || function (item) { return item; };
    const statusId = options.statusId || 'sync-status';

    let items = (function () {
      try { return JSON.parse(global.localStorage.getItem(storageKey)) || []; }
      catch (e) { return []; }
    })();
    let lastError = null;
    let flushing = false;

    function save() {
      try { global.localStorage.setItem(storageKey, JSON.stringify(items)); }
      catch (e) {
        // Quota dépassé : ne jamais laisser l'exception remonter, l'appelant
        // a presque toujours du travail après (voir l'incident du
        // 2026-09-01 sur recolement.html). La file reste valide en mémoire,
        // seule sa persistance entre deux rechargements est perdue.
        console.error(`Écriture locale impossible (${storageKey}) :`, e);
      }
    }

    function updateIndicator() {
      const el = global.document.getElementById(statusId);
      if (!el) return;
      if (items.length) {
        el.textContent = `⏳ ${items.length} en attente${lastError ? ' — ' + lastError : ''}`;
        el.classList.add('pending');
      } else {
        el.textContent = '✓ synchronisé';
        el.classList.remove('pending');
      }
    }

    async function flush() {
      if (flushing) return;
      flushing = true;
      try {
        while (items.length) {
          const item = items[0];
          let res;
          try {
            res = await global.fetch(endpointOf(item), {
              method: 'POST', headers: authHeaders(), body: JSON.stringify(bodyOf(item)),
            });
          } catch (e) {
            lastError = 'hors ligne ou serveur injoignable';
            break; // réseau indisponible : on retentera plus tard
          }
          if (res.status === 401) {
            lastError = 'non authentifié — déconnectez-vous puis reconnectez-vous depuis l\'espace professionnel';
            break;
          }
          if (res.status === 503) {
            lastError = 'R2 non configuré côté serveur (variables Vercel manquantes)';
            break;
          }
          if (!res.ok) {
            lastError = `erreur serveur (${res.status})`;
            break;
          }
          lastError = null;
          items.shift();
          save();
        }
      } finally {
        flushing = false;
        updateIndicator();
      }
    }

    function queue(item) {
      items.push(item);
      save();
      updateIndicator();
      flush();
    }

    /* Clés encore en attente d'envoi : la fusion d'un état venu du serveur
       doit les laisser tranquilles, sinon une écriture locale pas encore
       partie serait écrasée par la version d'avant du serveur. */
    function pendingKeys(keyOf) {
      const set = new Set();
      items.forEach(it => { const k = keyOf(it); if (k !== undefined && k !== null) set.add(k); });
      return set;
    }

    // Rejeu automatique : au retour du réseau, et régulièrement pour les cas
    // où l'événement `online` ne se déclenche pas (bascule de VPN, portail
    // captif, veille de l'appareil).
    global.addEventListener('online', flush);
    global.setInterval(flush, 20000);

    /* Vide la file sans rien envoyer — utilisé par le bouton « effacer mes
       modifications locales » de livres-spolies.html, qui abandonne
       délibérément ce qui n'est pas encore parti. À ne pas confondre avec
       flush(), qui vide en envoyant. */
    function clear() {
      items.length = 0;
      save();
      updateIndicator();
    }

    return {
      get items() { return items; },
      get lastError() { return lastError; },
      queue, flush, clear, updateIndicator, pendingKeys, authHeaders,
    };
  }

  global.createSyncQueue = createSyncQueue;
  global.syncAuthHeaders = authHeaders;
})(typeof window !== 'undefined' ? window : globalThis);
