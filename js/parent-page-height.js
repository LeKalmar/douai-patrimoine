function sendHeight() {
    setTimeout(function() {
        var height = Math.max(
            document.body.scrollHeight,
            document.body.offsetHeight,
            document.documentElement.scrollHeight,
            document.documentElement.offsetHeight
        );
        window.parent.postMessage(
            { type: 'iframeHeight', height: height },
            '*'
        );
    }, 50);
}

window.addEventListener('load', sendHeight);
window.addEventListener('resize', sendHeight);

// Observer toutes les mutations du DOM (ouverture accordéon, chargement dynamique, etc.)
const mutationObserver = new MutationObserver(sendHeight);
mutationObserver.observe(document.body, {
    childList: true,    // ajout/suppression d'éléments
    subtree: true,      // dans tout le sous-arbre
    attributes: true,   // changement d'attributs (class, style, hidden...)
});

// Observer les changements de taille de tous les éléments
const resizeObserver = new ResizeObserver(sendHeight);
resizeObserver.observe(document.documentElement);