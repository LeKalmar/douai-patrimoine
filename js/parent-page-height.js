/* ============================================================
   HAUTEUR TRANSMISE AU SITE HÔTE (publication en iframe)
   ------------------------------------------------------------
   Le site est publié dans une iframe sur le site du réseau des
   bibliothèques. Sans rien faire, cette iframe garde la hauteur fixe que
   lui donne la page hôte : dès que le contenu est plus haut, l'iframe se
   dote de sa propre barre de défilement et le visiteur se retrouve avec
   DEUX défilements imbriqués (celui du site hôte + celui de l'iframe) —
   déroutant, surtout pour un public peu à l'aise avec l'ordinateur. Ce
   script mesure la hauteur réelle du contenu et la transmet à la page
   hôte, qui redimensionne l'iframe : il ne reste qu'un seul défilement,
   celui du site hôte.

   Message envoyé — contrat déjà en place côté site hôte, ne pas renommer :
       { type: 'iframeHeight', height: <pixels> }

   Le script pose aussi la classe `rp-embedded` sur <html> AVANT le premier
   rendu (il est chargé dans <head>, sans `defer`). C'est elle qui bascule
   les pages construites comme une application plein écran — histoire-du-
   livre.html : `html, body { height:100%; overflow:hidden }` — vers une
   mise en page de hauteur intrinsèque, seule mesurable ici. Voir les blocs
   « .rp-embedded » de style.css et de css/main.css.

   À inclure sur toute page publique susceptible d'être ouverte dans
   l'iframe (index.html, inventaire.html, histoire-du-livre.html) : la
   navigation se fait à l'intérieur de la même iframe, une page qui
   n'enverrait pas sa hauteur ramènerait le double défilement.
   ============================================================ */
(function () {
    'use strict';

    var MESSAGE_TYPE = 'iframeHeight';
    var DEBOUNCE_MS  = 120;  // une mesure après la rafale, pas une par mutation
    var MIN_DELTA    = 2;    // px : en deçà, inutile de renvoyer un message

    var embedded;
    try {
        embedded = window.self !== window.top;
    } catch (e) {
        // Accès à window.top refusé ⇒ page hôte d'une autre origine ⇒ iframe.
        embedded = true;
    }

    if (embedded && document.documentElement) {
        document.documentElement.classList.add('rp-embedded');
    }

    /* Petite API pour le reste du site : js/inventaire.js s'en sert pour
       ouvrir la visionneuse dans le flux de la page plutôt qu'en surcouche
       plein écran (une surcouche `position:fixed` se placerait par rapport à
       l'iframe entière, donc hors de l'écran du visiteur). */
    window.rpEmbed = {
        isEmbedded: embedded,
        refresh: function () { if (embedded) send(true); }
    };

    if (!embedded) return;

    var lastSent = -1;
    var timer = null;

    /* Hauteur du contenu, mesurée sur <body> et NON sur
       documentElement.scrollHeight : ce dernier vaut au minimum la hauteur
       que la page hôte vient de donner à l'iframe, il ne redescendrait donc
       jamais quand le contenu raccourcit (changement de page de résultats,
       filtre, fermeture d'un panneau) — la hauteur ne ferait que grandir. */
    function contentHeight() {
        var body = document.body;
        if (!body) return 0;
        var rect = body.getBoundingClientRect();
        var cs = window.getComputedStyle(body);
        return Math.ceil(rect.height
            + (parseFloat(cs.marginTop) || 0)
            + (parseFloat(cs.marginBottom) || 0));
    }

    function send(force) {
        var h = contentHeight();
        if (!h) return;
        if (!force && Math.abs(h - lastSent) < MIN_DELTA) return;
        lastSent = h;
        window.parent.postMessage({ type: MESSAGE_TYPE, height: h }, '*');
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = null; send(false); }, DEBOUNCE_MS);
    }

    function init() {
        send(true);

        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);

        /* Images et polices arrivent après DOMContentLoaded et changent la
           hauteur ; les catalogues (data/inventaire.json) encore après. */
        window.addEventListener('load', function () { send(true); });
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () { send(true); });
        }
        [300, 1000, 2500].forEach(function (ms) {
            setTimeout(function () { send(true); }, ms);
        });

        if (window.ResizeObserver) {
            new window.ResizeObserver(schedule).observe(document.body);
        }
        new window.MutationObserver(schedule).observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'open']
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
