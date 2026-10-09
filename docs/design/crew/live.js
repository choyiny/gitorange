/* Live view (project tab): who is working on GitOrange right now, the merge queue, and the crew's
 * decisions as they happen. Complete at rest; Replay steps through the last 40 minutes from module
 * state, so a re-render mid-replay rebuilds the same moment and the timer carries on. */
(function () {
  "use strict";
  const G = window.GO;
  const H = G.h;
  const { esc, icon } = H;
  const STEP_MS = 1600;
  const CLASH_FILE = "worker/src/index.ts";
  const BRANCH = {
    72: "claude/s4-usd-invoices",
    73: "claude/s4-invoice-pdf",
    74: "codex/s2-live-token",
    75: "cho/insights-findings",
    76: "codex/s5-rate-limit",
    77: "claude/s6-signin-log",
  };
  const BOTS = ["security", "data", "features", "shipping", "fixer"];
  const NONE = new Set();

  /* ---------- The floor at 11:38, before the first replayed event ---------- */
  function base() {
    const pr = (on, crew) => ({ on, lane: "checking", crew: crew || {} });
    return {
      rows: {
        R1: { on: true, i: "eye", t: "Data is checking #72. #73 builds on it." },
        R2: { on: true, i: "spark", t: "Codex·s2 is writing the change." },
        R3: { on: true, i: "spark", t: "Cho is writing it by hand." },
        R4: { on: false },
        R5: { on: false },
      },
      pr: {
        72: pr(true, { data: "reviewing" }),
        73: pr(true, { features: "reviewing" }),
        74: pr(false, { security: "reviewing" }),
        75: pr(false),
        76: pr(false),
        77: pr(false, { security: "reviewing" }),
      },
      clash: false,
      handback: false,
      landed: false,
      bots: { security: "idle", data: "reviewing", features: "reviewing", shipping: "idle", fixer: "idle" },
    };
  }
  const row = (s, id, i, t) => (s.rows[id] = { on: true, i, t });
  const ev = (t, a, text, hot, fx, more) => Object.assign({ t, a, text, hot, fx }, more || {});

  /* Clef's routing for a pull request, with each reviewer's wake threshold. */
  function clefLine(n) {
    const P = G.PULLS[n];
    const at = (id, p) => `${G.AGENTS[id].name} at ${H.pct(p)} (wakes at ${H.pct(G.AGENTS[id].above)})`;
    const list = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : xs[0]);
    const woke = Object.entries(P.crew).filter(([, v]) => v[0] !== "skipped").map(([id, v]) => at(id, v[1]));
    const skip = Object.entries(P.skipped).sort((a, b) => b[1] - a[1]).map(([id, p]) => at(id, p));
    return `woke ${list(woke)}${skip.length ? `, skipped ${list(skip)}` : ""}. Ran ${P.tests[0]} of ${P.tests[1]} test modules in ${P.clefMs} ms.`;
  }

  /* ---------- The script: today, 11:40 to 12:16 ---------- */
  const E = [
    ev("11:40", { coder: "s5" }, "started “Rate-limit the public API” for Mahmoud.", ["R4"], (s) => row(s, "R4", "spark", "Codex·s5 is writing the change.")),
    ev("11:44", { coder: "s6" }, "started “Log every sign-in attempt” for Cho.", ["R5"], (s) => row(s, "R5", "spark", "Claude·s6 is writing the change.")),
    ev("11:52", { coder: "s5" }, "pushed #76 (2 files).", ["R4", "p76"], (s) => {
      s.pr[76].on = true;
      Object.assign(s.bots, { security: "reviewing", shipping: "reviewing" });
      row(s, "R4", "eye", "Security and Shipping are checking #76.");
    }, { clef: true, sub: clefLine(76) }),
    ev("11:58", { coder: "s6" }, "pushed #77.", ["R5", "p77"], (s) => {
      s.pr[77].on = true;
      s.bots.security = "reviewing";
      row(s, "R5", "eye", "Security is checking #77.");
    }, { clef: true, sub: clefLine(77) }),
    ev("11:58", { crew: "clef" }, "found that #76 and #77 change the same lines in worker/src/index.ts · queued #77 after #76.", ["clash", "p77", "R4", "R5"], (s) => {
      s.clash = true;
      row(s, "R4", "eye", "Security and Shipping are checking #76. It merges before #77.");
      row(s, "R5", "clock", "Queued after #76. Security is checking #77.");
    }, { clef: true, kind: "clash", tag: "Clash" }),
    ev("12:01", { crew: "security" }, "passed #77: it records the attempt count, never the password.", ["p77", "R5"], (s) => {
      s.pr[77].crew.security = "clear";
      s.bots.security = "clear";
      row(s, "R5", "clock", "Security passed #77. It is queued after #76.");
    }),
    ev("12:03", { coder: "s2" }, "pushed #74.", ["R2", "p74"], (s) => {
      s.pr[74].on = true;
      s.bots.security = "reviewing";
      row(s, "R2", "eye", "Security is checking #74.");
    }, { clef: true, sub: clefLine(74) }),
    ev("12:05", { crew: "security" }, "requested a change from Codex·s2 on #74: compare tokens in constant time.", ["p74", "R2"], (s) => {
      s.pr[74].crew.security = "asked";
      s.pr[74].lane = "agent";
      s.bots.security = "asked";
      row(s, "R2", "redo", "Security requested a change on #74: compare tokens in constant time.");
    }),
    ev("12:06", { coder: "s2" }, "picked up the requested change on #74.", ["R2"], (s) =>
      row(s, "R2", "spark", "Codex·s2 is making the change Security requested on #74."),
    ),
    ev("12:07", { crew: "fixer" }, "handed #77 back to Claude·s6 with both sides’ intent. Both change the request handler.", ["hand", "p77", "R5"], (s) => {
      s.handback = true;
      s.pr[77].lane = "agent";
      s.bots.fixer = "asked";
      row(s, "R5", "redo", "Fixer handed #77 back to Claude·s6 with both sides’ intent.");
    }, { kind: "fixer", tag: "Handed back", quote: ["#76 limits each token to 60 requests a minute", "#77 records every sign-in attempt"] }),
    ev("12:09", { coder: "s6" }, "is redoing #77 on top of #76.", ["R5"], (s) => row(s, "R5", "spark", "Claude·s6 is redoing #77 on top of #76.")),
    ev("12:10", { coder: "hand" }, "pushed #75.", ["R3", "p75"], (s) => {
      s.pr[75].on = true;
      s.bots.features = "reviewing";
      row(s, "R3", "eye", "Features is checking #75 while 3 of 7 test modules run.");
    }, { clef: true, sub: clefLine(75) }),
    ev("12:12", { crew: "clef" }, "queued #73 to merge right after #72.", ["p73", "R1"], (s) => {
      s.pr[73].crew.features = "clear";
      s.pr[73].lane = "ready";
      row(s, "R1", "eye", "Data is checking #72. #73 is queued to merge right after it.");
    }, { clef: true }),
    ev("12:14", { crew: "data" }, "asked Mahmoud about #72: existing invoices would be set to CAD.", ["p72", "R1"], (s) => {
      s.pr[72].crew.data = "needs";
      s.pr[72].lane = "person";
      s.bots.data = "needs";
      row(s, "R1", "person", "Needs a person: Data asked Mahmoud about existing invoices on #72.");
    }, { kind: "data", tag: "Needs a person" }),
    ev("12:16", { sys: true }, "#71 merged with no person needed · Features passed it and 2 of 7 test modules passed.", ["merged", "R4"], (s) => {
      s.landed = true;
      s.bots.features = "clear";
      row(s, "R4", "eye", "Security and Shipping are checking #76. It is next in the merge queue.");
    }),
  ];

  /* ---------- Replay state (module-local, survives re-renders) ---------- */
  let shown = E.length;
  let playing = false;
  let timer = null;
  let host = null; // the .lv wrapper inside the router's shared root

  function snap(k) {
    const s = base();
    for (let i = 0; i < k; i++) E[i].fx(s);
    return s;
  }
  const onProject = (id) => (G.state.crew.gitorange || []).includes(id);
  const prLink = (n, inner, cls) => `<a class="${cls}" href="#pull-${n}" data-pull="${n}">${inner}</a>`;
  const hit = (hot, key) => (hot.has(key) ? " lv-hit" : "");
  const agent = (id) => `<span class="lv-agent" style="--agent:${G.AGENTS[id].color}"><i></i><b>${esc(G.AGENTS[id].name)}</b></span>`;
  const chip = (cls, i, t) => `<span class="chip ${cls}">${icon(i)}${esc(t)}</span>`;

  /* Escape, then mark file paths as code and link every open pull request. */
  function fmt(s) {
    return esc(s)
      .replace(/\b(?:worker|src|migrations)\/[\w/-]+(?:\.[\w-]+)+/g, (m) => `<code class="lv-code">${m}</code>`)
      .replace(/#(\d{2})\b/g, (m, n) => (G.PULLS[n] ? prLink(n, m, "lv-link") : m));
  }

  /* ---------- Counters ---------- */
  function counts(s) {
    const on = Object.keys(s.rows).filter((id) => s.rows[id].on);
    const person = (id) => G.SESSIONS[G.REQUESTS[id].sessions[0]].coder === "person";
    return {
      agents: on.filter((id) => !person(id)).length,
      people: on.filter(person).length,
      open: Object.values(s.pr).filter((p) => p.on).length + (s.landed ? 0 : 1),
      clash: s.clash ? 1 : 0,
      over: 0,
    };
  }
  function statsHTML(s, prev) {
    const v = counts(s);
    const p = prev ? counts(prev) : v;
    const cell = (keys, n, label, why) =>
      `<div class="stat${keys.some((k) => v[k] !== p[k]) ? " lv-hit" : ""}"><b>${n}</b><span>${label}</span><small class="lv-why">${why}</small></div>`;
    return (
      cell(["agents", "people"], v.agents, `agents and ${v.people} ${v.people === 1 ? "person" : "people"} working`, "Each on its own branch.") +
      cell(["open"], v.open, "open pull requests", "Not merged yet.") +
      cell(["clash"], v.clash, v.clash === 1 ? "clash, ordered" : "clashes", v.clash ? "#77 is queued after #76." : "None so far.") +
      cell(["over"], v.over, "changes overwritten", "Every merge checks main hasn’t moved first.")
    );
  }

  /* ---------- Merge queue: a compact summary (Branches draws the full graph) ---------- */
  function status(s, n) {
    const lane = s.pr[n] && s.pr[n].lane;
    if (n === 72 && lane === "person") return H.chip("needs", "Needs a person");
    if (n === 73 && lane === "ready") return chip("good", "check", "Queued after #72");
    if (n === 74 && lane === "agent") return H.chip("asked", "Changes requested");
    if (n === 77 && s.clash) return chip("warn", "clock", "Waits on #76");
    return H.chip("reviewing", "Checking");
  }
  function pill(s, n, hot, pos) {
    const P = G.PULLS[n];
    const cls = `lv-pill${pos === 1 ? " lv-pill-next" : ""}${hit(hot, "p" + n)}`;
    const body = `${pos ? `<span class="lv-pos" aria-label="Position ${pos}">${pos}</span>` : ""}<b class="mono">#${n}</b>${P ? `<span class="lv-pt">${esc(P.title)}</span>` : ""}${status(s, n)}`;
    return P ? prLink(n, body, cls) : `<span class="${cls}">${body}</span>`;
  }
  function queueHTML(s, hot) {
    const order = [];
    if (!s.landed) order.push(71);
    if (s.pr[76].on) order.push(76);
    if (s.pr[77].on && s.clash) order.push(77);
    const side = [];
    if (s.pr[77].on && !s.clash) side.push(77);
    [74, 75].forEach((n) => s.pr[n].on && side.push(n));
    const arrow = `<span class="lv-arrow" aria-hidden="true">${icon("arrow")}</span>`;
    const track = (cap, body, note) =>
      `<div class="lv-track"><p class="lv-tcap">${cap}</p><div class="lv-tbody"><ol class="lv-train">${body}</ol>${note ? `<p class="lv-tnote">${note}</p>` : ""}</div></div>`;
    const W = G.WEEK;
    const ordered = order.map((n, i) => `<li>${i ? arrow : ""}${pill(s, n, hot, i + 1)}</li>`).join("");
    const clashNote = s.clash && s.pr[77].on ? `#77 waits because it changes the same lines in <code class="lv-code">${CLASH_FILE}</code>.` : "";
    return `<div class="section-head"><h2 id="lv-queue-h">Merge queue</h2><a class="btn quiet small" href="#branches">${icon("branch")}Manage on Branches</a></div>
      <p class="lv-sub">Pull requests merge one at a time. Each merge checks that main hasn’t moved since its checks ran. If it has, the pull request waits its turn.</p>
      <div class="lv-tracks">
        ${track("In order", ordered, clashNote)}
        ${track("Stack", `<li>${pill(s, 72, hot)}</li><li>${arrow}${pill(s, 73, hot)}</li>`, "#73 must account for #72: both change invoice currency.")}
        ${side.length ? track("Not queued", side.map((n) => `<li>${pill(s, n, hot)}</li>`).join("")) : ""}
      </div>
      <div class="lv-qfoot">
        ${s.landed ? `<p class="lv-merged${hit(hot, "merged")}">${icon("check")}Last merged <b class="mono">#71</b> at <span class="mono">12:16</span></p>` : ""}
        <p class="lv-week">13 pull requests clashed this week. All 13 merged and nothing was overwritten. Fixer combined ${W.fixerOk} of ${W.fixerTried} attempts itself; the authors redid the rest.</p>
      </div>`;
  }

  /* ---------- Requests: one row per request ---------- */
  function laneChip(s, n) {
    const lane = s.pr[n].lane;
    if (lane === "person") return H.chip("needs", "Needs a person");
    if (lane === "agent") return G.PULLS[n].clash ? H.chip("asked", "Redoing on top of #" + G.PULLS[n].clash.with) : H.chip("asked", "Changes requested");
    if (lane === "ready") return H.chip("clear", "Queued to merge");
    return H.chip("reviewing", "Checking");
  }
  function prHTML(s, n, hot) {
    const P = G.PULLS[n];
    const st = s.pr[n];
    if (!st.on) return "";
    const crew = Object.entries(P.crew)
      .map(([id, [st0, p]]) => {
        const v = st.crew[id] || st0;
        if (v !== "skipped") return H.verdict(id, v, p);
        return onProject(id) ? H.verdict(id, "skipped", p) : H.verdict(id, "off");
      })
      .join("");
    const skipped = Object.entries(P.skipped).map(([id, p]) => H.verdict(id, "skipped", p)).join("");
    return `<div class="lv-pr${hit(hot, "p" + n)}">
      <div class="lv-pr-top">${prLink(n, `<b class="mono">#${n}</b><span>${esc(P.title)}</span>`, "lv-pr-title")}<code class="lv-branch">${icon("branch")}${esc(BRANCH[n])}</code>${laneChip(s, n)}</div>
      <div class="lv-crew" aria-label="Crew on #${n}">${crew}${skipped}</div>
      <p class="lv-meta">Tests: ${P.tests[0]} of ${P.tests[1]} modules${P.testsRunning ? " running" : ""}<span aria-hidden="true">·</span><span class="mono">Clef ${P.clefMs} ms</span></p>
    </div>`;
  }
  function fileHTML(f, clash) {
    return `<li class="lv-file${clash ? " lv-file-clash" : ""}">${icon(clash ? "alert" : "file")}<span>${esc(f)}</span>${clash ? '<span class="sr"> (same lines as the other pull request)</span>' : ""}</li>`;
  }
  function handbackHTML(hot) {
    return `<div class="lv-handback${hit(hot, "hand")}">
      <p>${agent("fixer")} handed #77 back to Claude·s6 with both sides’ intent. Both change the request handler.</p>
      <dl class="lv-intent"><div><dt class="mono">#76</dt><dd>Limits each token to 60 requests a minute.</dd></div><div><dt class="mono">#77</dt><dd>Records every sign-in attempt.</dd></div></dl>
    </div>`;
  }
  function rowHTML(s, id, hot) {
    const R = G.REQUESTS[id];
    const r = s.rows[id];
    const paired = s.clash && (id === "R4" || id === "R5");
    const files = [...new Set(R.pulls.flatMap((n) => G.PULLS[n].files))];
    const prs = R.pulls.map((n) => prHTML(s, n, hot)).join("");
    const none = `<p class="lv-none">No pull request yet · working on <code class="lv-branch">${icon("branch")}${esc(BRANCH[R.pulls[0]])}</code></p>`;
    return `<article class="lv-row${hit(hot, id)}" aria-labelledby="lv-${id}">
      <div class="lv-top">
        <div class="lv-ask"><span class="lv-by">${esc(R.by)} asked</span><h3 id="lv-${id}">${esc(R.text)}</h3></div>
        ${H.coderLink(R.sessions[0], { noFor: true })}
      </div>
      <p class="lv-step">${icon(r.i)}<span>${esc(r.t)}</span></p>
      <ul class="lv-files" aria-label="Files it touches">${files.map((f) => fileHTML(f, paired && f === CLASH_FILE)).join("")}</ul>
      <div class="lv-prs">${prs || none}</div>
      ${id === "R5" && s.handback ? handbackHTML(hot) : ""}
    </article>`;
  }
  function floorHTML(s, hot) {
    const top = ["R1", "R2", "R3"].map((id) => rowHTML(s, id, hot)).join("");
    const r4 = s.rows.R4.on ? rowHTML(s, "R4", hot) : "";
    const r5 = s.rows.R5.on ? rowHTML(s, "R5", hot) : "";
    if (!s.clash) return top + r4 + r5;
    return `${top}<div class="lv-pair${hit(hot, "clash")}">${r4}
      <div class="lv-clash" role="note"><span class="lv-clash-tag">${icon("alert")}Clash</span><span>Same lines in <code class="lv-code">${CLASH_FILE}</code> → Clef queued <b class="mono">#76</b> first</span></div>
      ${r5}</div>`;
  }

  /* ---------- Event log, newest first ---------- */
  function evHTML(e, fresh) {
    const actor = e.a.crew
      ? agent(e.a.crew)
      : e.a.sys
        ? `<span class="lv-sys">${icon("check")}</span>`
        : G.SESSIONS[e.a.coder].coder === "person"
          ? `<span class="coder"><span class="mono-tile person" aria-hidden="true">${icon("person")}</span><span>${esc(G.SESSIONS[e.a.coder].label)}</span></span>`
          : H.coderLink(e.a.coder, { noFor: true });
    return `<li class="lv-ev${e.kind ? " lv-ev-" + e.kind : ""}${fresh ? " lv-in lv-hit" : ""}">
      <time class="mono" datetime="2026-10-08T${e.t}">${e.t}</time>
      <div class="lv-evt">
        <p>${actor} ${fmt(e.text)}${e.tag ? ` <span class="lv-tag">${esc(e.tag)}</span>` : ""}</p>
        ${e.sub ? `<p class="lv-evsub" style="--agent:${G.AGENTS.clef.color}">${icon("route")}<span><b>Clef</b> ${fmt(e.sub)}</span></p>` : ""}
        ${e.quote ? `<ul class="lv-quote" aria-label="What each side is for">${e.quote.map((q) => `<li>${fmt(q)}</li>`).join("")}</ul>` : ""}
      </div>
    </li>`;
  }
  function eventsHTML() {
    if (!shown) return `<li class="lv-empty">Replay starts at <span class="mono">11:38</span>. Events appear here as they happen.</li>`;
    return E.slice(0, shown).reverse().map((e) => evHTML(e)).join("");
  }
  const crewNowHTML = (bots) => BOTS.map((id) => H.verdict(id, bots[id])).join("");
  function railHeadHTML(s) {
    const clefSt = shown && shown < E.length && E[shown - 1].clef ? "reviewing" : "idle";
    return `<div class="lv-rail-head">${H.avatar("clef", 40, clefSt)}
        <div><h2 id="lv-rail-h">Event log</h2><span>Today · newest first · Clef routes each push in about 40 ms</span></div></div>
      <div class="lv-crewnow" aria-label="Crew, latest state">${crewNowHTML(s.bots)}</div>`;
  }

  /* ---------- Connection state and replay controls (page-header actions) ---------- */
  function ctlHTML() {
    const done = shown >= E.length;
    const t = shown ? E[shown - 1].t : "11:38";
    const btn = (act, i, label, cls) => `<button type="button" class="btn small${cls ? " " + cls : ""}" data-act="${act}">${icon(i)}${label}</button>`;
    const conn =
      !playing && done
        ? `<span class="lv-conn"><i class="lv-dot"></i>Connected · updates as they happen</span>`
        : `<span class="lv-conn lv-conn-replay"><i class="lv-dot"></i>${playing ? "Replaying" : "Replay paused"} <span class="mono">${t}</span><span class="lv-bar" aria-hidden="true"><i style="width:${Math.round((shown / E.length) * 100)}%"></i></span><span class="mono">${shown}/${E.length}</span></span>`;
    const btns = playing
      ? btn("pause", "pause", "Pause") + btn("skip", "arrow", "Skip to now", "quiet")
      : done
        ? btn("replay", "play", "Replay last 40 min")
        : btn("resume", "play", "Resume") + btn("replay", "undo", "Start over", "quiet") + btn("skip", "arrow", "Skip to now", "quiet");
    return `${conn}<span class="lv-btns">${btns}</span>`;
  }

  /* ---------- Patching in place during replay ---------- */
  function put(sel, html) {
    const el = host && host.querySelector(sel);
    if (!el) return;
    const a = document.activeElement;
    const key = el.contains(a) && a.dataset ? a.dataset.pull || a.dataset.act : null;
    el.innerHTML = html;
    const back = key && (el.querySelector(`[data-pull="${key}"]`) || el.querySelector(`[data-act="${key}"]`) || el.querySelector("button"));
    if (back) back.focus();
  }
  const syncControls = () => put(".lv-ctl", ctlHTML());
  /* Clef's avatar is the only robot here; it moves only when an event is Clef's decision. */
  function react(s, e) {
    const strip = host.querySelector(".lv-crewnow");
    if (strip && e && e.a.crew === "fixer" && !G.reduced) {
      strip.innerHTML = crewNowHTML(Object.assign({}, s.bots, { fixer: "running" }));
      const at = shown;
      setTimeout(() => { if (shown === at && strip.isConnected) strip.innerHTML = crewNowHTML(s.bots); }, 1100);
    } else if (strip) strip.innerHTML = crewNowHTML(s.bots);
    const clef = host.querySelector(".lv-rail-head agent-robot-avatar");
    const want = e && e.clef ? "reviewing" : "idle";
    if (clef && (clef.dataset.state !== want || want === "reviewing")) G.setAvatarState(clef, want);
  }
  function patch(stepped) {
    if (!host || !host.isConnected) return;
    const s = snap(shown);
    const e = stepped ? E[shown - 1] : null;
    const hot = e ? new Set(e.hot) : NONE;
    put(".lv-stats", statsHTML(s, e ? snap(shown - 1) : null));
    put(".lv-queue", queueHTML(s, hot));
    put(".lv-floor-list", floorHTML(s, hot));
    const list = host.querySelector(".lv-events");
    if (e) {
      const empty = list.querySelector(".lv-empty");
      if (empty) empty.remove();
      list.insertAdjacentHTML("afterbegin", evHTML(e, true));
    } else list.innerHTML = eventsHTML();
    react(s, e);
    syncControls();
  }
  function halt() {
    playing = false;
    clearInterval(timer);
    timer = null;
    syncControls();
  }
  function tick() {
    const away = G.current && G.current().id !== "live";
    if (away || !host || !host.isConnected) return halt();
    shown = Math.min(shown + 1, E.length);
    patch(true);
    if (shown >= E.length) halt();
  }
  function act(a) {
    if (a === "pause") return halt();
    if (a === "skip") {
      halt();
      shown = E.length;
      return patch(false);
    }
    if (a === "replay") {
      halt();
      shown = G.reduced ? E.length : 0;
      patch(false);
      if (G.reduced) return;
    }
    playing = true;
    clearInterval(timer);
    timer = setInterval(tick, STEP_MS);
    syncControls();
  }
  function onClick(ev) {
    const a = ev.target.closest("[data-act]");
    if (a) return act(a.dataset.act);
    const p = ev.target.closest("[data-pull]");
    if (p && G.ui.openPull && !(ev.metaKey || ev.ctrlKey || ev.shiftKey)) {
      ev.preventDefault();
      G.ui.openPull(Number(p.dataset.pull));
    }
  }

  /* ---------- Render: always the current moment of the replay ---------- */
  function render(root) {
    const s = snap(shown);
    root.innerHTML = `<div class="lv">
      ${H.pageHead({
        crumbs: [["GitOrange", "project"], ["Live"]],
        title: "Live",
        lede: "4 coding agents and 1 person are working on GitOrange right now.",
        actions: `<div class="lv-ctl">${ctlHTML()}</div>`,
        tab: "live",
      })}
      <div class="stats lv-stats">${statsHTML(s)}</div>
      <section class="lv-queue panel" aria-labelledby="lv-queue-h">${queueHTML(s, NONE)}</section>
      <div class="lv-main">
        <section class="lv-floor" aria-labelledby="lv-floor-h">
          <h2 id="lv-floor-h" class="lv-h2">Requests in progress</h2>
          <div class="lv-floor-list panel">${floorHTML(s, NONE)}</div>
        </section>
        <aside class="lv-rail panel" aria-labelledby="lv-rail-h">
          ${railHeadHTML(s)}
          <ol class="lv-events">${eventsHTML()}</ol>
        </aside>
      </div>
    </div>`;
    host = root.querySelector(".lv");
    host.addEventListener("click", onClick);
  }

  G.registerView("live", { title: "Live", navAs: "project", skeleton: "detail", render });
})();
