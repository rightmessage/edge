// The Worker inserts the
// inert, validated release pin before this bootstrap; fallback uses the same
// ordinary public loader so request metadata and preview behavior are preserved.
export const rightMessageTrackingScript = `
  (function(p, n, o, b) {
    var root = n.documentElement;
    var cloak = n.createElement('style');
    var revealed = false;
    var observer;

    cloak.id = 'rmcloak';
    cloak.textContent = '.rmcloak:not([data-rm-edge-target][data-rm-personalized="true"]):not(:has([data-rm-edge-target][data-rm-personalized="true"])){visibility:hidden!important}';
    n.head.appendChild(cloak);

    function reveal() {
      if (revealed) return;
      revealed = true;
      observer.disconnect();
      cloak.remove();
      root.classList.remove('rm-loading');
    }

    observer = new MutationObserver(function() {
      if (!n.getElementById('rmcloak')) reveal();
    });
    observer.observe(n.head, { childList: true });

    window.RM = window.RM || [];
    o = n.createElement('script');
    o.type = 'text/javascript';
    o.async = true;
    var pin = n.querySelector('meta[name="rm-edge-loader"]');
    o.src = pin ? pin.content : 'https://t.rightmessage.com/' + p + '.js';
    o.onerror = reveal;
    b = n.getElementsByTagName('script')[0];
    b.parentNode.insertBefore(o, b);
  })('demo-team', document);
`;
