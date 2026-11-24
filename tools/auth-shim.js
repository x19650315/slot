// ---- 不良のたまり場：Googleログイン（Supabase） ----
// The game already knows how to keep points in an account through window.claude (db + user).
// On GitHub Pages there is no window.claude, so this file supplies the same interface backed by Supabase.
// Not signed in -> use("db") answers null and the game keeps points on this device, as before.
(function () {
  "use strict";
  var SB_URL = "https://euraiowxipjwpcvjhacm.supabase.co";
  var SB_KEY = "sb_publishable_Bpv-fhPQ6cj0hP-Cl1u2Nw_xmwvweS-";
  var OWNER = "x19650315@gmail.com";
  var HOME = "https://x19650315.github.io/slot/";
  var POLL_DOC = 8000, POLL_COL = 6000;

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

  // remove ?code=… left by the Google sign-in, keep #game
  ready.then(function () {
    if (/[?&](code|error)=/.test(location.search)) {
      try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
    }
  });

  function wrapErr(e) {
    var x = new Error((e && e.message) || "error");
    var c = e && e.code;
    if (c === "42501" || c === "PGRST301") x.code = "not_granted";       // blocked by the database rules
    else if (e && e.status === 429) x.code = "rate_limited";
    return x;
  }
  function q(p) { return p.then(function (r) { if (r.error) throw wrapErr(r.error); return r.data; }); }
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
  function poll(read, every, cb, errcb) {
    var stop = false, last = null, timer = null;
    function tick() {
      if (stop) return;
      if (document.hidden) { timer = setTimeout(tick, every); return; }
      read().then(function (snap) {
        if (stop) return;
        var sig = JSON.stringify(snap.docs ? snap.docs.map(function (d) { return [d.id, d.data()]; }) : [snap.exists, snap.data()]);
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

  var DB = {
    doc: function (path) {
      return {
        get: function () { return readDoc(path); },
        set: function (body) {
          return q(sb.from("docs").upsert({ path: path, data: body, updated_at: new Date().toISOString() }, { onConflict: "path" }))
            .then(function () {});
        },
        onSnapshot: function (cb, errcb) { return poll(function () { return readDoc(path); }, POLL_DOC, cb, errcb); }
      };
    },
    collection: function (name) {
      return { onSnapshot: function (cb, errcb) { return poll(function () { return readCol(name); }, POLL_COL, cb, errcb); } };
    }
  };

  function nameOf(u) {
    var m = (u && u.user_metadata) || {};
    return m.full_name || m.name || (u && u.email) || "";
  }
  function userApi(session) {
    var u = session.user;
    return {
      id: function () { return Promise.resolve(u.id); },
      isOwner: function () { return Promise.resolve(String(u.email || "").toLowerCase() === OWNER); },
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

  // ---- sign-in / sign-out bar under the machine's message line ----
  function esc(t) { return String(t).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function bar() {
    var anchor = document.getElementById("pSync");
    if (!anchor || document.getElementById("pAuth")) return;
    var st = document.createElement("style");
    st.textContent =
      ".pauth{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;margin:6px 0 2px;font-size:13px}" +
      ".pauth .who{opacity:.85}" +
      ".pauth button{font:inherit;cursor:pointer;border-radius:999px;padding:6px 16px;border:1px solid currentColor;background:transparent;color:inherit}" +
      ".pauth button.g{background:#fff;color:#1f1f1f;border-color:#dadce0;font-weight:700;display:inline-flex;align-items:center;gap:8px}" +
      ".pauth button.g svg{width:18px;height:18px}" +
      ".pauth .note{width:100%;text-align:center;opacity:.7;font-size:12px}";
    document.head.appendChild(st);
    var el = document.createElement("div");
    el.className = "pauth"; el.id = "pAuth";
    anchor.parentNode.insertBefore(el, anchor.nextSibling);
    if (!sb) { el.innerHTML = '<span class="note">ログイン機能を読み込めませんでした（ポイントはこの端末に保存します）</span>'; return; }
    ready.then(function (s) {
      if (s) {
        el.innerHTML = '<span class="who">' + esc(nameOf(s.user)) + ' さんでログイン中</span><button type="button" id="pLogout">ログアウト</button>';
        document.getElementById("pLogout").addEventListener("click", function () {
          this.disabled = true;
          sb.auth.signOut().then(function () { location.reload(); }, function () { location.reload(); });
        });
      } else {
        el.innerHTML =
          '<button type="button" class="g" id="pLogin"><svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.2 5.6c4.2-3.9 7.1-9.6 7.1-17z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.7 2.3-8.7 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z"/></svg>Googleでログイン</button>' +
          '<span class="note">ログインしなくても遊べます</span>';
        document.getElementById("pLogin").addEventListener("click", function () {
          this.disabled = true;
          sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: HOME } })
            .then(function (r) { if (r && r.error) throw r.error; }, function (e) { throw e; })
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
