// ==UserScript==
// @name         Character Library - JanitorAI Bridge
// @namespace    https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary
// @version      1.4.0
// @description  Lets Character Library reach Cloudflare-gated pages from your own browser: DataCat's JanitorAI Hampter sorts and JannyAI card definitions. Not used by the JanitorAI provider, which needs a real browser.
// @author       Sillyanonymous
// @match        *://*/*
// @connect      janitorai.com
// @connect      jannyai.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_openInTab
// @grant        GM_cookie
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

/*
 * WHY THIS EXISTS
 * A page fetch from Character Library to janitorai.com can read the response (hampter serves
 * CORS *) but cannot send your janitorai cf_clearance cookie (credentialed requests are rejected
 * against a * ACAO), so it only gets through when Cloudflare isn't actively challenging.
 * jannyai.com character pages are worse: they serve no CORS headers at all, and Cloudflare
 * challenges every server-side transport, so card definitions are unreachable without a real
 * browser context. GM_xmlhttpRequest is CORS-exempt: it carries your cf_clearance cookie for the
 * target site, so the request passes Cloudflare reliably. That cookie is the ONLY thing this
 * script uniquely adds. It also forwards the Authorization header CL provides, but that is just
 * the request riding along intact: the JanitorAI login (which unlocks page 2+ of the hampter
 * sorts) is a CORS-allowed header the direct fetch sends too, so login works with or without
 * this script.
 *
 * CLEARANCE REFRESH (v1.2.0)
 * cf_clearance is short-lived and does NOT slide: Cloudflare sets a fixed expiry when the
 * challenge is passed, so no amount of traffic extends it. Once it lapses, both sites answer
 * every request with a managed challenge (cf-mitigated: challenge) until a REAL browsing context
 * executes the challenge JS again. GM_xmlhttpRequest cannot do that (no JS execution), and an
 * iframe cannot either (the challenge response sets X-Frame-Options: SAMEORIGIN). The only
 * mechanism left is a genuine page load, so on request this script opens the site in a
 * BACKGROUND tab and then POLLS the site until it stops answering with a challenge, at which
 * point the tab is closed and the caller told it is safe to retry. Nothing is ever read out of
 * that tab; the browser simply gains a fresh cookie the next GM_xmlhttpRequest can carry.
 * v1.2.1 replaced a fixed wait with that poll, because a fixed wait made the very request that
 * triggered the refresh retry too early and fail while every later request succeeded.
 * v1.3.0 polls faster and closes sooner, and CL now warms clearance when you open the JannyAI
 * browse view, so the refresh usually happens while you are still scanning the grid rather than
 * when you click a card. A tab is still required: the challenge only clears in a real browsing
 * context, and neither GM_xmlhttpRequest (no JS) nor an iframe (X-Frame-Options) qualifies.
 *
 * SECURITY
 * This script is a privileged context (GM_xmlhttpRequest can reach the network with your cookies),
 * so it is deliberately locked down:
 *   - It ONLY ever GETs https://janitorai.com/hampter/... or https://jannyai.com/characters/...
 *     Any other URL or method is refused, so even a compromised CL page cannot use it to read
 *     your cookies from another site.
 *   - The clearance refresh can ONLY open the two site roots above, never a caller-supplied URL,
 *     so the added GM_openInTab grant cannot be steered anywhere else.
 *   - It only answers same-origin messages (event.origin check) tagged by CL.
 *   - @connect janitorai.com / jannyai.com make the userscript manager enforce the host
 *     boundary too.
 * It never sends anything anywhere except the two requests CL asks for, and returns only those
 * response bodies back to the CL page in the same tab.
 */

(function () {
  'use strict';

  const PAGE_SRC = 'character-library';
  const SCRIPT_SRC = 'cl-janitor-bridge';
  const BLANK_PAGE = 'about:blank';

  /** Which userscript manager is running this? */
  const SCRIPT_HANDLER =
    (typeof GM_info !== 'undefined' && GM_info.scriptHandler) || '';
  const IS_TAMPERMONKEY = /Tampermonkey/i.test(SCRIPT_HANDLER);
  const IS_VIOLENTMONKEY = /Violentmonkey/i.test(SCRIPT_HANDLER);

  /**
   * @type {URL}
   */
  let winUrl;
  try {
    if (typeof window == 'object') {
      winUrl = new URL(window.location.href);
    }
  } catch {
    winUrl = new URL(BLANK_PAGE);
  }

  const isCLPage =
    /\/SillyTavern-CharacterLibrary\/app\/library\.html/i.test(
      winUrl.pathname,
    ) || !!document.querySelector('meta[name="character-library"]');
  if (!isCLPage) return;

  // #region Console
  const conAlerts = new Set();
  class con extends null {
    static #title = '[%cCL-JanitorBridge%c]';
    static #color = 'color: rgb(74, 158, 255);';
    static dbg(...msg) {
      const dt = new Date();
      console.debug(
        `${con.#title} %cDBG`,
        con.#color,
        '',
        'color: rgb(255, 212, 0);',
        `[${dt.getHours()}:${('0' + dt.getMinutes()).slice(-2)}:${('0' + dt.getSeconds()).slice(-2)}]`,
        ...msg,
      );
    }
    static alert(message) {
      if (typeof alert !== 'undefined' && !conAlerts.has(message)) {
        conAlerts.add(message);
        alert(message);
      }
    }
  }
  // #endregion
  con.dbg(
    `active on Character Library page (manager: ${SCRIPT_HANDLER || 'unknown'})`,
  );

  const ALLOWED = new Map([
    ['janitorai.com', 'https://janitorai.com/hampter/'],
    ['jannyai.com', 'https://jannyai.com/characters/'],
  ]);

  function allowedRule(url) {
    if (typeof url === 'string' || url instanceof URL) {
      /**
       * @type {?URL}
       */
      let u;
      try {
        u = new URL(url);
      } catch {
        return null;
      }
      const prefix = ALLOWED.get(u.hostname);
      if (prefix && (u.origin + u.pathname).startsWith(prefix)) {
        return { prefix, host: u.hostname };
      }
    }
    return null;
  }

  const gmRequest =
    typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && GM.xmlHttpRequest
        ? GM.xmlHttpRequest.bind(GM)
        : null;

  const CLEARANCE_URLS = new Map([
    ['janitorai.com', 'https://janitorai.com/'],
    ['jannyai.com', 'https://jannyai.com/characters/'],
  ]);

  const CLEARANCE_POLL_MS = 600;
  const CLEARANCE_FIRST_POLL_MS = 1200;
  const CLEARANCE_MAX_MS = 30000;
  const CLEARANCE_GRACE_MS = 400;
  let clearanceBusy = false;

  function looksChallenged(status, body) {
    if (status === 403 || status === 503) return true;
    return /Just a moment|__cf_chl|cf-error-details|Attention Required! \| Cloudflare/i.test(
      (body || '').slice(0, 2000),
    );
  }

  /**
   * Tries to read cf_clearance from the webbrowser's cookies.
   * Returns the cookie value, or null if unavailable.
   *
   * Tampermonkey: httpOnly cookies are supported at the BETA versions of Tampermonkey only.
   * Violentmonkey: httpOnly cookies require the "Allow access to HTTP-only cookies" option enabled BOTH globally and for this script under "Script settings".
   *
   * @param {string} url
   * @returns {Promise<?string>}
   */
  function readCfClearance(url) {
    return new Promise((resolve) => {
      if (
        typeof GM_cookie === 'undefined' ||
        typeof GM_cookie.list !== 'function'
      ) {
        resolve(null);
        return;
      }
      /**
       * @param {object} details
       * @param {?() => void} next
       */
      const attempt = (details, next) => {
        try {
          GM_cookie.list(details, (cookies, error) => {
            if (error || !cookies || cookies.length === 0) {
              if (next) next();
              else resolve(null);
            } else {
              resolve(cookies[0].value);
            }
          });
        } catch {
          if (next) next();
          else resolve(null);
        }
      };
      // 1) Try with partitionKey (Tampermonkey v5.2+)
      attempt({ url, name: 'cf_clearance', partitionKey: {} }, () => {
        // 2) Fallback without partitionKey (Violentmonkey, older Tampermonkey)
        attempt({ url, name: 'cf_clearance' }, null);
      });
    });
  }

  /**
   * Build GM_xmlhttpRequest options with correct cookie handling for the
   * target site's partition.
   *
   * Tampermonkey v5.2+: cookiePartition uses the target site's jar partition.
   * Violentmonkey: read the cookie and send it explicitly via the Cookie header.
   *
   * @param {string} url
   * @param {Record<string,string>} headers
   * @param {(r: any) => void} onload
   * @param {() => void} onerror
   * @param {() => void} ontimeout
   * @returns {Promise<object>}
   */
  async function makeOpts(url, headers, onload, onerror, ontimeout) {
    const origin = new URL(url).origin;
    const opts = {
      method: 'GET',
      url,
      headers: { ...headers },
      timeout: 20000,
      responseType: 'text',
      anonymous: false,
      onload,
      onerror,
      ontimeout,
    };

    if (IS_TAMPERMONKEY) {
      // Tampermonkey v5.2+: use the target site's cookie partition.
      // This sends the partitioned cf_clearance cookie automatically.
      opts.cookiePartition = { topLevelSite: origin };
    } else if (IS_VIOLENTMONKEY) {
      // Violentmonkey: partitioned cookie is not sent automatically.
      // Read it from the jar and send it explicitly.
      const cf = await readCfClearance(url);
      if (cf) {
        opts.headers = { ...headers, Cookie: `cf_clearance=${cf}` };
      } else {
        con.alert(
          'Violentmonkey: cf_clearance not readable. Enable "Allow access to HTTP-only cookies" in Violentmonkey settings + this UserScript settings.',
        );
      }
    } else {
      // Unknown manager: try cookiePartition anyway.
      opts.cookiePartition = { topLevelSite: origin };
    }

    return opts;
  }

  /**
   * @param {string} id
   * @param {string} host
   * @param {?(ok: boolean, note: string) => void} [done]
   */
  function refreshClearance(id, host, done) {
    const target = CLEARANCE_URLS.get(host);
    if (!target) {
      const msg = 'Blocked: host not in the clearance allowlist';
      if (done) done(false, msg);
      else reply(id, false, 0, msg);
      return;
    }
    if (typeof GM_openInTab !== 'function' || !gmRequest) {
      const msg =
        'Userscript manager does not expose GM.* / GM_openInTab / GM_xmlhttpRequest';
      if (done) done(false, msg);
      else reply(id, false, 0, msg);
      return;
    }
    if (clearanceBusy) {
      const msg = 'A clearance refresh is already running';
      if (done) done(false, msg);
      else reply(id, false, 0, msg);
      return;
    }
    clearanceBusy = true;

    let tab = null;
    try {
      tab = GM_openInTab(target, {
        active: false,
        insert: true,
        setParent: true,
      });
    } catch (e) {
      clearanceBusy = false;
      const msg = `Could not open a refresh tab: ${e.message}`;
      if (done) done(false, msg);
      else reply(id, false, 0, msg);
      return;
    }

    const started = Date.now();
    const finish = (ok, note) => {
      setTimeout(
        () => {
          try {
            tab?.close?.();
          } catch {
            /* manager may have closed it already */
          }
          clearanceBusy = false;
          if (done) done(ok, note);
          else reply(id, ok, ok ? 200 : 0, note);
        },
        ok ? CLEARANCE_GRACE_MS : 0,
      );
    };

    const poll = async () => {
      if (Date.now() - started > CLEARANCE_MAX_MS) {
        finish(false, 'Cloudflare did not clear within the timeout');
        return;
      }
      const opts = await makeOpts(
        target,
        { Accept: 'text/html,application/xhtml+xml' },
        (r) => {
          if (!looksChallenged(r.status, r.responseText)) {
            finish(true, 'clearance confirmed');
          } else {
            setTimeout(poll, CLEARANCE_POLL_MS);
          }
        },
        () => setTimeout(poll, CLEARANCE_POLL_MS),
        () => setTimeout(poll, CLEARANCE_POLL_MS),
      );
      gmRequest(opts);
    };
    setTimeout(poll, CLEARANCE_FIRST_POLL_MS);
  }

  function reply(id, ok, status, body) {
    if (typeof window.postMessage === 'function') {
      window.postMessage(
        { source: SCRIPT_SRC, type: 'result', id, ok, status, body },
        winUrl.origin,
      );
    }
  }

  function announce() {
    if (typeof window.postMessage === 'function') {
      window.postMessage(
        {
          source: SCRIPT_SRC,
          type: 'ready',
          version:
            (typeof GM_info !== 'undefined' && GM_info.version) || 'v0.0.0',
          caps: { clearance: typeof GM_openInTab === 'function' },
        },
        winUrl.origin,
      );
    }
  }

  const loadDOM = (onDomReady) => {
    if (typeof onDomReady === 'function') {
      if (
        document.readyState === 'interactive' ||
        document.readyState === 'complete'
      ) {
        onDomReady(document);
      } else {
        document.addEventListener(
          'DOMContentLoaded',
          (evt) => onDomReady(evt.target),
          { once: true },
        );
      }
    }
  };

  /**
   * @param {string} id
   * @param {{prefix: string;host: string;}} rule
   * @param {string} url
   * @param {string} [authToken]
   * @param {boolean} retryOnChallenge
   */
  async function doFetch(id, rule, url, authToken, retryOnChallenge) {
    const headers = {};
    if (rule.host === 'janitorai.com') {
      headers['Accept'] = 'application/json';
      if (typeof authToken === 'string' && !Object.is(authToken.trim(), ''))
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    if (rule.host === 'jannyai.com') {
      headers['Accept'] = 'text/html,application/xhtml+xml';
    }
    const opts = await makeOpts(
      url,
      headers,
      (r) => {
        if (retryOnChallenge && looksChallenged(r.status, r.responseText)) {
          con.dbg(
            'challenge detected; refreshing clearance then retrying once',
          );
          refreshClearance(`${id}:auto`, rule.host, (ok, note) => {
            if (!ok) {
              reply(
                id,
                false,
                r.status || 0,
                `Clearance refresh failed: ${note}`,
              );
              return;
            }
            doFetch(id, rule, url, authToken, false);
          });
          return;
        }
        reply(
          id,
          r.status >= 200 && r.status < 300,
          r.status,
          r.responseText || '',
        );
      },
      () => reply(id, false, 0, 'Network error'),
      () => reply(id, false, 0, 'Timed out'),
    );

    gmRequest(opts);
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== winUrl.origin) {
      return;
    }
    const msg = e.data;
    if (!msg || msg.source !== PAGE_SRC) {
      return;
    }
    const {
      type,
      id = null,
      host = BLANK_PAGE,
      url = BLANK_PAGE,
      authToken,
    } = msg;
    if (type === 'ping') {
      announce();
    } else if (id) {
      if (type === 'clearance') {
        refreshClearance(id, host);
      } else if (type === 'fetch') {
        if (!gmRequest) {
          reply(
            id,
            false,
            0,
            'Userscript manager does not expose GM_xmlhttpRequest',
          );
          return;
        }
        const rule = allowedRule(url);
        if (!rule) {
          reply(id, false, 0, 'Blocked: URL not in the bridge allowlist');
          return;
        }
        doFetch(id, rule, url, authToken, true);
      }
    }
  });

  loadDOM(announce);
})();
