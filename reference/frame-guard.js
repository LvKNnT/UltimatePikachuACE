/* =============================================================================
   frame-guard.js -- stop other sites from iframing (or deep-linking) a game.
   Drop-in, no dependencies, no build step. One file covers both places you
   host games:

       A. On your own site   https://soccerskills2worldcup.com/games/<slug>/
       B. On the CDN         https://cdn.vietdp.com/file/vietdp-games/games/<batch>/<slug>/

   The two need opposite behaviour for a DIRECT visit, and the guard works that
   out by itself -- see DIRECT VISITS below. Nothing to configure per game.

   INSTALL: make this the FIRST thing inside <head> of every game page. The
   same line for every game -- nothing per-game to fill in:

       <head>
           <meta charset="utf-8">
           <script src="https://cdn.vietdp.com/file/vietdp-games/frame-guard.js"></script>
           ... everything else ...

   The absolute URL matters on the CDN, where games sit at varying depths. For
   games on your own site, "/frame-guard.js" is enough.

   ONE list, ALL games: which of your sites may embed them lives in
   ALLOWED_HOSTS below, in this one file. Add a domain, re-upload, and every
   game is covered at once -- that is why this is a shared file and not a
   snippet pasted into each game.

   Where a blocked visitor lands is worked out from the game's folder name via
   HOME_TEMPLATE, so a new game needs no configuration either. A single game
   can still override it with data-home="..." on the <script> tag.

   WHY FIRST: when the page turns out to be stolen, the guard calls
   window.stop(), which aborts the HTML parser and every pending request.
   Loading ends right there -- the game payload (tens of MB for a Unity build)
   is never fetched. That is the point: an embedder who takes your game also
   takes your bandwidth, and on B2 that is metered. A guard that runs after the
   build has downloaded saves neither.

   HOW IT DECIDES WHO IS FRAMING, best signal first:

     1. window.top === window.self        -> not framed; see DIRECT VISITS.
     2. window.top.location.hostname      -> readable ONLY when the parent is
                                             same-origin. Exact, unspoofable.
                                             Case A hits this.
     3. location.ancestorOrigins          -> the full chain of framing origins.
                                             Chrome/Edge/Safari. Cannot be
                                             suppressed by a referrer policy,
                                             which is what makes it better than
                                             the referrer. Absent in Firefox.
                                             Case B leans on this.
     4. document.referrer                 -> the embedding page's URL. Firefox
                                             fallback. An embedder CAN blank it
                                             with referrerpolicy="no-referrer".
     5. nothing usable                    -> BLOCK_WHEN_UNKNOWN decides.

   DIRECT VISITS (someone opens the game URL outside any frame):

     * Page served from a host in ALLOWED_HOSTS -> that IS your site. Allowed,
       obviously: it is how people play.
     * Page served from anywhere else -> the CDN, which exists to be embedded
       by your pages, not to be a destination. The visitor is sent to the game's
       home page. Same-window navigation, so no browser restriction applies and
       this one always works.

   Nothing to switch when you deploy: the same file behaves correctly in both
   places because the rule is derived from where the page is served, not from a
   flag someone has to remember to flip.

   WHAT THIS IS NOT: a browser-side guard. It stops ordinary iframe embedding,
   which is what aggregator sites actually do, and converts their traffic into
   visits to you. It cannot stop someone who downloads the build and re-hosts
   it -- nothing served to a browser can. See README.md.
   ============================================================================= */
(function () {
    'use strict';

    /* ---------------------------------------------------------------------
       CONFIGURATION -- the only part you edit.
       --------------------------------------------------------------------- */

    // ==== THE LIST ====
    //
    // Every site of yours that may frame a game, or serve one directly.
    // Add a line, upload the file, done -- it applies to every game at once,
    // which is the whole reason the guard is one shared file rather than a
    // snippet pasted into each game.
    //
    // Subdomains are covered automatically: "gamevui.io" also allows
    // www.gamevui.io, m.gamevui.io, and so on. No need to list them.
    //
    // A site missing from this list gets blocked from its own game, so keep it
    // complete. If you are unsure it is, deploy once with DRY_RUN = true
    // (below) and read the console.
    //
    // Do NOT add a host merely because games are served from it. cdn.vietdp.com
    // is the page being framed, never the framer, and its absence here is
    // deliberate: it is what makes a direct CDN link bounce to your site
    // instead of playing. Adding "vietdp.com" would silently undo that, since
    // subdomains are included.
    var ALLOWED_HOSTS = [
        'azgames2.com',
		'gamepikachu.vn',
		'pikachucodien.net',
		'pikachuonline.com',
		'y81nguoi.com',
		'y82nguoi.com',
		'y82nguoi.net',
		'trochoiy8.com',
		'gamevui.io',
		'gamevui2.com',
		'line98.vn',
		'blockblast.vn',
		'trochoibansung.com',
		'bansungonline.com',
		'game24h.io',
		'1000trochoi.com',
		'crazygame.vn',
        // ... thêm domain mới vào đây ...
        'localhost',
        '127.0.0.1'
    ];

    // Where a blocked visitor is sent. Resolved in this order:
    //
    //   1. data-home="..." on the <script> tag   -- per game, wins if present
    //   2. HOME_TEMPLATE with {slug} filled in   -- per game, no editing
    //   3. DEFAULT_HOME                          -- last resort
    //
    // With many games, 2 is the one you want: {slug} becomes the game's folder
    // name, so .../games/t12026/soccer-skills-2-world-cup/index.html sends
    // people to your page for that game, and a new game needs no config at all.
    // Set it to '' if your game URLs do not follow one pattern, and people land
    // on DEFAULT_HOME instead.
    var HOME_TEMPLATE = '';                          // e.g. 'https://gamevui.io/game/{slug}'
    var DEFAULT_HOME = 'https://gamevui.io/';        // <-- đổi thành site chính của bạn

    // true  -- change nothing, just report the verdict to the browser console
    //          (look for "[frame-guard]"). Use this for the first deploy across
    //          several sites: load each of your own pages, confirm every one
    //          logs "allowed", then set it back to false.
    // false -- enforce.
    var DRY_RUN = false;

    // What to do when the browser gives no usable signal at all -- Firefox
    // plus an embedder who deliberately strips the referrer.
    //
    //   true  -- block. Correct choice: stripping the referrer is something
    //            embedders do on purpose, and your own pages are covered by
    //            checks 2 and 3, so they do not land here. One caveat for the
    //            CDN case: your own site must not set referrerpolicy="no-
    //            referrer" on the <iframe>, or Firefox visitors get blocked.
    //            The browser default sends the origin cross-origin, which is
    //            all the guard needs.
    //   false -- allow. Use only if you cannot get your own pages past the
    //            guard and need to stop the bleeding.
    var BLOCK_WHEN_UNKNOWN = true;

    // Try to navigate the TOP window to the home page the instant a bad frame
    // is found, without waiting for a click. Browsers refuse this from a
    // cross-origin frame with no user activation yet, so it usually does
    // nothing -- harmless to leave on, and it does fire where permitted. The
    // notice page is what actually converts.
    var AUTO_TOP_REDIRECT = true;

    // Headline on the notice page. Blank = derive it from the URL:
    // .../games/t12026/soccer-skills-2-world-cup/index.html -> "Soccer Skills
    // 2 World Cup". Deriving it is why one shared copy covers every game.
    // (The page's own <title> is not an option: the guard runs before the
    // parser reaches it -- which is exactly what lets it stop the download in
    // time.)
    var GAME_NAME = '';

    /* ------------------------------------------------------------------- */

    // The game's folder name: the last path segment that is not a file name.
    // .../games/t12026/soccer-skills-2-world-cup/index.html -> the slug.
    function slugFromPath() {
        var parts = location.pathname.split('/');
        for (var i = parts.length - 1; i >= 0; i--) {
            if (parts[i] && !/\.[a-z0-9]+$/i.test(parts[i])) {
                try { return decodeURIComponent(parts[i]); } catch (e) { return parts[i]; }
            }
        }
        return '';
    }

    var SLUG = slugFromPath();

    var me = document.currentScript;
    var HOME =
        (me && me.getAttribute('data-home')) ||
        (HOME_TEMPLATE && SLUG && HOME_TEMPLATE.replace('{slug}', encodeURIComponent(SLUG))) ||
        DEFAULT_HOME;

    function hostOf(url) {
        // "null" is what ancestorOrigins reports for a sandboxed frame.
        if (!url || url === 'null') return '';
        try {
            return new URL(url, location.href).hostname.toLowerCase();
        } catch (e) { /* fall through */ }
        var m = /^[a-z][a-z0-9+.\-]*:\/\/([^/?#]+)/i.exec(url);
        if (!m) return '';
        return m[1]
            .replace(/^.*@/, '')        // credentials
            .replace(/:\d+$/, '')       // port
            .replace(/^\[|\]$/g, '')    // IPv6 brackets
            .toLowerCase();
    }

    function hostAllowed(host) {
        if (!host) return false;
        for (var i = 0; i < ALLOWED_HOSTS.length; i++) {
            var a = ALLOWED_HOSTS[i].toLowerCase();
            if (host === a || host.slice(-(a.length + 1)) === '.' + a) return true;
        }
        return false;
    }

    // Returns null when the page may proceed, otherwise
    // { why: 'framed'|'direct', host: <the offending host> }.
    function verdict() {
        if (window.top === window.self) {
            // Not framed. Your own site serves games to be played; the CDN
            // does not.
            if (hostAllowed(location.hostname)) return null;
            return { why: 'direct', host: location.hostname };
        }

        // Same-origin parent: readable, exact, and what your own site hits
        // when it frames a game hosted alongside it.
        try {
            var h = window.top.location.hostname;
            if (h) return hostAllowed(h) ? null : { why: 'framed', host: h };
        } catch (e) { /* cross-origin, as expected for the CDN */ }

        var chain = null;
        try { chain = window.location.ancestorOrigins; } catch (e) { }
        if (chain && chain.length) {
            // Every ancestor must be allowed -- a page of yours that is itself
            // framed by a stranger is still a stolen embed.
            for (var i = 0; i < chain.length; i++) {
                var ah = hostOf(chain[i]);
                if (!hostAllowed(ah)) return { why: 'framed', host: ah || '(unknown)' };
            }
            return null;
        }

        var ref = document.referrer;
        if (ref) {
            var rh = hostOf(ref);
            return hostAllowed(rh) ? null : { why: 'framed', host: rh || '(unknown)' };
        }

        return BLOCK_WHEN_UNKNOWN ? { why: 'framed', host: '(unknown)' } : null;
    }

    var bad = verdict();

    if (DRY_RUN) {
        try {
            console.log('[frame-guard] ' + (bad
                ? 'WOULD BLOCK (' + bad.why + ') host=' + bad.host + ' -> ' + HOME
                : 'allowed') + ' | page=' + location.href);
        } catch (e) { }
        return;
    }
    if (!bad) return;

    /* --- from here on the page is not allowed to run ------------------- */

    // Kill the parser and every in-flight request before the payload starts.
    try { window.stop(); } catch (e) { }

    if (bad.why === 'direct') {
        // Our own window: this navigation is never blocked, so it is the end
        // of the story. The notice below is only ever seen for the instant
        // before the new page paints.
        location.replace(HOME);
    } else if (AUTO_TOP_REDIRECT) {
        try { window.top.location.replace(HOME); } catch (e) { }
    }

    var title = GAME_NAME || SLUG
        .replace(/[-_+]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); })
        || 'This game';
    var homeHost = hostOf(HOME);

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    var body = bad.why === 'direct'
        ? '<p>Taking you to the game on <b>' + esc(homeHost) + '</b>…</p>'
        : '<p>This game is published on <b>' + esc(homeHost) + '</b> and cannot be ' +
          'played from <span class="host">' + esc(bad.host) + '</span>.</p>' +
          '<p>The site you are on embedded it without permission. Play the real ' +
          'version — free, no download:</p>';

    document.documentElement.innerHTML =
        '<head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<meta name="robots" content="noindex,nofollow">' +
        '<title>' + esc(title) + '</title>' +
        '<style>' +
        'html,body{margin:0;height:100%;background:#15151b;color:#e8e8ef;' +
        'font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;' +
        '-webkit-text-size-adjust:100%}' +
        '#fg{box-sizing:border-box;min-height:100%;display:flex;' +
        'flex-direction:column;align-items:center;justify-content:center;' +
        'text-align:center;padding:24px;gap:14px;cursor:pointer}' +
        '#fg h1{margin:0;font-size:clamp(18px,4.5vw,26px);font-weight:650}' +
        '#fg p{margin:0;max-width:34em;color:#a9a9ba;font-size:clamp(13px,3vw,15px)}' +
        '#fg .host{color:#e6b566;font-weight:600;word-break:break-all}' +
        '#fg a.btn{display:inline-block;margin-top:6px;padding:13px 26px;' +
        'border-radius:8px;background:#5b9dd9;color:#0d1117;font-weight:700;' +
        'text-decoration:none;font-size:clamp(14px,3.4vw,16px)}' +
        '#fg a.btn:hover{background:#78b1e2}' +
        '#fg .url{color:#6f6f80;font-size:12px;user-select:all}' +
        '</style></head>' +
        '<body><div id="fg">' +
        '<h1>' + esc(title) + '</h1>' +
        body +
        '<a class="btn" href="' + esc(HOME) + '" target="_top" rel="noopener">' +
        'Play on ' + esc(homeHost) + '</a>' +
        '<p class="url">' + esc(HOME) + '</p>' +
        '</div></body>';

    // target="_top" is the path browsers actually allow out of a cross-origin
    // frame, because the click supplies the user activation they require. If
    // the embedder sandboxed the frame hard enough to refuse even that, fall
    // back to a new tab; if that is blocked too, the URL above stays on screen
    // and is select-all-able.
    var root = document.getElementById('fg');
    root.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('a')) return;  // let the link work
        try {
            window.top.location.href = HOME;
            return;
        } catch (e) { }
        window.open(HOME, '_blank', 'noopener');
    });
})();
