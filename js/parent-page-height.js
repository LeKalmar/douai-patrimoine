(function() {
    function sendHeight() {
        setTimeout(function() {
            // Parcourir TOUS les éléments pour trouver le plus grand scrollHeight
            var maxHeight = document.documentElement.scrollHeight;
            var allElements = document.querySelectorAll('*');
            for (var i = 0; i < allElements.length; i++) {
                var el = allElements[i];
                if (el.scrollHeight > maxHeight) {
                    maxHeight = el.scrollHeight;
                }
            }
            window.parent.postMessage(
                { type: 'iframeHeight', height: maxHeight },
                '*'
            );
        }, 150);
    }

    // Attendre que le DOM soit complètement prêt
    function init() {
        sendHeight();

        window.addEventListener('resize', sendHeight);

        // Observer les mutations du DOM (ouverture accordéon, chargement dynamique)
        if (document.body) {
            var mutationObserver = new MutationObserver(sendHeight);
            mutationObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'open']
            });

            var resizeObserver = new ResizeObserver(sendHeight);
            resizeObserver.observe(document.body);
        }
    }

    // S'assurer que le DOM est prêt avant d'initialiser
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();