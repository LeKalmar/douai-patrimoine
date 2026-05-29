(function() {
    function sendHeight() {
        setTimeout(function() {
            // getBoundingClientRect donne la hauteur réellement rendue,
            // accordéons ouverts ou fermés inclus
            var rect = document.body.getBoundingClientRect();
            var height = Math.ceil(rect.bottom - rect.top);
            window.parent.postMessage(
                { type: 'iframeHeight', height: height },
                '*'
            );
        }, 150);
    }

    function init() {
        sendHeight();
        window.addEventListener('resize', sendHeight);

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();