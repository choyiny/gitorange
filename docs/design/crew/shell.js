/* GitOrange shell, after HQ: a rail (global pages and repositories) that is collapsed, peeking or pinned on a
 * desktop and a full drawer on narrow screens; a GitHub-style top band (trail, search, create, inbox, account).
 * Themes are one list (seven HQ colourways and GitHub), and appearance (system, light, dark) applies to all. */
(function () {
  "use strict";
  const { $, $$, esc, icon } = GO.h;
  const app = $("#app"),
    snav = $("#snav"),
    ph = $("#ph");
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("go-" + k);
        return v == null ? d : v;
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("go-" + k, v);
      } catch (e) {}
    },
  };
  const THEMES = [
    {
      id: "navy",
      label: "Navy",
      skin: "hq",
      chrome: "navy",
      sw: ["#16203a", "#3730a3"],
    },
    {
      id: "ink",
      label: "Ink",
      skin: "hq",
      chrome: "ink",
      sw: ["#101113", "#3730a3"],
    },
    {
      id: "slate",
      label: "Slate",
      skin: "hq",
      chrome: "slate",
      sw: ["#1e242b", "#3730a3"],
    },
    {
      id: "indigo",
      label: "Indigo",
      skin: "hq",
      chrome: "indigo",
      sw: ["#241f52", "#3730a3"],
    },
    {
      id: "forest",
      label: "Forest",
      skin: "hq",
      chrome: "forest",
      sw: ["#122a1f", "#3730a3"],
    },
    {
      id: "claret",
      label: "Claret",
      skin: "hq",
      chrome: "claret",
      sw: ["#2c1419", "#3730a3"],
    },
    {
      id: "paper",
      label: "Paper",
      skin: "hq",
      chrome: "paper",
      sw: ["#dee2ea", "#3730a3"],
    },
    {
      id: "github",
      label: "GitHub",
      skin: "dev",
      chrome: "navy",
      sw: ["#f6f8fa", "#1f883d"],
    },
  ];
  const legacy =
    store.get("skin", null) === "dev" ? "github" : store.get("chrome", "navy");
  const prefs = {
    theme: store.get("themeId", legacy),
    mode: store.get("theme", "system"),
    pin: store.get("pin", "0") === "1",
  };
  let menu = null,
    peek = false,
    peekTimer = null,
    navOpen = false,
    searchQ = "",
    searchSel = 0;
  const NARROW = matchMedia("(max-width: 900px)");
  const ME = {
    name: "Mahmoud Halat",
    login: "mahmoud",
    email: "mahmoud@xyspace.dev",
  };

  /* ---------- Identicons, after GitHub's: a mirrored 5x5 pattern and a colour from the name ---------- */
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function identicon(name, size = 20) {
    const h = hash(String(name).toLowerCase()),
      hue = h % 360;
    const fg = `hsl(${hue} 52% 52%)`;
    let cells = "";
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++) {
        if ((h >>> (y * 3 + x)) & 1) {
          cells += `<rect x="${x + 1}" y="${y + 1}" width="1" height="1"/>`;
          if (x < 2)
            cells += `<rect x="${5 - x}" y="${y + 1}" width="1" height="1"/>`;
        }
      }
    return `<svg class="identicon" width="${size}" height="${size}" viewBox="0 0 7 7" aria-hidden="true" shape-rendering="crispEdges"><rect width="7" height="7" class="idn-bg"/><g fill="${fg}">${cells}</g></svg>`;
  }
  GO.h.identicon = identicon;

  function theme() {
    return THEMES.find((t) => t.id === prefs.theme) || THEMES[0];
  }
  function applyTheme() {
    const root = document.documentElement,
      t = theme();
    root.dataset.skin = t.skin;
    if (prefs.mode === "system") root.removeAttribute("data-theme");
    else root.dataset.theme = prefs.mode;
    app.dataset.chrome = t.chrome;
  }
  /* HQ's rule: the rail is wide when pinned, when the pointer or focus is in it, and always on a narrow screen,
   * where it's a drawer. Only classes change, so the element under the pointer is never re-rendered. */
  function applyRail() {
    const wide = prefs.pin || peek || NARROW.matches;
    snav.classList.toggle("shut", !wide);
    snav.classList.toggle("pinned", prefs.pin && !NARROW.matches);
    snav.classList.toggle("peeking", peek && !prefs.pin && !NARROW.matches);
    app.classList.toggle("nav-open", navOpen && NARROW.matches);
  }

  /* ---------- The rail ---------- */
  const NAV = [
    [
      ["home", "Home", "home", "#home"],
      ["repos", "Repositories", "repo", "#repos"],
      ["approvals", "Approvals", "inbox", "#approvals", true],
      ["agents", "Agents", "crew", "#agents"],
    ],
    "repos",
    [
      ["settings", "Settings", "sliders", "#settings-tokens"],
      ["admin", "Site admin", "shield", "#admin-users"],
    ],
  ];
  function repoItem(r) {
    const ic = r.agent ? GO.h.avatar(r.agent, 24, "idle") : icon("repo");
    return `<a class="snav-item" href="#repo-${r.name.replace("/", "~")}" data-nav="repo:${r.name}" title="${esc(r.name)}"><span class="snav-ic">${ic}</span><span class="snav-nm">${esc(r.repo)}<span class="snav-own"> · ${esc(r.owner === r.repo ? "agent" : r.owner)}</span></span></a>`;
  }
  function drawRail() {
    snav.innerHTML = `<div class="snav-panel">
      <a class="snav-brand" href="#home" aria-label="GitOrange home">
        <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="35" r="26" fill="#f6821f"/><path d="M32 9c2-4 8-6 12-4-2 4-6 6-12 4z" fill="#3fb950"/><path d="M22 27v16m0-16a4 4 0 1 0 0-.02M22 43a4 4 0 1 0 0 .02M42 31a4 4 0 1 0 0-.02M42 31c0 6-8 6-16 10" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round"/></svg>
        <span class="brand-wordmark">GitOrange</span>
      </a>
      <div class="snav-ws">
        <button class="snav-org-btn" type="button" data-menu="org" aria-expanded="${menu === "org"}" title="XY SPACE GitOrange"><span class="org-dot" aria-hidden="true"></span><span class="snav-org-nm">XY Space</span>${icon("down", "icon chev")}</button>
        ${
          menu === "org"
            ? `<div class="ws-menu" role="menu"><div class="dd-label">Instance</div>
          <div class="ws-item on"><span class="wd" style="background:#f6821f"></span><span><b>XY SPACE GitOrange</b><span class="sub">git.xyspace.dev · single-tenant</span></span></div>
          <div class="dd-sep"></div><a class="ws-item" href="#admin-settings"><span><b>Instance settings</b><span class="sub">Site admin</span></span></a></div>`
            : ""
        }
      </div>
      <div class="snav-list">
        ${NAV.map(
          (sec, i) =>
            `<div class="snav-sec">${i ? '<div class="snav-rule"></div>' : ""}${
              sec === "repos"
                ? GO.REPOS.map(repoItem).join("")
                : sec
                    .map(
                      ([k, label, ic, href, count]) =>
                        `<a class="snav-item${count ? " has-count" : ""}" href="${href}" data-nav="${k}" title="${label}"><span class="snav-ic">${icon(ic)}</span><span class="snav-nm">${label}</span>${count ? '<span class="nav-count warn">0</span><span class="snav-dot"></span>' : ""}</a>`,
                    )
                    .join("")
            }</div>`,
        ).join("")}
      </div>
      <div class="snav-fold-row"><button class="snav-fold" type="button" data-act="fold" aria-pressed="${prefs.pin}" title="${prefs.pin ? "Unpin: the rail collapses and opens when you point at it" : "Keep the rail open"}">${icon(prefs.pin ? "panel-close" : "panel-open")}<span>${prefs.pin ? "Unpin" : "Keep open"}</span></button></div>
    </div>`;
    applyRail();
    GO.shell.mark();
    GO.animate(snav);
  }

  /* ---------- The top band ---------- */
  function accountMenu() {
    return `<div class="ws-menu right acct-menu" role="menu">
      <div class="acct-head">${identicon(ME.login, 36)}<span><b>${esc(ME.name)}</b><span class="sub mono">${esc(ME.login)}</span></span></div>
      <div class="dd-sep"></div>
      <div class="dd-label">Theme</div>
      <div class="theme-grid">${THEMES.map((t) => `<button type="button" class="theme-opt${t.id === prefs.theme ? " on" : ""}" data-theme-id="${t.id}" aria-pressed="${t.id === prefs.theme}"><span class="theme-sw" style="--a:${t.sw[0]};--b:${t.sw[1]}"></span>${esc(t.label)}</button>`).join("")}</div>
      <div class="dd-label">Appearance</div>
      <div class="seg" role="group" aria-label="Appearance">${[
        ["system", "System"],
        ["light", "Light"],
        ["dark", "Dark"],
      ]
        .map(
          ([v, l]) =>
            `<button type="button" data-mode="${v}" aria-pressed="${prefs.mode === v}">${l}</button>`,
        )
        .join("")}</div>
      <div class="dd-sep"></div>
      <a class="ws-item" href="#profile-mahmoud"><span><b>Your profile</b></span></a>
      <a class="ws-item" href="#repos"><span><b>Your repositories</b></span></a>
      <a class="ws-item" href="#settings-tokens"><span><b>Settings</b><span class="sub">Tokens, connected apps, emails</span></span></a>
    </div>`;
  }
  function drawBand() {
    const p = GO.ph || { crumbs: [], title: "" };
    const anc = (p.crumbs || []).slice(0, -1);
    const n = GO.approvalsCount();
    ph.innerHTML = `
      <button class="drawer-btn" type="button" data-act="drawer" aria-label="Open navigation" aria-expanded="${navOpen}">${icon("menu")}</button>
      ${p.icon ? `<span class="ph-ic">${icon(p.icon)}</span>` : ""}
      <div class="ph-trail">${anc.map((c) => `<a class="crumb-anc" href="#${c[1]}">${esc(c[0])}</a><span class="crumb-sep">/</span>`).join("")}<h1 tabindex="-1">${esc(p.title || "")}</h1></div>
      <span class="ph-grow"></span>
      <div class="gsearch${menu === "search" ? " open" : ""}" role="search">
        <label class="sr" for="gsearch">Search GitOrange</label>
        ${icon("search", "icon gs-ic")}
        <input id="gsearch" type="search" autocomplete="off" placeholder="Type / to search" value="${esc(searchQ)}" aria-expanded="${menu === "search"}" aria-controls="gsearch-results">
        <kbd class="gs-kbd">/</kbd>
        <div id="gs-slot">${menu === "search" ? searchResults() : ""}</div>
      </div>
      <div class="ph-tools">
        <span class="tool-wrap"><button class="tool" type="button" data-menu="create" aria-label="Create new" aria-expanded="${menu === "create"}">${icon("plus")}${icon("down", "icon chev")}</button>
          ${menu === "create" ? `<div class="ws-menu right" role="menu"><a class="ws-item" href="#new"><span><b>New repository</b></span></a><a class="ws-item" href="#agents-new"><span><b>New reviewer agent</b></span></a><a class="ws-item" href="#settings-tokens"><span><b>New access token</b></span></a></div>` : ""}</span>
        <a class="tool" href="#approvals" aria-label="Approvals, ${n} waiting">${icon("inbox")}${n ? `<span class="tool-dot">${n}</span>` : ""}</a>
        <span class="env" title="This is a mockup with sample data">Mockup</span>
        <span class="tool-wrap"><button class="acct-btn" type="button" data-menu="acct" aria-expanded="${menu === "acct"}" aria-label="Account and theme">${identicon(ME.login, 28)}<span class="acct-name">${esc(ME.login)}</span>${icon("down", "icon chev")}</button>
          ${menu === "acct" ? accountMenu() : ""}</span>
      </div>`;
  }

  /* ---------- Search ---------- */
  // Search never redraws the band: only the results slot changes, so the input keeps focus and caret.
  function drawResults() {
    const slot = $("#gs-slot"),
      box = $(".gsearch"),
      input = $("#gsearch");
    if (!slot) return;
    slot.innerHTML = menu === "search" ? searchResults() : "";
    if (box) box.classList.toggle("open", menu === "search");
    if (input) input.setAttribute("aria-expanded", String(menu === "search"));
  }
  function closeSearch() {
    const input = $("#gsearch");
    menu = null;
    searchQ = "";
    searchSel = 0;
    if (input) {
      input.value = "";
      if (document.activeElement === input) input.blur();
    }
    drawResults();
  }
  let IDX = null;
  function index() {
    const out = [];
    GO.REPOS.forEach((r) =>
      out.push({
        g: "Repositories",
        label: r.name,
        sub: r.description,
        href: "#repo-" + r.name.replace("/", "~"),
        ic: r.agent ? "crew" : "repo",
      }),
    );
    Object.keys(GO.PULLS).forEach((n) =>
      out.push({
        g: "Pull requests",
        label: `#${n} ${GO.PULLS[n].title}`,
        sub: "choyiny/gitorange",
        href: "#pull-" + n,
        ic: "branch",
      }),
    );
    Object.keys(GO.AGENTS).forEach((id) =>
      out.push({
        g: "Agents",
        label: GO.AGENTS[id].name,
        sub: GO.AGENTS[id].job,
        href: "#agent-" + id,
        ic: "crew",
      }),
    );
    (window.REPO_DATA ? window.REPO_DATA.branches : []).forEach((b) =>
      out.push({
        g: "Branches",
        label: b.name,
        sub: b.subject,
        href: "#branches",
        ic: "branch",
      }),
    );
    (window.REPO_DATA ? window.REPO_DATA.paths : []).forEach((p) =>
      out.push({
        g: "Files",
        label: p,
        sub: "choyiny/gitorange",
        href: "#blob-" + p,
        ic: "file",
        file: true,
      }),
    );
    [
      ["Branch map", "#branches"],
      ["Audit log", "#audit"],
      ["Rules for main", "#rules"],
      ["Live", "#live"],
      ["Insights", "#insights"],
      ["Personal access tokens", "#settings-tokens"],
      ["Connected apps (MCP)", "#settings-mcp"],
      ["Usage and cost", "#admin-usage"],
    ].forEach(([l, h]) =>
      out.push({ g: "Pages", label: l, sub: "", href: h, ic: "arrow" }),
    );
    return out;
  }
  function results() {
    const q = searchQ.trim().toLowerCase();
    if (!IDX) IDX = index();
    if (!q)
      return IDX.filter(
        (r) => r.g === "Repositories" || r.g === "Pull requests",
      ).slice(0, 8);
    const hits = IDX.filter((r) =>
      (r.label + " " + (r.sub || "")).toLowerCase().includes(q),
    );
    const groups = {};
    hits.forEach((h) => {
      (groups[h.g] = groups[h.g] || []).push(h);
    });
    return [
      "Repositories",
      "Pull requests",
      "Agents",
      "Branches",
      "Pages",
      "Files",
    ].flatMap((g) => (groups[g] || []).slice(0, g === "Files" ? 6 : 4));
  }
  function searchResults() {
    const rs = results();
    if (!rs.length)
      return `<div class="ws-menu gs-menu" id="gsearch-results" role="listbox"><p class="gs-empty">No results for “${esc(searchQ)}”.</p></div>`;
    let last = "";
    return `<div class="ws-menu gs-menu" id="gsearch-results" role="listbox">${rs
      .map((r, i) => {
        const head =
          r.g !== last
            ? `<div class="dd-label">${esc(searchQ ? r.g : "Jump to")}</div>`
            : "";
        last = r.g;
        return `${head}<a class="ws-item gs-item${i === searchSel ? " sel" : ""}" role="option" href="${r.href}" data-gs="${i}">${icon(r.ic)}<span><b class="${r.file ? "mono" : ""}">${esc(r.label)}</b>${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ""}</span></a>`;
      })
      .join("")}</div>`;
  }

  /* ---------- Marking the current place ---------- */
  const NAV_OF = {
    home: "home",
    repos: "repos",
    new: "repos",
    approvals: "approvals",
    decision: "approvals",
    finding: "approvals",
    agents: "agents",
    crew: "agents",
    agent: "agents",
    settings: "settings",
    admin: "admin",
    profile: "home",
  };
  GO.shell = {
    mark() {
      const cur = GO.current();
      const key = NAV_OF[cur.id] || "repo:" + GO.state.repo;
      $$("[data-nav]", snav).forEach((a) => {
        if (a.dataset.nav === key) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
      const n = GO.approvalsCount();
      $$(".nav-count", snav).forEach((c) => {
        c.textContent = String(n);
        c.toggleAttribute("data-zero", !n);
      });
    },
    update() {
      menu = menu === "search" ? null : menu;
      searchQ = "";
      drawBand();
      GO.shell.mark();
      if (navOpen) {
        navOpen = false;
        applyRail();
      }
    },
  };

  /* ---------- Events ---------- */
  function closeMenus() {
    if (!menu) return;
    const was = menu;
    if (was === "search") return closeSearch();
    menu = null;
    if (was === "org") drawRail();
    else drawBand();
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest(
      'button[data-menu], button[data-act], [data-act="scrim"], button[data-theme-id], button[data-mode], a.gs-item',
    );
    if (!t) {
      if (
        menu &&
        !e.target.closest(".ws-menu, .gsearch, .acct-btn, .snav-org-btn, .tool")
      )
        closeMenus();
      return;
    }
    if (t.dataset.menu) {
      e.preventDefault();
      const m = t.dataset.menu,
        was = menu;
      if (was === "search") closeSearch();
      menu = was === m ? null : m;
      if (m === "org" || was === "org") drawRail();
      drawBand();
      return;
    }
    if (t.dataset.act === "fold") {
      prefs.pin = !prefs.pin;
      store.set("pin", prefs.pin ? "1" : "0");
      peek = false;
      drawRail();
      return;
    }
    if (t.dataset.act === "drawer") {
      navOpen = !navOpen;
      applyRail();
      return;
    }
    if (t.dataset.act === "scrim") {
      navOpen = false;
      applyRail();
      return;
    }
    if (t.dataset.themeId) {
      prefs.theme = t.dataset.themeId;
      store.set("themeId", prefs.theme);
      applyTheme();
      drawBand();
      return;
    }
    if (t.dataset.mode) {
      prefs.mode = t.dataset.mode;
      store.set("theme", prefs.mode);
      applyTheme();
      drawBand();
      return;
    }
    if (t.classList.contains("gs-item")) {
      menu = null;
      searchQ = "";
    }
  });
  document.addEventListener("focusin", (e) => {
    if (e.target.id === "gsearch" && menu !== "search") {
      const was = menu;
      menu = "search";
      searchSel = 0;
      if (was === "org") drawRail();
      else if (was) drawBand();
      drawResults();
    }
  });
  document.addEventListener("focusout", (e) => {
    if (e.target.id !== "gsearch") return;
    setTimeout(() => {
      const a = document.activeElement;
      if (menu === "search" && !(a && a.closest && a.closest(".gsearch"))) closeSearch();
    }, 120);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "gsearch") {
      searchQ = e.target.value;
      searchSel = 0;
      menu = "search";
      drawResults();
    }
  });
  document.addEventListener("keydown", (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(
      document.activeElement && document.activeElement.tagName,
    );
    if (e.key === "/" && !inField) {
      e.preventDefault();
      const i = $("#gsearch");
      if (i) i.focus();
      return;
    }
    if (e.target.id === "gsearch") {
      const rs = results();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        searchSel = Math.min(rs.length - 1, searchSel + 1);
        drawResults();
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        searchSel = Math.max(0, searchSel - 1);
        drawResults();
      }
      if (e.key === "Enter" && rs[searchSel]) {
        e.preventDefault();
        const h = rs[searchSel].href;
        menu = null;
        searchQ = "";
        e.target.blur();
        location.hash = h.slice(1);
      }
      if (e.key === "Escape") closeSearch();
      return;
    }
    if (e.key === "Escape") {
      if (menu) closeMenus();
      else if (navOpen) {
        navOpen = false;
        applyRail();
      }
    }
  });
  /* Peek: the collapsed rail opens over the page while the pointer or focus is in it, with a short close delay. */
  const openPeek = () => {
    clearTimeout(peekTimer);
    if (prefs.pin || peek || NARROW.matches) return;
    peek = true;
    applyRail();
  };
  const closePeek = () => {
    clearTimeout(peekTimer);
    if (!peek) return;
    peekTimer = setTimeout(() => {
      if (menu === "org") return;
      peek = false;
      applyRail();
    }, 220);
  };
  snav.addEventListener("pointerenter", openPeek);
  snav.addEventListener("pointerleave", closePeek);
  snav.addEventListener("focusin", openPeek);
  snav.addEventListener("focusout", (e) => {
    if (!snav.contains(e.relatedTarget)) closePeek();
  });
  NARROW.addEventListener("change", () => {
    navOpen = false;
    peek = false;
    applyRail();
  });

  /* Preview-only overrides so screenshots can choose: ?skin=dev, ?theme=dark, ?pin=1 */
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get("skin") === "dev") prefs.theme = "github";
    if (qs.get("themeId")) prefs.theme = qs.get("themeId");
    if (qs.get("theme")) prefs.mode = qs.get("theme");
    if (qs.get("pin")) prefs.pin = qs.get("pin") === "1";
  } catch (e) {}
  applyTheme();
  drawRail();
  drawBand();
  // The first layout paints without transitions, so the rail never animates from full width on load.
  requestAnimationFrame(() => requestAnimationFrame(() => $("#app").classList.remove("boot")));
})();
