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
        injectBaseStyle();
    }

    /* Règle de base du mode intégré, injectée ici plutôt que posée dans une
       feuille de styles : les pages du projet ne chargent pas toutes les mêmes
       (six d'entre elles ignorent style.css), et cette règle est indissociable
       du mécanisme — une page qui inclut le script doit l'avoir, quels que
       soient ses styles. Elle rend au document une hauteur naturelle : une
       page calée sur la hauteur de l'écran (html/body en height:100% ou
       min-height:100vh, + overflow:hidden) mesurerait toujours la hauteur
       actuelle de l'iframe, jamais celle de son contenu.
       La spécificité (0,1,1) / (0,1,2) passe devant les `html, body { … }` des
       pages, où qu'ils soient déclarés. */
    function injectBaseStyle() {
        var host = document.head || document.documentElement;
        if (!host || document.getElementById('rp-embed-base-style')) return;
        var style = document.createElement('style');
        style.id = 'rp-embed-base-style';
        style.textContent =
            'html.rp-embedded, html.rp-embedded body {' +
            ' height: auto; min-height: 0; overflow: visible; }';
        host.appendChild(style);
    }

    /* Petite API pour le reste du site : js/inventaire.js s'en sert pour
       ouvrir la visionneuse dans le flux de la page plutôt qu'en surcouche
       plein écran (une surcouche `position:fixed` se placerait par rapport à
       l'iframe entière, donc hors de l'écran du visiteur). */
    window.rpEmbed = {
        isEmbedded: embedded,
        refresh: function () { if (embedded) send(true); },
        /* Vrai dès que la page hôte a transmis la zone visible (voir
           « MODALES » plus bas) : une page peut alors se dispenser de ses
           contournements (scrollIntoView vers la modale, etc.). */
        hasHostViewport: function () { return !!hostView; },
        /* À appeler juste après avoir affiché une surcouche créée à la volée,
           si du code synchrone en dépend (mesure, scrollIntoView) : sans ça,
           elle n'est placée qu'au prochain message de la page hôte. */
        placeOverlays: function () { if (embedded) placeOverlays(); }
    };

    if (!embedded) return;

    var lastSent = -1;
    var timer = null;
    /* Renvois successifs pour la même hauteur de contenu parce que le cadre
       n'a pas la bonne taille. Plafonné : si la page hôte impose une autre
       hauteur (script du portail), on ne veut pas d'un ping-pong sans fin. */
    var MAX_FRAME_RESYNC = 5;
    var frameResyncCount = 0;

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
        if (!force && Math.abs(h - lastSent) < MIN_DELTA) {
            /* Contenu inchangé… mais le cadre a-t-il encore la hauteur qu'on
               a demandée ? La page hôte peut l'avoir remise à une hauteur de
               secours (resize de sa fenêtre, 'load' de l'iframe arrivé après
               notre dernier envoi) : sans ce renvoi, l'iframe restait trop
               courte et retrouvait son propre défilement au bout de quelques
               secondes. Changer la hauteur de l'iframe déclenche un 'resize'
               ici, d'où l'on arrive. */
            if (Math.abs(window.innerHeight - h) < MIN_DELTA) return;
            if (frameResyncCount >= MAX_FRAME_RESYNC) return;
            frameResyncCount++;
        } else {
            frameResyncCount = 0;
        }
        lastSent = h;
        window.parent.postMessage({ type: MESSAGE_TYPE, height: h }, '*');
    }

    function schedule() {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { timer = null; send(false); }, DEBOUNCE_MS);
    }

    /* ── MODALES ─────────────────────────────────────────────────────────
       Une surcouche `position:fixed; inset:0` se place par rapport à l'iframe
       ENTIÈRE (haute comme le document), pas par rapport à l'écran du
       visiteur : la modale s'ouvre loin de ce qu'il regarde. Le script collé
       dans la page hôte envoie, à chaque défilement/redimensionnement, la
       partie de l'iframe réellement visible à l'écran :
           { type: 'hostViewport', visibleTop: <px>, visibleHeight: <px> }
       (en pixels depuis le haut de l'iframe). On y cale chaque surcouche
       connue : `position:absolute`, exactement sur cette bande. Leur
       centrage flex habituel centre alors la boîte sur l'écran du visiteur,
       sans rien changer au CSS des modales.

       Tant que la page hôte n'envoie rien (ancien script collé dans
       Syracuse), rien n'est touché : comportement d'avant.

       Ajouter une surcouche : lui mettre l'attribut `data-rp-overlay`, ou
       compléter OVERLAY_SELECTOR. */
    var OVERLAY_SELECTOR = '[data-rp-overlay], .admin-modal, ' +
        '.inv-detail-overlay, .notices-modal, #visionneuse-overlay';
    var MIN_OVERLAY_HEIGHT = 320; // px : iframe à peine visible à l'écran
    var hostView = null;          // { top, height } en px du document

    /* Haut du bloc conteneur d'une surcouche absolue, en px du document.
       Calculé à la main plutôt que via offsetParent, nul pour une surcouche
       masquée (display:none). */
    function containingBlockTop(el) {
        for (var p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
            var cs = window.getComputedStyle(p);
            if (cs.position !== 'static' || cs.transform !== 'none') {
                return p.getBoundingClientRect().top + window.scrollY +
                    (parseFloat(cs.borderTopWidth) || 0);
            }
        }
        return 0; // bloc conteneur initial = haut du document
    }

    function setStyle(el, prop, value) {
        // Comparaison préalable : le MutationObserver écoute `style`, une
        // réécriture à l'identique relancerait une mesure pour rien.
        if (el.style[prop] !== value) el.style[prop] = value;
    }

    function placeOverlays() {
        if (!hostView) return;
        var list = document.querySelectorAll(OVERLAY_SELECTOR);
        var height = Math.max(hostView.height, MIN_OVERLAY_HEIGHT);
        for (var i = 0; i < list.length; i++) {
            var el = list[i];
            var top = hostView.top + window.scrollY - containingBlockTop(el);
            setStyle(el, 'position', 'absolute');
            setStyle(el, 'top', Math.round(top) + 'px');
            setStyle(el, 'bottom', 'auto');
            setStyle(el, 'left', '0px');
            setStyle(el, 'right', '0px');
            setStyle(el, 'height', Math.round(height) + 'px');
        }
    }

    window.addEventListener('message', function (event) {
        if (event.source !== window.parent) return;
        var d = event.data;
        if (!d || d.type !== 'hostViewport') return;
        var top = Number(d.visibleTop), h = Number(d.visibleHeight);
        if (!isFinite(top) || !isFinite(h)) return;
        hostView = { top: Math.max(0, top), height: Math.max(0, h) };
        placeOverlays();
    });

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
        /* La page hôte n'envoie la zone visible qu'au défilement : on la lui
           demande tout de suite, pour qu'une modale ouverte sans avoir
           défilé soit déjà bien placée. */
        window.parent.postMessage({ type: 'hostViewportRequest' }, '*');

        new window.MutationObserver(function () {
            // Surcouches créées à la volée (ex. fiche de l'inventaire) : les
            // placer dès leur insertion, sans attendre un défilement.
            placeOverlays();
            schedule();
        }).observe(document.body, {
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
