// ---- 不良のたまり場：Googleログイン（Supabase）と全ゲーム共通の財布 ----
// Load after tools/supabase.js. Provides:
//   window.TAMARIBA = { sb, ready, isOwner(), wallet: { attach, sync }, grant, watchWallets }
//   window.claude   = the account interface the slot already uses (db + user), backed by Supabase
// Not signed in -> nothing changes: every game keeps its points on this device, as before.
(function () {
  "use strict";
  var SB_URL = "https://euraiowxipjwpcvjhacm.supabase.co";
  var SB_KEY = "sb_publishable_Bpv-fhPQ6cj0hP-Cl1u2Nw_xmwvweS-";
  var OWNER = "x19650315@gmail.com";
  var POLL_DOC = 8000, POLL_COL = 6000, POLL_WALLET = 10000;

  var sb = null;
  try {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      sb = window.supabase.createClient(SB_URL, SB_KEY, {
        auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true, autoRefreshToken: true }
      });
    }
  } catch (e) { sb = null; }

  var ready = sb
    ? sb.auth.getSession().then(function (r) { return (r && r.data && r.data.session) || null; }, function () { return null; })
    : Promise.resolve(null);
  var session = null;
  ready.then(function (s) { session = s; });

  // remove ?code=… left by the Google sign-in, keep #game etc.
  ready.then(function () {
    if (/[?&](code|error)=/.test(location.search)) {
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    }
  });

  function here() { return location.origin + location.pathname.replace(/index\.html$/, ""); }
  function isOwner() { return !!(session && String(session.user.email || "").toLowerCase() === OWNER); }

  function wrapErr(e) {
    var x = new Error((e && e.message) || "error");
    var c = e && e.code;
    x.pg = c;
    if (c === "42501" || c === "PGRST301") x.code = "not_granted";       // blocked by the database rules
    else if (e && e.status === 429) x.code = "rate_limited";
    return x;
  }
  function q(p) { return p.then(function (r) { if (r.error) throw wrapErr(r.error); return r.data; }); }

  // ---------- documents (used by the slot's account mode) ----------
  function readDoc(path) {
    return q(sb.from("docs").select("data").eq("path", path).maybeSingle()).then(function (row) {
      return { exists: !!row, data: function () { return row ? row.data : undefined; } };
    });
  }
  function readCol(name) {
    return q(sb.from("docs").select("path,data").like("path", name + "/%")).then(function (rows) {
      return {
        docs: (rows || []).map(function (r) {
          return { id: r.path.slice(name.length + 1), data: function () { return r.data; } };
        })
      };
    });
  }
  // "live" listeners are done by polling: simple, and enough for points that change a few times a minute
  function poll(read, every, cb, errcb, sigOf) {
    var stop = false, last = null, timer = null;
    function tick() {
      if (stop) return;
      if (document.hidden) { timer = setTimeout(tick, every); return; }
      read().then(function (snap) {
        if (stop) return;
        var sig = JSON.stringify(sigOf(snap));
        if (sig !== last) { last = sig; cb(snap); }
        timer = setTimeout(tick, every);
      }, function (e) {
        if (stop) return;
        if (last === null && errcb) errcb(e);
        timer = setTimeout(tick, every * 2);
      });
    }
    tick();
    document.addEventListener("visibilitychange", function () { if (!document.hidden && !stop) { clearTimeout(timer); tick(); } });
    return function () { stop = true; clearTimeout(timer); };
  }
  function docSig(s) { return [s.exists, s.data()]; }
  function colSig(s) { return s.docs.map(function (d) { return [d.id, d.data()]; }); }

  var DB = {
    doc: function (path) {
      return {
        get: function () { return readDoc(path); },
        set: function (body) {
          return q(sb.from("docs").upsert({ path: path, data: body, updated_at: new Date().toISOString() }, { onConflict: "path" }))
            .then(function () {});
        },
        onSnapshot: function (cb, errcb) { return poll(function () { return readDoc(path); }, POLL_DOC, cb, errcb, docSig); }
      };
    },
    collection: function (name) {
      return { onSnapshot: function (cb, errcb) { return poll(function () { return readCol(name); }, POLL_COL, cb, errcb, colSig); } };
    }
  };

  function nameOf(u) {
    var m = (u && u.user_metadata) || {};
    return m.full_name || m.name || (u && u.email) || "";
  }
  function userApi(s) {
    var u = s.user;
    return {
      id: function () { return Promise.resolve(u.id); },
      isOwner: function () { return Promise.resolve(isOwner()); },
      can: function () { return Promise.resolve(true); },
      profiles: function (ids) {
        if (!ids || !ids.length) return Promise.resolve({});
        return q(sb.from("docs").select("path,data").in("path", ids.map(function (id) { return "people/" + id; })))
          .then(function (rows) {
            var out = {};
            (rows || []).forEach(function (r) { out[r.path.slice(7)] = { name: (r.data && r.data.name) || "" }; });
            return out;
          }, function () { return {}; });
      }
    };
  }

  // keep the player's display name where the owner's list can find it
  ready.then(function (s) {
    if (!s) return;
    var u = s.user;
    sb.from("docs").upsert({ path: "people/" + u.id, data: { name: nameOf(u), email: u.email || "" }, updated_at: new Date().toISOString() }, { onConflict: "path" })
      .then(function () {}, function () {});
  });

  window.claude = {
    use: function (cap) {
      if (cap === "db") return ready.then(function (s) { return s ? DB : null; });
      if (cap === "user") return ready.then(function (s) { return s ? userApi(s) : null; });
      return Promise.reject(Object.assign(new Error("not available"), { code: "capability_disabled" }));
    }
  };

  // ---------- the shared wallet ----------
  // Each game keeps its own points variable. The wallet sends only the CHANGE since the last sync, so two games
  // open at the same time add up correctly on the server. Whenever the server total differs (another game, the
  // owner's adjustment), the game's points are replaced by the server total while no game round is in progress.
  var W = { cfg: null, on: false, last: 0, queue: 0, sending: false, retry: null, waiting: false };
  function status(t, cls) {
    var el = document.getElementById("pWallet");
    if (!el) return;
    el.textContent = t || ""; el.className = "wstat" + (cls ? " " + cls : ""); el.hidden = !t;
  }
  function apply(c) {
    if (!W.cfg) return;
    if (W.cfg.busy && W.cfg.busy()) {         // a round is in progress: try again shortly
      if (!W.waiting) { W.waiting = true; setTimeout(function () { W.waiting = false; apply(c); }, 800); }
      return;
    }
    if (W.sending || Math.abs(W.queue) >= 1) return;   // our own changes are still on their way; the answer will bring the total
    W.queue = 0;                                // drop a fraction (e.g. half a chip) that the server cannot hold
    W.last = c; W.on = true;
    if (W.cfg.get() !== c) W.cfg.set(c);
    status("ポイントは全ゲーム共通の財布に保存しています", "ok");
  }
  function refresh() {
    if (!W.cfg || W.sending || Math.abs(W.queue) >= 1) return;
    q(sb.rpc("wallet_get")).then(function (c) { apply(Number(c)); }, function () {
      status("財布に接続できませんでした。少し待ってから開き直してください", "warn");
    });
  }
  function flush() {
    if (W.sending) return;
    var d = W.queue < 0 ? Math.ceil(W.queue) : Math.floor(W.queue);   // whole points only; a fraction waits
    if (!d) return;
    W.queue -= d; W.sending = true;
    q(sb.rpc("wallet_add", { delta: d, game: W.cfg.game })).then(function (c) {
      W.sending = false;
      if (Math.abs(W.queue) >= 1) { flush(); return; }
      c = Number(c);
      if (Math.abs(c + W.queue - W.last) > 1e-9) apply(c);               // another game or the owner changed the total
      else status("ポイントは全ゲーム共通の財布に保存しています", "ok");
    }, function (e) {
      W.sending = false;
      if (e && e.pg === "P0001") {               // not enough points on the server (spent in another game)
        W.queue = 0; W.on = false;
        status("ほかのゲームでポイントが動いていたため、財布の残高に合わせました", "warn");
        refresh();
        return;
      }
      W.queue += d;                              // keep it and send again
      status("財布への送信に失敗しました。自動で送り直します", "warn");
      clearTimeout(W.retry); W.retry = setTimeout(flush, 5000);
    });
  }
  var wallet = {
    // cfg: { game: "hanafuda", get: () => points, set: (v) => { points = v; save(); render(); }, busy: () => roundInProgress }
    attach: function (cfg) {
      if (!sb) return;
      ready.then(function (s) {
        if (!s) return;
        W.cfg = cfg;
        status("財布を読み込み中…");
        refresh();
        setInterval(function () { if (!document.hidden) refresh(); }, POLL_WALLET);
        document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
      });
    },
    // call after every change of the game's points (the games call it from their save())
    sync: function () {
      if (!W.on || !W.cfg) return;
      var d = W.cfg.get() - W.last;
      if (!d) return;
      W.last += d; W.queue += d;
      flush();
    },
    active: function () { return W.on; }
  };

  // owner tools (the slot's admin panel uses them)
  function grant(uid, delta, note) { return q(sb.rpc("wallet_grant", { target: uid, delta: delta, note: note || null })).then(Number); }
  function watchWallets(cb) {
    return poll(function () { return q(sb.from("wallets").select("uid,credit,updated_at")); }, POLL_COL, function (rows) {
      var out = {}; (rows || []).forEach(function (r) { out[r.uid] = { credit: Number(r.credit), at: r.updated_at }; }); cb(out);
    }, null, function (rows) { return rows; });
  }

  window.TAMARIBA = { sb: sb, ready: ready, isOwner: isOwner, wallet: wallet, grant: grant, watchWallets: watchWallets };

  // ---------- sign-in / sign-out bar ----------
  // Placed in <div id="authBar"></div> if the page has one, otherwise under the slot's message line.
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  var GLOGO = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.2 5.6c4.2-3.9 7.1-9.6 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.7 2.3-8.7 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>';
  function bar() {
    if (document.getElementById("pAuth")) return;
    var host = document.getElementById("authBar"), anchor = document.getElementById("pSync");
    if (!host && !anchor) return;
    var st = document.createElement("style");
    st.textContent =
      ".pauth{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px 12px;margin:6px 0 2px;font-size:13px}" +
      ".pauth .who{opacity:.85}" +
      ".pauth button{font:inherit;cursor:pointer;border-radius:999px;padding:6px 16px;border:1px solid currentColor;background:transparent;color:inherit}" +
      ".pauth button.g{background:#fff;color:#1f1f1f;border-color:#dadce0;font-weight:700;display:inline-flex;align-items:center;gap:8px}" +
      ".pauth button.g svg{width:18px;height:18px}" +
      ".pauth .note,.pauth .wstat{width:100%;text-align:center;opacity:.75;font-size:12px}" +
      ".pauth .wstat.warn{opacity:1;color:#e0a040}" +
      ".pauth a.hub{color:inherit;opacity:.75;font-size:12px}";
    document.head.appendChild(st);
    var el = document.createElement("div");
    el.className = "pauth"; el.id = "pAuth";
    if (host) host.appendChild(el); else anchor.parentNode.insertBefore(el, anchor.nextSibling);
    if (!sb) { el.innerHTML = '<span class="note">ログイン機能を読み込めませんでした（ポイントはこの端末に保存します）</span>'; return; }
    ready.then(function (s) {
      if (s) {
        el.innerHTML = '<span class="who">' + esc(nameOf(s.user)) + ' さんでログイン中</span><button type="button" id="pLogout">ログアウト</button><span class="wstat" id="pWallet" hidden></span>';
        document.getElementById("pLogout").addEventListener("click", function () {
          this.disabled = true;
          sb.auth.signOut().then(function () { location.reload(); }, function () { location.reload(); });
        });
        if (W.on) status("ポイントは全ゲーム共通の財布に保存しています", "ok"); else if (W.cfg) status("財布を読み込み中…");
      } else {
        el.innerHTML = '<button type="button" class="g" id="pLogin">' + GLOGO + 'Googleでログイン</button>' +
          '<span class="note">ログインすると、ポイントが全ゲーム共通の財布に保存されます（ログインしなくても遊べます）</span>';
        document.getElementById("pLogin").addEventListener("click", function () {
          this.disabled = true;
          sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: here() } })
            .then(function (r) { if (r && r.error) throw r.error; })
            .catch(function () {
              var b = document.getElementById("pLogin"); if (b) b.disabled = false;
              var n = el.querySelector(".note"); if (n) n.textContent = "ログインを始められませんでした。もう一度押してください";
            });
        });
      }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", bar); else bar();
})();
