/* GitOrange mockup v3: Home, project tabs (Overview, Pull requests, Branches, Audit log, Rules),
 * Agents, agent, pull request, session and decision pages. Live and Approvals live in their own files. */
(function () {
  "use strict";
  const { AGENTS, REVIEWERS, STATES, SESSIONS, REQUESTS, PULLS, LANES, state } =
    GO;
  const {
    $,
    esc,
    icon,
    pct,
    avatar,
    chip,
    verdict,
    coder,
    coderLink,
    spark,
    pageHead,
  } = GO.h;
  state.landed = state.landed || [];

  /* ---------- Derived state ---------- */
  const onCrew = (id) =>
    AGENTS[id].group === "flow" ||
    (state.crew.gitorange.includes(id) && !state.reviewerOff[id]);
  const findings = () => (GO.extraApprovals ? GO.extraApprovals() : 0);
  const openPulls = () =>
    Object.keys(PULLS)
      .map(Number)
      .filter((n) => !state.landed.includes(n));
  const dot = (id, label) =>
    `<span class="adot" style="--agent:${AGENTS[id].color}"><i></i>${esc(label == null ? AGENTS[id].name : label)}</span>`;

  function crewStates() {
    const d = state.decision;
    const s = {
      clef: "clear",
      fixer: "clear",
      security: "asked",
      features: "reviewing",
      shipping: "clear",
      data:
        d === "pending" || d === "askedCho"
          ? "needs"
          : d === "fix"
            ? "reviewing"
            : "clear",
    };
    for (const id of REVIEWERS) if (!onCrew(id)) s[id] = "off";
    for (const id of ["speed", "reliability", "privacy"])
      if (onCrew(id)) s[id] = "reviewing";
    return s;
  }
  /* #72 moves once the owner answers. */
  function pull(n) {
    const p = Object.assign({}, PULLS[n]);
    if (n === 72) {
      const d = state.decision;
      if (d === "approved")
        Object.assign(p, {
          lane: "ready",
          inState: "just now",
          crew: Object.assign({}, p.crew, { data: ["clear", 0.97] }),
          reason: {
            kind: "queued",
            text: "Mahmoud approved it. It merges next, then #73.",
          },
        });
      if (d === "fix")
        Object.assign(p, {
          lane: "agent",
          inState: "just now",
          crew: Object.assign({}, p.crew, { data: ["asked", 0.97] }),
          reason: {
            kind: "change_requested",
            agent: "data",
            text: "Some invoices were in US dollars. Claude·s4 is keeping their currency.",
          },
        });
      if (d === "askedCho")
        Object.assign(p, {
          reason: {
            kind: "needs_person",
            agent: "data",
            text: "Waiting for Cho: were any existing invoices in US dollars?",
          },
        });
    }
    if (state.held.includes(n)) p.held = true;
    return p;
  }
  /* One plain label per PR state, with the actor. Used everywhere a PR's state appears. */
  function prState(n) {
    const p = pull(n),
      s = SESSIONS[p.session];
    if (state.landed.includes(n)) return { st: "clear", label: "Merged" };
    if (p.held) return { st: "idle", label: "Held by Mahmoud" };
    if (n === 77)
      return { st: "asked", label: "Redoing on top of #76 · Claude·s6" };
    if (p.lane === "person")
      return {
        st: "needs",
        label: state.decision === "askedCho" ? "Needs Cho" : "Needs Mahmoud",
      };
    if (p.lane === "agent")
      return { st: "asked", label: `Changes requested · ${s.label}` };
    if (p.lane === "ready")
      return {
        st: "clear",
        label:
          p.stackedOn && !state.landed.includes(p.stackedOn)
            ? `Queued after #${p.stackedOn}`
            : "Queued to merge",
      };
    return {
      st: "reviewing",
      label: n === 76 ? "Checking · merges next" : "Checking",
    };
  }

  /* ---------- Sample data for the pages ---------- */
  const SUMMARIES = {
    72: [
      [
        "worker/src/db/app.schema.ts",
        "Adds a required currency column to invoices.",
      ],
      [
        "migrations/0043_invoice_currency.sql",
        "Creates the column with default CAD, so every existing row becomes CAD.",
      ],
      [
        "worker/src/billing/invoices.ts",
        "Returns the currency with each invoice in the API.",
      ],
    ],
    73: [
      [
        "worker/src/billing/pdf.ts",
        "Prints the currency code next to every total.",
      ],
      ["src/pages/Invoice.tsx", "Shows the currency on the invoice page."],
    ],
    74: [
      [
        "worker/src/live/hub.ts",
        "Checks a bearer token before opening the live-updates socket.",
      ],
    ],
    75: [
      [
        "src/pages/RepoInsights.tsx",
        "Adds a findings-per-agent table to Insights.",
      ],
      ["worker/src/lib/insights.ts", "Counts findings by reviewer agent."],
    ],
    76: [
      [
        "worker/src/index.ts",
        "Wraps every /api route in a per-token rate limit.",
      ],
      [
        "worker/src/lib/limits.ts",
        "Adds a sliding-window limiter: 60 requests a minute per token.",
      ],
    ],
    77: [
      [
        "worker/src/index.ts",
        "Records each sign-in attempt in the request handler.",
      ],
      [
        "worker/src/auth/index.ts",
        "Writes the attempt count and outcome, never the password.",
      ],
    ],
  };
  const DIFFS = {
    72: {
      file: "migrations/0043_invoice_currency.sql",
      lines: [
        ["ctx", "", "-- 0043: store a currency with every invoice"],
        [
          "add",
          "s4 · 7",
          "ALTER TABLE invoices ADD COLUMN currency TEXT NOT NULL",
        ],
        ["add", "s4 · 7", "  DEFAULT 'CAD';"],
        [
          "add",
          "s4 · 8",
          "UPDATE invoices SET currency = 'CAD' WHERE currency IS NULL;",
        ],
      ],
    },
    73: {
      file: "worker/src/billing/pdf.ts",
      lines: [
        ["ctx", "", "function totalLine(inv: Invoice) {"],
        ["del", "", "  return `Total: ${money(inv.amount)}`;"],
        [
          "add",
          "s4 · 19",
          "  return `Total: ${money(inv.amount)} ${inv.currency}`;",
        ],
        ["ctx", "", "}"],
      ],
    },
    74: {
      file: "worker/src/live/hub.ts",
      lines: [
        ["ctx", "", "const token = bearer(request);"],
        [
          "add",
          "s2 · 4",
          "if (token !== env.LIVE_TOKEN) return unauthorized();",
        ],
        ["ctx", "", "return this.accept(request);"],
      ],
    },
    75: {
      file: "worker/src/lib/insights.ts",
      lines: [
        ["ctx", "", "export function findingsByAgent(rows: Flag[]) {"],
        ["add", "Cho", "  return groupBy(rows, (r) => r.agentHandle);"],
        ["ctx", "", "}"],
      ],
    },
    76: {
      file: "worker/src/index.ts",
      lines: [
        ["ctx", "", "app.use('/api/*', session());"],
        ["add", "s5 · 6", "app.use('/api/*', rateLimit({ perMinute: 60 }));"],
        ["ctx", "", "app.route('/api', api);"],
      ],
    },
    77: {
      file: "worker/src/index.ts",
      lines: [
        ["ctx", "", "app.use('/api/*', session());"],
        ["add", "s6 · 9", "app.use('/api/*', recordSignInAttempt());"],
        ["ctx", "", "app.route('/api', api);"],
      ],
      fixer: [
        "app.use('/api/*', session());",
        "<<<<<<< #76: limit each token to 60 requests a minute",
        "app.use('/api/*', rateLimit({ perMinute: 60 }));",
        "=======",
        "app.use('/api/*', recordSignInAttempt());",
        ">>>>>>> #77: record every sign-in attempt",
        "app.route('/api', api);",
      ],
    },
  };
  const SESSION_STEPS = {
    s4: [
      ["08:31", "prompt", "Cho: “Bill the first US client in US dollars.”"],
      [
        "08:33",
        "plan",
        "Plan: add a currency to invoices, show it on PDFs. Split into two pull requests.",
      ],
      [
        "08:44",
        "edit",
        "Step 7: add the currency column, default CAD",
        "3f9a2c1",
      ],
      [
        "08:50",
        "edit",
        "Step 8: migration 0043 backfills existing rows",
        "8be0d47",
      ],
      ["09:02", "test", "Ran billing tests: 41 passed"],
      ["09:12", "push", "Opened #72", "c41e9f2"],
      [
        "09:40",
        "edit",
        "Step 19: print the currency on PDFs, opened #73 on top of #72",
        "a1d5e60",
      ],
    ],
    s2: [
      [
        "10:02",
        "prompt",
        "Mahmoud: “Protect the live-updates feed with a token.”",
      ],
      [
        "10:10",
        "edit",
        "Step 4: check a bearer token before opening the socket",
        "5c0b8e3",
      ],
      ["12:03", "push", "Opened #74"],
      [
        "12:05",
        "handback",
        "Security requested changes: compare tokens in constant time.",
      ],
      ["12:06", "claim", "Picked up the fix on #74"],
    ],
    s5: [
      ["11:40", "prompt", "Mahmoud: “Rate-limit the public API.”"],
      [
        "11:47",
        "edit",
        "Step 6: per-token limit on every /api route",
        "e72a913",
      ],
      ["11:52", "push", "Opened #76 (2 files)"],
    ],
    s6: [
      ["11:44", "prompt", "Cho: “Log every sign-in attempt.”"],
      [
        "11:51",
        "edit",
        "Step 9: record each attempt in the request handler",
        "0d6f2b8",
      ],
      ["11:58", "push", "Opened #77"],
      [
        "12:07",
        "handback",
        "Fixer couldn’t combine #77 with #76. Both change the request handler. Intents passed on: “#76 limits each token to 60 requests a minute” and “#77 records every sign-in attempt”.",
      ],
      ["12:09", "claim", "Redoing #77 on top of #76"],
    ],
  };
  const MERGES = [
    [
      "12:16",
      71,
      "Rename pull states",
      "GitOrange auto-merge",
      "Features passed",
      "8b2d5a1",
      "c9a41f0",
    ],
    [
      "11:47",
      70,
      "Deploy notes for queue limits",
      "GitOrange auto-merge",
      "Shipping note marked planned by Claude for Mahmoud",
      "3f01c77",
      "8b2d5a1",
    ],
    [
      "11:20",
      69,
      "Backfill reviewer names",
      "Cho, merge button",
      "Data finding approved by Cho · reason: intended behaviour",
      "e5a20d4",
      "3f01c77",
    ],
    [
      "10:51",
      68,
      "Findings tab on pull requests",
      "GitOrange auto-merge",
      "Features note approved by Claude for Mahmoud",
      "91cc3b2",
      "e5a20d4",
    ],
    [
      "10:05",
      67,
      "Reviewer agents learn from dismissals",
      "GitOrange auto-merge",
      "Data and Features requests dismissed by Mahmoud · 2 rules saved",
      "4d7e0aa",
      "91cc3b2",
    ],
    [
      "09:40",
      66,
      "Drop review flag source column",
      "GitOrange auto-merge",
      "Data passed · Shipping passed",
      "b0e19f5",
      "4d7e0aa",
    ],
  ];

  /* ---------- Shared fragments ---------- */
  function decisionCard() {
    const d = state.decision;
    if (d !== "pending") {
      const m = {
        approved: [
          "You approved the invoice-currency change.",
          state.landed.includes(72)
            ? "It merged, and the PDF change merged after it."
            : "It merges next, then the PDF change.",
        ],
        fix: [
          "Claude is fixing the invoice-currency change.",
          "Invoices that were in US dollars will keep their currency. Data reviews it again.",
        ],
        askedCho: [
          "Cho has the invoice question.",
          "You’ll get a reminder at 5 pm if Cho hasn’t answered.",
        ],
      }[d];
      return `<div class="ask done"><div class="ask-body"><strong>${esc(m[0])}</strong><p>${esc(m[1])}</p></div><a class="btn small" href="#decision-72">View</a></div>`;
    }
    return `<div class="ask">
      ${avatar("data", 56, "needs")}
      <div class="ask-body">
        <span class="ask-from">Data is asking · GitOrange</span>
        <strong>Were all your invoices so far in Canadian dollars?</strong>
        <p>The invoice-currency change will mark 1,284 existing invoices as Canadian dollars.</p>
        <span class="ask-meta">${icon("clock")}Waiting since 09:12 · Holds up #73 · Written by Claude for Cho</span>
      </div>
      <a class="btn primary" href="#decision-72">Answer</a>
    </div>`;
  }
  function trendTable() {
    const rows = [
      {
        label: "Security",
        now: "No open problems",
        cmp: "Same as last week",
        dir: "same",
        vals: [2, 1, 1, 0, 1, 0, 0, 0],
        unit: " open",
      },
      {
        label: "Saved data",
        now: "Nothing lost",
        cmp: "2 data changes reviewed",
        dir: "same",
      },
      {
        label: "Speed",
        now: "API answers in 180 ms",
        cmp: "Was 240 ms",
        dir: "better",
        vals: [262, 250, 255, 240, 236, 230, 210, 180],
        unit: " ms",
      },
      {
        label: "Errors people saw",
        now: "3 this week",
        cmp: "Was 1",
        dir: "worse",
        vals: [2, 1, 1, 0, 2, 1, 1, 3],
        unit: " errors",
        action: onCrew("reliability")
          ? '<span class="muted small">Reliability reviews changes now.</span>'
          : '<button class="btn small" type="button" data-add="reliability">Add Reliability</button>',
      },
    ];
    const dir = (r) =>
      r.dir === "better"
        ? `<span class="chip good">${icon("up")}Better</span>`
        : r.dir === "worse"
          ? `<span class="chip serious">${icon("down")}Worse</span>`
          : `<span class="chip off">${icon("dot")}Same</span>`;
    return `<div class="table-wrap"><table class="table">
      <thead><tr><th>Area</th><th>This week</th><th>Last 8 weeks</th><th>Change</th><th><span class="sr">Action</span></th></tr></thead>
      <tbody>${rows
        .map(
          (
            r,
          ) => `<tr><th scope="row">${esc(r.label)}</th><td><b>${esc(r.now)}</b><br><span class="muted small">${esc(r.cmp)}</span></td>
        <td>${r.vals ? spark(r.vals, { w: 104, h: 28, unit: r.unit, cls: r.dir === "better" ? "better" : r.dir === "worse" ? "worse" : "", label: `${r.label}, last 8 weeks`, labels: r.vals.map((_, i) => (i === 7 ? "This week" : `${7 - i} weeks ago`)) }) : '<span class="muted small">Not measured</span>'}</td>
        <td>${dir(r)}</td><td>${r.action || ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>`;
  }

  /* =====================================================================
   * HOME: the owner's answer first
   * ===================================================================== */
  GO.registerView("home", {
    title: "Home",
    skeleton: "overview",
    render(root) {
      const dec = state.decision === "pending" ? 1 : 0,
        f = findings();
      const parts = [
        dec && "1 decision",
        f && `${f} finding${f === 1 ? "" : "s"}`,
      ].filter(Boolean);
      const h1 = parts.length
        ? `Nothing is broken. ${parts.join(" and ")} need${dec + f === 1 ? "s" : ""} you.`
        : "Nothing is broken. Nothing needs you.";
      const g = crewStates();
      const busy = ["data", "security", "features"].filter(
        (id) => g[id] !== "clear" && g[id] !== "off",
      );
      const activity = [
        [
          "security",
          "Security requested changes on #74 before it merged: compare tokens in constant time. Nothing was exposed.",
          "12:05",
          "pull-74",
        ],
        [
          "data",
          `Data saved a rule from your dismissal on #67: ${AGENTS.data.lessons[0].plain}`,
          "Today",
          "agent-data",
        ],
        [
          "features",
          `Features saved a rule from your dismissal on #67: ${AGENTS.features.lessons[0].plain}`,
          "Today",
          "agent-features",
        ],
        [
          "fixer",
          "13 pull requests clashed this week. All 13 merged and nothing was overwritten. Fixer combined 9 itself; the authors redid the rest.",
          "This week",
          "live",
        ],
      ];
      root.innerHTML = `
        ${pageHead({ crumbs: [["Home"]], icon: "home", pre: '<span class="eyebrow">Thursday 8 October</span>', title: h1, lede: `GitOrange merged ${67 + state.landed.length} changes this week and 56 needed no one. Errors people saw rose from 1 to 3.` })}
        <div class="cols home-cols"><div class="col">
        ${decisionCard()}
        ${f ? `<a class="strip-link" href="#approvals">${icon("inbox")}<span><b>${f} developer finding${f === 1 ? "" : "s"}</b> waiting in Approvals</span>${icon("arrow")}</a>` : ""}
        <section class="section"><div class="section-head"><h2>Since last week</h2></div>
          <div class="glance">
            <span class="glance-item good">${icon("up")}<span><b>Better</b> API answers in 180 ms, down from 240 ms</span></span>
            <span class="glance-item">${icon("dot")}<span><b>Same</b> No open security problems</span></span>
            <span class="glance-item worse">${icon("down")}<span><b>Worse</b> 3 errors reached people, up from 1</span></span>
          </div></section>
        <section class="section"><div class="section-head"><h2>Health of choyiny/gitorange</h2></div>
          <a class="proj" href="#project">
            <div class="proj-head"><span class="proj-name mono">choyiny/gitorange</span>${state.decision === "pending" ? chip("needs", "1 decision for you") : chip("clear", "Healthy")}</div>
            <div class="proj-stats"><span><b>${openPulls().length}</b> open</span><span><b>${67 + state.landed.length}</b> merged this week</span><span><b>84%</b> with no merge click</span><span><b>0</b> overwritten</span></div>
            <div class="proj-crew">${busy.map((id) => dot(id, `${AGENTS[id].name}: ${STATES[g[id]].label.toLowerCase()}`)).join("")}<span class="muted small">${REVIEWERS.filter(onCrew).length - busy.length} other reviewers passed</span></div>
          </a></section>
        <section class="section"><div class="section-head"><h2>Activity</h2></div>
          <ul class="list">${activity.map(([id, text, when, href]) => `<li>${dot(id, "")}<a href="#${href}">${esc(text)}</a><span class="when">${when}</span></li>`).join("")}</ul></section>
        </div>
        <aside class="col side"><section class="panel pad home-repos"><div class="section-head"><h2>Repositories</h2><a class="btn small primary" href="#new">${icon("plus")}New</a></div>
          <ul class="plain">${GO.REPOS.map((r) => `<li><a class="home-repo" href="#repo-${r.name.replace("/", "~")}">${icon(r.kind === "agent" ? "crew" : "repo")}<span class="mono">${esc(r.name)}</span></a></li>`).join("")}</ul>
          <a class="small" href="#repos">All repositories</a></section>
          <section class="panel pad"><h2>Your crew</h2><div class="agentstack">${["security", "data", "features", "shipping"].map((id) => `<a href="#agent-${id}" title="${AGENTS[id].name}">${GO.h.avatar(id, 44, g[id] === "needs" ? "needs" : "idle")}</a>`).join("")}</div><a class="small" href="#agents">Agents</a></section>
        </aside></div>`;
    },
  });

  /* =====================================================================
   * PROJECT: Overview tab (owner layer)
   * ===================================================================== */
  GO.registerView("project", {
    title: "Health",
    navAs: "project",
    skeleton: "overview",
    render(root) {
      const pending = state.decision === "pending",
        g = crewStates();
      const on = REVIEWERS.filter(onCrew),
        off = REVIEWERS.filter((id) => !onCrew(id));
      const row = (id) => {
        const a = AGENTS[id],
          st = g[id],
          t = a.track || {};
        const record =
          a.group === "flow"
            ? t.line
            : t.raised
              ? `${t.raised} raised this week · ${t.setAside} dismissed · ${t.rules} rule${t.rules === 1 ? "" : "s"} learned`
              : "Added today";
        return `<a class="rrow" href="#agent-${id}">${avatar(id, 40, st)}<span class="rrow-main"><b>${esc(a.name)}</b><span class="muted small">${esc(a.job)}</span></span><span class="rrow-rec small">${esc(record)}</span>${chip(st)}</a>`;
      };
      const offRow = (id) => {
        const a = AGENTS[id],
          r = a.recommend || { level: "Optional", text: "" },
          was = state.reviewerOff[id];
        return `<div class="rrow off">${avatar(id, 40, "off")}<span class="rrow-main"><b>${esc(a.name)}</b><span class="muted small">${esc(a.job)}</span></span><span class="rrow-rec small">${was ? `Turned off by ${esc(was.by)} at ${esc(was.at)}` : `<b>${esc(r.level)}.</b> ${esc(r.text)}`}</span>${was ? `<a class="btn small" href="#agent-${id}">Review</a>` : `<button class="btn small" type="button" data-add="${id}">${icon("plus")}Add</button>`}</div>`;
      };
      const movers = [
        ["s4", "31 changes", "Made the API about 25% faster (#64)", "better"],
        [
          "s2",
          "18 changes",
          "One security slip, caught before merge (#74)",
          "worse",
        ],
        ["hand", "9 changes", "Nothing got worse", "same"],
      ];
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Health"]], title: "Health", lede: `${pending ? "1 decision needs you. " : ""}${openPulls().length} pull requests open. ${67 + state.landed.length} merged this week; 56 needed no one.`, tab: "project" })}
        ${pending ? decisionCard() : ""}
        <section class="section"><div class="section-head"><h2>Did anything get worse?</h2></div>${trendTable()}</section>
        <section class="section"><div class="section-head"><h2>Branch map</h2><a class="small" href="#branches">Open the full map</a></div>${GO.branchMap ? GO.branchMap({ compact: true }) : ""}</section>
        <section class="section"><div class="section-head"><h2>Who made things better or worse</h2><span class="muted small">This week</span></div>
          <ul class="list movers">${movers.map(([sid, cnt, text, dir]) => `<li>${coderLink(sid)}<span class="muted small">${cnt}</span><span class="mover ${dir}">${icon(dir === "better" ? "up" : dir === "worse" ? "alert" : "dot")}${esc(text)}</span></li>`).join("")}</ul></section>
        <section class="section"><div class="section-head"><h2>Reviewers</h2><a class="small" href="#agents">All agents</a></div>
          <div class="rlist">${on.map(row).join("")}${off.map(offRow).join("")}</div></section>
        <section class="section"><div class="section-head"><h2>Built in</h2></div><div class="rlist">${row("clef")}${row("fixer")}</div></section>`;
    },
  });

  /* =====================================================================
   * PULL REQUESTS tab
   * ===================================================================== */
  function prCard(n) {
    const p = pull(n);
    const woke = Object.entries(p.crew).filter(([, v]) => v[0] !== "skipped");
    return `<a class="prcard" href="#pull-${n}">
      <span class="prcard-title"><span class="mono muted">#${n}</span> ${esc(p.title)}</span>
      ${coder(p.session)}
      <span class="prcard-reason">${esc(p.reason.text)}</span>
      <span class="verdicts">${woke.map(([id, v]) => verdict(id, v[0], v[1])).join("")}</span>
      <span class="prcard-foot">${icon("clock")}${esc(p.inState)}${p.stackedOn ? ` · after #${p.stackedOn}` : ""}${p.after ? ` · waits on #${p.after}` : ""}${p.held ? " · held" : ""}</span>
    </a>`;
  }
  GO.registerView("pulls", {
    title: "Pull requests",
    navAs: "project",
    skeleton: "list",
    render(root) {
      const lanes = LANES.map((l) => {
        const ns = openPulls().filter((n) => pull(n).lane === l.id);
        return `<div class="lane"><h3>${icon(l.icon)}${l.label}<span class="count" ${ns.length ? "" : "data-zero"}>${ns.length}</span></h3>${ns.map(prCard).join("") || '<p class="muted small">None</p>'}</div>`;
      }).join("");
      root.innerHTML = `
        ${pageHead({ crumbs: [["GitOrange", "project"], ["Pull requests"]], title: "Pull requests", lede: `${openPulls().length} open, sorted by who has to act next.`, actions: `<a class="btn" href="#live">${icon("live")}Live</a>`, tab: "pulls" })}
        <div class="lanes">${lanes}</div>
        <section class="section"><div class="section-head"><h2>This week</h2><span class="muted small">choyiny/gitorange, 1–8 October</span></div>
          <div class="stats">
            <div class="stat"><b>84%</b><span>merged with no merge click (56 of 67)</span></div>
            <div class="stat"><b>12 min</b><span>median from opening to merge</span></div>
            <div class="stat"><b>96%</b><span>of 291 check runs passed</span></div>
            <div class="stat"><b>13 of 13</b><span>clashing pull requests merged. Fixer combined 9 of 54 attempts; authors redid the rest.</span></div>
          </div></section>`;
    },
  });

  /* =====================================================================
   * BRANCHES tab: merge queue, main, graph, branches, clean-up
   * ===================================================================== */
  const T0 = 8 * 60,
    T1 = 12 * 60 + 34,
    NOW = 12 * 60 + 22;
  const mins = (t) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const MAIN = [
    ["64", "08:12"],
    ["65", "08:55"],
    ["66", "09:40"],
    ["67", "10:05"],
    ["68", "10:51"],
    ["69", "11:20"],
    ["70", "11:47"],
    ["71", "12:16"],
  ];
  const OPEN = [
    {
      n: 76,
      name: "codex/s5-rate-limit",
      fork: "11:40",
      commits: ["11:52"],
      behind: 2,
      ahead: 1,
      active: "30 min ago",
    },
    {
      n: 77,
      name: "claude/s6-signin-log",
      fork: "11:44",
      commits: ["11:58"],
      behind: 2,
      ahead: 1,
      active: "13 min ago",
    },
    {
      n: 72,
      name: "claude/s4-usd-invoices",
      fork: "08:31",
      commits: ["08:50", "09:02", "09:12"],
      behind: 7,
      ahead: 3,
      active: "3 h ago",
    },
    {
      n: 73,
      name: "claude/s4-invoice-pdf",
      fork: "09:12",
      from: 72,
      commits: ["09:40"],
      behind: 7,
      ahead: 1,
      active: "2 h ago",
    },
    {
      n: 75,
      name: "cho/insights-findings",
      fork: "11:05",
      commits: ["11:30", "12:10"],
      behind: 3,
      ahead: 2,
      active: "12 min ago",
    },
    {
      n: 74,
      name: "codex/s2-live-token",
      fork: "10:02",
      commits: ["10:10", "12:03"],
      behind: 4,
      ahead: 2,
      active: "16 min ago",
    },
  ];
  const queue = [76, 77, 72, 73, 75, 74];
  let branchQuery = "",
    branchSort = "queue",
    staleDays = "21",
    archived = false,
    pausing = false,
    reverting = false,
    movePreview = null;
  function blocker(n) {
    const p = pull(n);
    if (p.held) return "Held by Mahmoud";
    if (n === 76) return "Tests running (5 of 7 modules)";
    if (n === 77) return "Waits on #76. Claude·s6 is redoing it on top.";
    if (n === 72)
      return state.decision === "pending"
        ? "Data needs Mahmoud’s answer"
        : state.decision === "fix"
          ? "Claude·s4 is making changes"
          : state.decision === "askedCho"
            ? "Waiting for Cho"
            : "Nothing. It merges next.";
    if (n === 73)
      return state.landed.includes(72)
        ? "Nothing"
        : "Must account for #72: both change invoice currency";
    if (n === 75) return "Tests running (3 of 7 modules)";
    return "Codex·s2 is fixing Security’s request";
  }
  const eta = (n) =>
    ({
      76: "~4 min",
      77: "~20 min",
      72: state.decision === "approved" ? "~2 min" : "After an answer",
      73: state.decision === "approved" ? "~3 min" : "After #72",
      75: "~6 min",
      74: "~15 min",
    })[n];

  /* =====================================================================
   * BRANCH MAP: main as a line of merges (real, oldest on the left), every branch drawn off it.
   * In flight above main, coloured by state. Below main: real branches whose pull requests already merged
   * but were never deleted, so the clean-up is visible and one click away.
   * ===================================================================== */
  const LEFTOVER = [['rebase-merging', 67, 'Rebase merging'], ['reviewer-agents-drop-policy-columns', 54, 'Drop review.yml'], ['stack-tree-m2b', 47, 'Stack tree milestone 2b'], ['faster-conflict-resolution', 43, 'Faster AI conflict'], ['stacking-always-on', 42, 'Stacking is always on'], ['auto-merge-delete-branch', 41, 'Auto-merge deletes'], ['claude-md-deploys', 40, 'CLAUDE.md: agents may deploy'], ['stack-tree-m2', 39, 'Land PR states'], ['stack-tree', 37, 'PR states (milestone 2a)']];
  let pruned = [], showMerged = true, cleaning = false;
  const FORK_BACK = { 72: 9, 73: 7, 74: 6, 75: 4, 76: 2, 77: 2 };
  function branchMap(order, o = {}) {
    const D = window.REPO_DATA || { commits: [] };
    const real = D.commits.filter(c => c.pr).slice(0, o.compact ? 14 : 26).reverse();
    const st = real.map(c => ({ pr: c.pr, title: c.subject.replace(/\s*\(#\d+\)\s*$/, ''), date: c.date }))
      .concat([[68, 'Findings tab on pull requests'], [69, 'Backfill reviewer names'], [70, 'Deploy notes for queue limits'], [71, 'Rename pull states']].map(([pr, title]) => ({ pr, title, example: true })))
      .concat(state.landed.map(n => ({ pr: n, title: PULLS[n].title, example: true })));
    const gap = o.compact ? 26 : 30, L = o.compact ? 200 : 250;
    const X = i => L + i * gap;
    const nowX = X(st.length - 1) + 64;
    const W = nowX + (o.compact ? 170 : 220);
    const open = order.filter(n => !state.landed.includes(n));
    const left = o.compact || !showMerged ? [] : LEFTOVER.filter(([b]) => !pruned.includes(b));
    const laneH = o.compact ? 34 : 40, top = 34;
    const mainY = top + open.length * laneH + 22;
    const H = mainY + (left.length ? 40 + left.length * laneH : 30) + 10;
    const yOpen = {}; open.forEach((n, i) => { yOpen[n] = top + i * laneH; });
    const idxOf = pr => st.findIndex(s => s.pr === pr);
    let out = '';
    /* day separators */
    let lastDay = '';
    st.forEach((s, i) => {
      const day = s.date ? new Date(s.date).toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric', timeZone: 'America/Toronto' }) : 'Thu 8';
      if (day !== lastDay) { out += `<g class="g-day"><line x1="${X(i) - gap / 2}" x2="${X(i) - gap / 2}" y1="16" y2="${H - 6}"/><text x="${X(i) - gap / 2 + 4}" y="12">${esc(day)}</text></g>`; lastDay = day; }
    });
    out += `<line class="g-now" x1="${nowX}" x2="${nowX}" y1="16" y2="${H - 6}"/><text class="g-now-t" x="${nowX}" y="12" text-anchor="middle">now</text>`;
    /* main */
    out += `<text class="g-main-label" x="12" y="${mainY + 4}">main</text><text class="g-sub" x="52" y="${mainY + 4}">${icon ? '' : ''}healthy · tests passing</text>`;
    out += `<line class="g-mainline" x1="${L - 26}" x2="${nowX}" y1="${mainY}" y2="${mainY}"/>`;
    st.forEach((s, i) => { out += `<g class="g-main-commit${s.example ? ' ex' : ''}"><circle cx="${X(i)}" cy="${mainY}" r="4.6"><title>#${s.pr} ${esc(s.title)} merged${s.example ? ' (example)' : ''}</title></circle>${i % 2 === 0 || o.compact ? `<text x="${X(i)}" y="${mainY + 18}" text-anchor="middle">#${s.pr}</text>` : ''}</g>`; });
    /* open branches */
    open.forEach(n => {
      const b = OPEN.find(x => x.n === n), y = yOpen[n], p = pull(n), sess = SESSIONS[p.session], s = prState(n), cls = STATES[s.st].cls;
      const fi = Math.max(0, st.length - 1 - (FORK_BACK[n] || 3)), fx = X(fi);
      const fromY = b.from && yOpen[b.from] != null ? yOpen[b.from] : mainY;
      const commitsX = b.commits.map((_, k) => fx + 26 + (k + 1) * ((nowX - fx - 40) / (b.commits.length + 1)));
      const mono = sess.coder === 'person' ? '' : sess.coder === 'claude' ? 'C' : 'X';
      const flag = s.st === 'needs' ? 'Needs a person' : n === 77 ? 'Manual redo' : '';
      out += `<a href="#pull-${n}" class="g-lane s-${cls}" aria-label="#${n} ${esc(p.title)}: ${esc(s.label)}">
        <rect class="g-hit" x="0" y="${y - laneH / 2 + 3}" width="${W}" height="${laneH - 6}" rx="6"/>
        <rect class="g-mono ${sess.coder}" x="12" y="${y - 10}" width="20" height="20" rx="5"/>${mono ? `<text class="g-mono-t ${sess.coder}" x="22" y="${y + 4}" text-anchor="middle">${mono}</text>` : `<circle class="g-person" cx="22" cy="${y - 2}" r="3.5"/><path class="g-person" d="M16 ${y + 7} q6 -7 12 0"/>`}
        <text class="g-branch" x="40" y="${y - 1}">${esc(b.name.length > 24 ? b.name.slice(0, 23) + '…' : b.name)}</text><text class="g-sub" x="40" y="${y + 12}">#${n} · ${esc(sess.coder === 'person' ? 'by hand' : sess.label)}</text>
        <path class="g-line" d="M${fx},${fromY} C${fx},${(fromY + y) / 2} ${fx + 4},${y} ${fx + 22},${y} L${commitsX[commitsX.length - 1]},${y}"/>
        <path class="g-open" d="M${commitsX[commitsX.length - 1]},${y} L${nowX - 8},${y}"/>
        ${commitsX.map(cx => `<circle class="g-commit" cx="${cx}" cy="${y}" r="3.8"/>`).join('')}
        <circle class="g-end" cx="${nowX}" cy="${y}" r="7"/>
        <text class="g-state" x="${nowX + 14}" y="${y + 1}">${esc(s.label.replace(/ · .*/, ''))}</text>${flag ? `<text class="g-flag" x="${nowX + 14}" y="${y + 13}">${esc(flag)}</text>` : ''}
      </a>`;
    });
    if (yOpen[76] != null && yOpen[77] != null) {
      const y76 = yOpen[76], y77 = yOpen[77], cx = nowX - 34;
      out += `<g class="g-wait"><path d="M${nowX - 9},${y77} C${nowX - 26},${y77} ${nowX - 26},${y76} ${nowX - 11},${y76 + 3}" marker-end="url(#g-arrow)"/></g>
        <g class="g-clash"><rect x="${cx - 46}" y="${Math.min(y76, y77) + 8}" width="14" height="${Math.abs(y77 - y76) - 16}" rx="4"/><title>#76 and #77 change the same lines in worker/src/index.ts</title></g>`;
    }
    /* merged but never deleted */
    left.forEach(([b, pr], j) => {
      const y = mainY + 40 + j * laneH, mi = idxOf(pr), mx = mi >= 0 ? X(mi) : L - 10, fx = mi >= 0 ? X(Math.max(0, mi - 2)) : L - 26;
      out += `<g class="g-left"><rect class="g-hit" x="0" y="${y - laneH / 2 + 3}" width="${W}" height="${laneH - 6}" rx="6"/>
        <text class="g-branch" x="40" y="${y - 1}">${esc(b.length > 24 ? b.slice(0, 23) + '…' : b)}</text><text class="g-sub" x="40" y="${y + 12}">merged in #${pr}</text>
        ${mi >= 0 ? `<path class="g-merged" d="M${fx},${mainY} C${fx},${(mainY + y) / 2} ${fx + 4},${y} ${fx + 18},${y} L${mx - 18},${y} C${mx - 4},${y} ${mx},${(mainY + y) / 2} ${mx},${mainY + 5}"/>` : `<path class="g-merged" d="M${L - 26},${y} L${L},${y}"/>`}
        <path class="g-stale" d="M${mi >= 0 ? mx : L},${y} L${nowX - 8},${y}"/>
        <circle class="g-end stale" cx="${nowX}" cy="${y}" r="6"/>
        <text class="g-state muted-t" x="${nowX + 14}" y="${y + 1}">Merged · not deleted</text></g>`;
    });
    return `<div class="graph-wrap${o.compact ? ' compact' : ''}"><svg class="graph" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="g-title-${o.compact ? 'c' : 'f'}">
      <title id="g-title-${o.compact ? 'c' : 'f'}">Branch map of choyiny/gitorange: main and every open branch${left.length ? ', plus merged branches that were never deleted' : ''}. The tables below list the same branches.</title>
      <defs><marker id="g-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="g-arrow"/></marker></defs>
      ${out}</svg></div>`;
  }
  GO.branchMap = (o) => branchMap(queue.filter(n => !state.landed.includes(n)), o || {});

  GO.registerView("branches", {
    title: "Branches", navAs: "project", skeleton: "graph",
    render(root) {
      const q = queue.filter(n => !state.landed.includes(n));
      const paused = state.mergingPaused;
      const rows = OPEN.filter(b => !state.landed.includes(b.n)).filter(b => !branchQuery || (b.name + ' ' + pull(b.n).title).toLowerCase().includes(branchQuery.toLowerCase()));
      if (branchSort === 'queue') rows.sort((a, b) => q.indexOf(a.n) - q.indexOf(b.n));
      if (branchSort === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
      if (branchSort === 'behind') rows.sort((a, b) => b.behind - a.behind);
      const agents = q.filter(n => SESSIONS[pull(n).session].coder !== 'person').length;
      const needs = q.filter(n => ['needs', 'asked'].includes(prState(n).st)).length;
      const leftover = LEFTOVER.filter(([b]) => !pruned.includes(b));
      root.innerHTML = `
        ${pageHead({ crumbs: [["GitOrange", "project"], ["Branches"]], title: "Branch map", tab: "branches", icon: "branch",
          lede: `${paused ? '<b>Merging is paused.</b> ' : 'main is healthy. '}${q.length} branches in flight: ${agents} by agents, ${q.length - agents} by a person. ${needs} need attention.${leftover.length ? ` ${leftover.length} merged branches were never deleted.` : ' Every merged branch has been deleted.'}`,
          actions: `${leftover.length ? `<button class="btn" type="button" id="prune-all">${icon('x')}Delete ${leftover.length} merged branches</button>` : ''}${paused ? '<button class="btn" type="button" data-resume-merging>Resume merging</button>' : `<button class="btn" type="button" id="pause-open" aria-expanded="${pausing}">${icon("pause")}Pause merging</button>`}` })}
        ${pausing && !paused ? `<form class="inline-form panel" id="pause-form"><label for="pause-why">Why pause merging on GitOrange?</label><input id="pause-why" value="Investigating the error spike before more changes merge" maxlength="120">
          <p class="muted small">Nothing merges until someone resumes. Agents keep working and pull requests keep their place in the queue. This is recorded in the audit log.</p>
          <div class="actions"><button class="btn primary" type="submit" id="pause-go">Pause merging</button><button class="btn quiet" type="button" id="pause-cancel">Cancel</button></div></form>` : ''}
        <section class="section map-section">
          <div class="section-head"><div class="map-key"><span><i class="lg-main"></i>main</span><span><i class="k-state good"></i>Queued</span><span><i class="k-state info"></i>Checking</span><span><i class="k-state warn"></i>Needs a person</span><span><i class="k-state serious"></i>Changes requested</span><span><i class="lg-stale"></i>Merged, not deleted</span><span><span class="mono-tile claude">C</span><span class="mono-tile codex">X</span>Agent</span><span><span class="mono-tile person">${icon("person")}</span>Person</span></div>
            <label class="inline-check small"><input type="checkbox" id="show-merged" ${showMerged ? 'checked' : ''}> Show merged branches</label></div>
          ${branchMap(q)}
        </section>
        <section class="section"><div class="main-card">
          <div><span class="eyebrow">main</span><b class="mono">${state.landed.length ? "5a90c13" : "54562fe"}</b><span class="muted small">Tip of main · #${state.landed.length ? 73 : 67}</span></div>
          <div><span class="eyebrow">Tests on main</span><b>${icon("check", "icon ok")}Passing</b><span class="muted small">7 of 7 modules</span></div>
          <div><span class="eyebrow">Protection</span><b>${icon("shield", "icon ok")}Rebase only, no direct pushes</b><a class="small" href="#rules">See rules</a></div>
          <div class="main-actions">${reverting ? `<span class="small">Revert the last merge? GitOrange opens a revert pull request, and it goes through the same reviews.</span><span class="actions"><button class="btn small danger" type="button" id="revert-go">Open revert</button><button class="btn small quiet" type="button" id="revert-cancel">Cancel</button></span>` : `<button class="btn small" type="button" id="revert-open">${icon("undo")}Revert last merge</button><a class="btn small quiet" href="#audit">Audit log</a>`}</div>
        </div></section>
        <section class="section"><div class="section-head"><h2>Merge queue</h2><span class="muted small">GitOrange merges from the top. Every merge first checks that main hasn’t moved.</span></div>
          <div class="table-wrap"><table class="table queue">
            <thead><tr><th>#</th><th>Pull request</th><th>Made by</th><th>Blocked by</th><th>Estimate</th><th><span class="sr">Actions</span></th></tr></thead>
            <tbody>${q.map((n, i) => { const p = pull(n), s = prState(n); return `<tr class="${p.held ? "is-held" : ""}">
              <td class="mono">${i + 1}</td>
              <td><a href="#pull-${n}"><span class="mono muted">#${n}</span> ${esc(p.title)}</a><div>${chip(s.st, s.label)}</div></td>
              <td>${coderLink(p.session)}</td><td class="small">${esc(blocker(n))}</td><td class="mono nowrap">${p.held || paused ? "—" : esc(eta(n))}</td>
              <td class="row-actions">${i > 0 ? `<button class="btn small quiet" type="button" data-move="${n}" ${n === 77 || n === 73 ? 'disabled title="It depends on the pull request above it"' : ""}>${icon("up")}Move up</button>` : ""}<button class="btn small quiet" type="button" data-hold="${n}">${p.held ? "Release" : "Hold"}</button></td></tr>`; }).join("")}</tbody>
          </table></div>
          ${movePreview ? `<div class="preview panel">${icon("arrow")}<span>${movePreview.text}</span><button class="btn small primary" type="button" id="move-confirm">Move #${movePreview.n} up</button><button class="btn small quiet" type="button" id="move-cancel">Cancel</button></div>` : ""}
        </section>
        <section class="section"><div class="section-head"><h2>All branches</h2>
          <span class="filters"><label class="sr" for="b-search">Search branches</label><input id="b-search" type="search" placeholder="Search branches" value="${esc(branchQuery)}">
          <label class="sr" for="b-sort">Sort</label><select id="b-sort"><option value="queue" ${branchSort === "queue" ? "selected" : ""}>Queue order</option><option value="name" ${branchSort === "name" ? "selected" : ""}>Name</option><option value="behind" ${branchSort === "behind" ? "selected" : ""}>Most behind</option></select></span></div>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Branch</th><th>Made by</th><th>Pull request</th><th>State</th><th>Ahead / behind</th><th><span class="sr">Actions</span></th></tr></thead>
            <tbody>${rows.map(b => { const p = pull(b.n), s = prState(b.n); return `<tr><td class="mono nowrap">${esc(b.name)}</td><td>${coderLink(p.session)}</td><td><a href="#pull-${b.n}"><span class="mono muted">#${b.n}</span> ${esc(p.title)}</a></td><td>${chip(s.st, s.label)}</td><td class="mono">${b.ahead} / ${b.behind}</td><td class="row-actions"><a class="btn small quiet" href="#pull-${b.n}">Compare</a><button class="btn small quiet" type="button" data-hold="${b.n}">${p.held ? "Release" : "Hold"}</button></td></tr>`; }).join("")}
            ${leftover.filter(([b]) => !branchQuery || b.includes(branchQuery)).map(([b, pr]) => `<tr class="is-stale"><td class="mono nowrap">${esc(b)}</td><td><span class="coder"><span class="mono-tile person">${icon("person")}</span><span>Cho</span></span></td><td><span class="mono muted">#${pr}</span> merged</td><td>${chip("off", "Merged · not deleted")}</td><td class="mono">0 / —</td><td class="row-actions"><button class="btn small quiet" type="button" data-prune="${esc(b)}">${icon("x")}Delete</button></td></tr>`).join("")}</tbody>
          </table></div></section>
        <section class="section"><div class="section-head"><h2>Clean-up policy</h2></div>
          <div class="panel cleanup">
            <p>${icon("check", "icon ok")}From now on, branches are deleted when they merge, unless another open pull request builds on them.</p>
            <form class="stale-form" id="stale-form"><label for="stale-days">Archive branches with no pull request and no activity after</label><select id="stale-days">${["7", "14", "21", "30", "60"].map(d => `<option ${d === staleDays ? "selected" : ""}>${d}</option>`).join("")}</select><span>days</span><button class="btn small" type="submit" id="stale-save">Save</button></form>
          </div></section>`;
    }
  });
  document.addEventListener('change', e => { if (e.target.id === 'show-merged') { showMerged = e.target.checked; GO.rerender(); } });
  document.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.prune) { const b = t.dataset.prune; await GO.pending(t, 'Deleting…', 450); pruned.push(b); GO.audit('setting', `Deleted merged branch ${b}`, { by: 'Mahmoud' }); GO.rerender(); GO.toast(`Deleted ${b}`, { undo: () => { pruned = pruned.filter(x => x !== b); GO.rerender(); } }); return; }
    if (t.id === 'prune-all') { const list = LEFTOVER.map(x => x[0]).filter(b => !pruned.includes(b)); await GO.pending(t, `Deleting ${list.length} branches…`, 900); pruned = pruned.concat(list); GO.audit('setting', `Deleted ${list.length} merged branches`, { by: 'Mahmoud' }); GO.rerender(); GO.toast(`Deleted ${list.length} merged branches`, { undo: () => { pruned = pruned.filter(x => !list.includes(x)); GO.rerender(); } }); }
  });

  /* =====================================================================
   * RULES tab
   * ===================================================================== */
  GO.registerView("rules", {
    title: "Rules",
    navAs: "project",
    skeleton: "list",
    render(root) {
      const rule = (name, setting, by) =>
        `<tr><th scope="row">${esc(name)}</th><td>${setting}</td><td class="muted small">${esc(by)}</td></tr>`;
      root.innerHTML = `
        ${pageHead({ crumbs: [["GitOrange", "project"], ["Rules"]], title: "Rules for main", lede: "How changes reach main. Changing a rule needs a second admin and is recorded in the audit log.", tab: "rules" })}
        <section class="section"><div class="section-head"><h2>Merging</h2></div><div class="table-wrap"><table class="table">
          <thead><tr><th>Rule</th><th>Setting</th><th>Enforced by</th></tr></thead><tbody>
          ${rule("Who can merge", "Only GitOrange, through auto-merge or the merge button", "GitOrange")}
          ${rule("Direct pushes to main", chip("blocked", "Blocked for everyone"), "Git endpoint")}
          ${rule("Force pushes", chip("blocked", "Blocked"), "Git endpoint")}
          ${rule("Merge method", "Rebase onto the tip of main, then compare-and-swap. The merge fails if main moved.", "GitOrange")}
          ${rule("Required checks", "The test modules Clef selects for the change. Pushes to main run all 7.", "Actions")}
          ${rule("Stale approvals", "Dismissed when new commits arrive", "GitOrange")}
          ${rule("Pausing", "Any site admin can pause merging. Every pause and resume is logged.", "GitOrange")}
          ${rule("Bypass", "No one can bypass these rules", "GitOrange")}
          </tbody></table></div></section>
        <section class="section"><div class="section-head"><h2>Required reviewers</h2><span class="muted small">Clef wakes a reviewer when it’s at least this sure a change concerns it</span></div><div class="table-wrap"><table class="table">
          <thead><tr><th>Area</th><th>Reviewer</th><th>Wakes at</th><th>Approval</th></tr></thead><tbody>
          ${[
            [
              "Sign-in, tokens, permissions, secrets",
              "security",
              "A person, with a reason. Never in bulk.",
            ],
            [
              "Schema, migrations, stored data",
              "data",
              "A person, with a reason. Never in bulk.",
            ],
            [
              "Pages, routes, API fields, agent tools",
              "features",
              "The reviewer, or a person when it asks",
            ],
            [
              "Deploy steps, bindings, secrets",
              "shipping",
              "The reviewer, or Claude for Mahmoud",
            ],
          ]
            .map(
              ([area, id, appr]) =>
                `<tr><th scope="row">${esc(area)}</th><td>${dot(id)}</td><td class="mono">${pct(AGENTS[id].above)}</td><td class="small">${esc(appr)}</td></tr>`,
            )
            .join("")}
          </tbody></table></div></section>
        <section class="section"><div class="section-head"><h2>Rules reviewers learn</h2></div>
          <div class="panel pad"><p>When a person dismisses a reviewer’s request, the reviewer proposes a rule in its own repository. Features and Shipping rules apply at once. <b>Data and Security rules need a second person to confirm.</b> Every rule can be reverted.</p></div></section>`;
    },
  });

  /* =====================================================================
   * AUDIT LOG tab
   * ===================================================================== */
  let auditFilter = "all";
  GO.registerView("audit", {
    title: "Audit log",
    navAs: "project",
    skeleton: "list",
    render(root) {
      const session = state.audit.map((e) => ({
        at: e.at,
        kind:
          e.kind === "merge"
            ? "merge"
            : e.kind === "approval"
              ? "approval"
              : "setting",
        html: esc(e.text),
        by: e.by || "Mahmoud",
        approved: e.approved || "",
        cas: e.cas || "",
      }));
      const seed = MERGES.map((m) => ({
        at: m[0],
        kind: "merge",
        html: `Merged <span class="mono">#${m[1]}</span> ${esc(m[2])}`,
        by: m[3],
        approved: m[4],
        cas: `${m[5]} → ${m[6]}`,
      }))
        .concat([
          {
            at: "09:58",
            kind: "setting",
            html: 'Rule saved in <span class="mono">dataagent/dataagent</span> at <span class="mono">d47ef24</span>',
            by: "Data, from Mahmoud’s dismissal on #67",
            approved: "Confirmed by Cho",
            cas: "",
          },
          {
            at: "09:58",
            kind: "setting",
            html: 'Rule saved in <span class="mono">featureagent/featureagent</span> at <span class="mono">39851a5</span>',
            by: "Features, from Mahmoud’s dismissal on #67",
            approved: "Applies at once",
            cas: "",
          },
        ])
        .sort((a, b) => b.at.localeCompare(a.at));
      const all = session
        .concat(seed)
        .filter((e) => auditFilter === "all" || e.kind === auditFilter);
      const f = [
        ["all", "All"],
        ["merge", "Merges"],
        ["approval", "Approvals"],
        ["setting", "Rules and settings"],
      ];
      root.innerHTML = `
        ${pageHead({ crumbs: [["GitOrange", "project"], ["Audit log"]], title: "Audit log", lede: "Every merge and every change to how GitOrange decides, newest first. Entries can’t be edited or deleted.", tab: "audit" })}
        <div class="filters" role="group" aria-label="Filter">${f.map(([id, l]) => `<button class="pill" type="button" data-afilter="${id}" aria-pressed="${auditFilter === id}">${l}</button>`).join("")}</div>
        <div class="table-wrap"><table class="table audit">
          <thead><tr><th>Time</th><th>Event</th><th>By</th><th>Approved by</th><th>main before → after</th></tr></thead>
          <tbody>${all.map((e) => `<tr><td class="mono">${esc(e.at)}</td><td>${e.html}</td><td class="small">${esc(e.by)}</td><td class="small">${esc(e.approved) || '<span class="muted">—</span>'}</td><td class="mono nowrap small">${esc(e.cas) || '<span class="muted">—</span>'}</td></tr>`).join("")}</tbody>
        </table></div>`;
    },
  });

  /* =====================================================================
   * AGENTS (global)
   * ===================================================================== */
  const draft = {
    name: "Accessibility",
    watch:
      "pages that people using a screen reader or only a keyboard can’t use",
    act: "ask",
    above: 35,
    paths: "src/**",
    dry: false,
    made: false,
  };
  const handleOf = (n) =>
    (n || "reviewer").toLowerCase().replace(/[^a-z0-9]/g, "") || "reviewer";
  const wakeQuestion = (w) => {
    w = String(w || "")
      .trim()
      .replace(/[.?]+$/, "");
    return w
      ? `Could this change create ${w.charAt(0).toLowerCase() + w.slice(1)}?`
      : "Describe what it should watch for.";
  };
  /* Agents directory: a profile card per agent. #agents-new opens the reviewer maker. */
  function agentStats(id) {
    const a = AGENTS[id], t = a.track || {};
    if (a.group === 'flow') return id === 'clef' ? [['67', 'changes routed'], ['~40 ms', 'per decision'], ['291', 'test runs picked']] : [['54', 'attempts'], ['9', 'combined'], ['13 of 13', 'merged anyway']];
    if (!t.raised) return [['—', 'raised'], ['—', 'kept'], ['0', 'rules']];
    return [[String(t.raised), 'raised'], [pct((t.raised - t.setAside) / t.raised), 'kept'], [String(t.rules + (id === 'data' && state.taught ? 1 : 0)), t.rules === 1 ? 'rule' : 'rules']];
  }
  function agentCard(id) {
    const a = AGENTS[id], g = crewStates();
    const st = a.group === 'review' && !onCrew(id) ? 'off' : g[id] || 'idle';
    const where = a.group === 'flow' ? 'Built in · every repository' : state.reviewerOff[id] ? 'Turned off on GitOrange' : onCrew(id) ? 'Reviews choyiny/gitorange' : 'Not on a repository yet';
    return `<a class="acard" href="#agent-${id}" style="--agent:${a.color}">
      <span class="acard-band"></span>
      <span class="acard-ava">${avatar(id, 72, st)}</span>
      <span class="acard-body">
        <span class="acard-name">${esc(a.name)}${a.group === 'flow' ? '' : ' Agent'}</span>
        <span class="mono muted small">${esc(a.handle)}</span>
        <span class="acard-bio">${esc(a.job)}</span>
        <span class="acard-stats">${agentStats(id).map(([v, l]) => `<span><b>${esc(v)}</b> ${esc(l)}</span>`).join('')}</span>
        <span class="acard-foot">${chip(st)}<span class="muted small">${esc(where)}</span></span>
      </span>
    </a>`;
  }
  const agentsView = {
    title: p => (p === 'new' ? 'New reviewer' : 'Agents'), navAs: 'agents', skeleton: 'list',
    render(root, param) {
      if (param === 'new') return renderMaker(root);
      const flow = Object.keys(AGENTS).filter(id => AGENTS[id].group === 'flow');
      const review = Object.keys(AGENTS).filter(id => AGENTS[id].group === 'review');
      const on = review.filter(onCrew), off = review.filter(id => !onCrew(id));
      root.innerHTML = `
        ${pageHead({ crumbs: [['Agents']], title: 'Agents', icon: 'crew', lede: 'Each agent is an account with its own profile and its own repository of instructions. Reviewers check every change for one area; built-in agents keep changes moving.', actions: `<a class="btn primary" href="#agents-new">${icon('plus')}New reviewer</a>` })}
        <section class="section"><div class="section-head"><h2>Reviewing your code</h2><span class="muted small">${on.length} on choyiny/gitorange</span></div><div class="agrid">${on.map(agentCard).join('')}</div></section>
        <section class="section"><div class="section-head"><h2>Built in</h2></div><div class="agrid">${flow.map(agentCard).join('')}</div></section>
        ${off.length ? `<section class="section"><div class="section-head"><h2>Available</h2><span class="muted small">Add them to a repository from their profile</span></div><div class="agrid">${off.map(agentCard).join('')}</div></section>` : ''}`;
    }
  };
  function renderMaker(root) {
    const h = handleOf(draft.name);
    root.innerHTML = `
      ${pageHead({ crumbs: [['Agents', 'agents'], ['New reviewer']], title: 'Create a reviewer', icon: 'plus', lede: 'A reviewer is an account with its own repository of instructions. Clef wakes it when a change concerns it.' })}
      <div class="maker panel">
        <form class="form" id="maker" autocomplete="off">
          <label for="mk-name">Name</label><input id="mk-name" value="${esc(draft.name)}" maxlength="24">
          <label for="mk-watch">What it reviews</label><textarea id="mk-watch" rows="2">${esc(draft.watch)}</textarea>
          <div class="q"><span class="eyebrow">Clef asks before waking it</span><p id="mk-q">${esc(wakeQuestion(draft.watch))}</p></div>
          <label for="mk-above">Wake when Clef is at least <b id="mk-above-out">${draft.above}%</b> sure</label><input type="range" id="mk-above" min="5" max="95" value="${draft.above}">
          <fieldset class="radios"><legend>When it finds a problem</legend>${[['block', 'Block the merge'], ['ask', 'Ask a person'], ['comment', 'Comment only']].map(([v, l]) => `<label><input type="radio" name="mk-act" value="${v}" ${draft.act === v ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>
          <label for="mk-paths">Only for these paths</label><input id="mk-paths" class="mono" value="${esc(draft.paths)}">
          <div class="actions"><button class="btn" type="button" id="mk-dry">${icon('play')}Dry run on the last 20 changes</button><button class="btn primary" type="submit" id="mk-create">Create reviewer</button></div>
        </form>
        <div class="maker-side">
          <div class="maker-id"><span class="ava" style="--agent:#2a78d6"><agent-robot-avatar id="mk-avatar" size="72" color="#2a78d6" auto-sleep="0" wake-on="manual" data-round="55" data-state="idle" style="--s:72px;--c:#2a78d6" aria-hidden="true"></agent-robot-avatar></span><span><b id="mk-title">${esc(draft.name)}</b><br><span class="mono muted small" id="mk-handle">@${h}agent</span></span></div>
          <p class="muted small">Its instructions start in <span class="mono">${h}agent/${h}agent</span>. Changes to them are pull requests like any other.</p>
          <div class="dry" id="mk-dry-out" ${draft.dry ? '' : 'hidden'}><p><b>Would have raised 3 of the last 20 changes</b></p><ul><li><span class="mono">#63</span> The date picker can’t be opened with the keyboard.</li><li><span class="mono">#59</span> The Approve button has no label for screen readers.</li><li><span class="mono">#52</span> Grey text on Insights is below 4.5:1 contrast.</li></ul></div>
          <p class="made" id="mk-made" ${draft.made ? '' : 'hidden'}>${icon('check', 'icon ok')}Created <span class="mono">@${h}agent</span>. Add it to a repository to start.</p>
        </div>
      </div>`;
  }
  GO.registerView("agents", agentsView);
  GO.registerView("crew", agentsView);


  /* =====================================================================
   * AGENT page
   * ===================================================================== */
  const agentDraft = {}; // unsaved edits survive re-renders
  let turningOff = null;
  function seeded(seed) {
    let s = seed;
    return () => (s = (s * 16807) % 2147483647) / 2147483647;
  }
  function calibration(id, above) {
    const rnd = seeded(
      id.split("").reduce((a, c) => a + c.charCodeAt(0), 7) * 97,
    );
    return Array.from({ length: 50 }, (_, i) => {
      const p = Math.pow(rnd(), 1.6),
        r = rnd();
      const outcome =
        p < above
          ? r < 0.04
            ? "missed"
            : "skipped"
          : p > 0.75
            ? r < 0.75
              ? "kept"
              : r < 0.9
                ? "nothing"
                : "aside"
            : r < 0.35
              ? "kept"
              : r < 0.85
                ? "nothing"
                : "aside";
      return { p, outcome, n: 30 + i };
    });
  }
  function calibrationStrip(id, above) {
    const a = AGENTS[id],
      pts = calibration(id, a.above || 0.3);
    const W = 420,
      H = 66,
      x = (p) => 12 + p * (W - 24);
    const woke = pts.filter((q) => q.p >= above).length,
      missed = pts.filter(
        (q) => q.p < above && (q.outcome === "kept" || q.outcome === "missed"),
      ).length;
    const label = {
      kept: "raised something a person kept",
      nothing: "found nothing",
      aside: "raised something a person dismissed",
      skipped: "not woken",
      missed: "not woken; a person later found a problem",
    };
    const marks = pts
      .map((q, i) => {
        const cx = x(q.p).toFixed(1),
          cy = (12 + (i % 4) * 9).toFixed(1),
          t = `<title>#${q.n}: Clef ${pct(q.p)} sure, ${label[q.outcome]}</title>`;
        if (q.outcome === "kept")
          return `<circle cx="${cx}" cy="${cy}" r="4" class="c-kept">${t}</circle>`;
        if (q.outcome === "nothing")
          return `<circle cx="${cx}" cy="${cy}" r="3.5" class="c-nothing">${t}</circle>`;
        if (q.outcome === "aside")
          return `<g class="c-aside">${t}<path d="M${cx - 3.5} ${cy - 3.5}l7 7M${+cx + 3.5} ${cy - 3.5}l-7 7"/></g>`;
        if (q.outcome === "missed")
          return `<circle cx="${cx}" cy="${cy}" r="4" class="c-missed">${t}</circle>`;
        return `<circle cx="${cx}" cy="${cy}" r="2.5" class="c-skipped">${t}</circle>`;
      })
      .join("");
    return `<svg class="cal" viewBox="0 0 ${W} ${H}" role="img" aria-label="Last 50 changes placed by how sure Clef was">
        <line x1="12" x2="${W - 12}" y1="50" y2="50" class="c-axis"/>${[0, 0.25, 0.5, 0.75, 1].map((t) => `<text x="${x(t)}" y="63" class="c-tick" text-anchor="middle">${t * 100}%</text>`).join("")}
        <rect x="${x(above)}" y="2" width="${(W - 12 - x(above)).toFixed(1)}" height="48" class="c-zone"/><line x1="${x(above)}" x2="${x(above)}" y1="2" y2="52" class="c-threshold"/>${marks}</svg>
      <p class="small">At ${pct(above)}, ${esc(a.name)} wakes on <b>${woke}</b> of the last 50 changes and would have missed <b>${missed}</b> that a person later flagged.</p>
      <div class="cal-legend"><span><i class="k-kept"></i>Raised, kept</span><span><i class="k-nothing"></i>Found nothing</span><span><i class="k-aside">×</i>Dismissed</span><span><i class="k-missed"></i>Missed</span><span><i class="k-skipped"></i>Not woken</span></div>`;
  }
  const GUARDED = ["security", "data"];
  /* Agent profile: GitHub-style. A portrait sidebar, then Overview (its AGENT.md as a profile README, record,
   * activity), Reviews, Rules learned and Configuration. */
  let profileTab = 'overview', profileOf = null;
  const JOINED = { clef: 'Oct 1', fixer: 'Oct 3' };
  function activityGrid(id) {
    /* 5 weeks ending Thu 8 Oct, one column per week (Sun to Sat). Reviewer agents joined on Mon 5 Oct. */
    const a = AGENTS[id], joined = a.group === 'flow' ? (id === 'clef' ? 1 : 3) : 5, end = 8;
    const weekly = a.group === 'flow' ? (id === 'clef' ? 67 : 54) : Math.max(2, (a.track && a.track.raised) || 2) * 2;
    const rnd = seeded(id.length * 131 + 7);
    const days = [];
    for (let d = -26; d <= 10; d++) {
      const inOct = d >= 1, date = d;
      let n = null;
      if (date > end) n = undefined; else if (!inOct || date < joined) n = null; else n = Math.round((weekly / Math.max(1, end - joined + 1)) * (0.4 + rnd() * 1.2));
      days.push({ d, n });
    }
    const max = Math.max(1, ...days.map(x => x.n || 0));
    const lvl = n => (n == null ? -1 : n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
    const start = days.findIndex(x => x.d === -26);
    const cols = [];
    for (let w = 0; w < 6; w++) cols.push(days.slice(start + w * 7, start + w * 7 + 7));
    const label = x => (x.d >= 1 ? `Oct ${x.d}` : `Sep ${30 + x.d}`);
    return `<div class="actgrid" role="img" aria-label="${esc(a.name)}: activity by day, last five weeks">${cols.map(c => `<span class="actcol">${c.map(x => x.n === undefined ? '<i class="act none"></i>' : `<i class="act l${lvl(x.n)}" title="${label(x)}: ${x.n == null ? 'not created yet' : `${x.n} review${x.n === 1 ? '' : 's'}`}"></i>`).join('')}</span>`).join('')}</div>
      <div class="actlegend small muted"><span>Joined ${esc(JOINED[id] || 'Oct 5')}</span><span class="grow"></span>Less<i class="act l0"></i><i class="act l1"></i><i class="act l2"></i><i class="act l3"></i><i class="act l4"></i>More</div>`;
  }
  function reviewsOf(id) {
    const rows = [];
    Object.keys(PULLS).map(Number).forEach(n => {
      const p = pull(n), c = p.crew[id];
      if (c && c[0] !== 'skipped') rows.push({ href: `#pull-${n}`, title: `#${n} ${p.title}`, st: c[0], note: `Woken at ${pct(c[1])}`, when: p.inState + ' ago' });
      else if (p.skipped && p.skipped[id] != null) rows.push({ href: `#pull-${n}`, title: `#${n} ${p.title}`, st: 'skipped', note: `Not needed: ${pct(p.skipped[id])} is below ${pct(AGENTS[id].above || 0)}`, when: p.inState + ' ago' });
    });
    const extra = { features: [['#finding-79', '#79 Reports: replace CSV export', 'needs', 'Asked a person: was removing CSV export intended?', '25 min ago']], security: [['#finding-80', '#80 Share project files by link', 'needs', 'Asked a person: private files without sign-in', '12 min ago']], shipping: [['#finding-ship72', '#72 Deploy step', 'needs', 'Run migration 0043 before deploying', '3 h ago']] }[id] || [];
    extra.forEach(([href, title, st, note, when]) => rows.unshift({ href, title, st, note, when }));
    (AGENTS[id].lessons || []).forEach(l => rows.push({ href: `#agent-${id}`, title: `#${l.pr} (merged)`, st: 'learned', note: `Dismissed by Mahmoud. Saved a rule: ${l.plain}`, when: 'today' }));
    if (id === 'fixer') rows.push({ href: '#pull-77', title: '#77 Log every sign-in attempt', st: 'asked', note: 'Couldn’t combine with #76. Handed back with both intents.', when: '15 min ago' });
    if (id === 'clef') rows.push({ href: '#live', title: '#76 and #77', st: 'clear', note: 'Same lines in worker/src/index.ts. Put #77 after #76.', when: '22 min ago' });
    return rows;
  }
  GO.registerView("agent", {
    title: (p) => (AGENTS[p] ? AGENTS[p].name : "Agent"), navAs: "agents", skeleton: "detail",
    render(root, id) {
      const a = AGENTS[id];
      if (!a) { root.innerHTML = pageHead({ crumbs: [['Agents', 'agents'], ['Not found']], title: 'Agent not found', lede: '<a href="#agents">Back to Agents</a>' }); return; }
      if (profileOf !== id) { profileOf = id; profileTab = 'overview'; }
      pageHead({ crumbs: [['Agents', 'agents'], [a.name]], title: a.name, icon: 'crew' });
      const isReviewer = a.group === 'review', g = crewStates(), st = isReviewer && !onCrew(id) ? 'off' : g[id], t = a.track || {};
      const dr = agentDraft[id] || (agentDraft[id] = { wake: a.wake, above: a.above, proposed: false });
      const lessons = (a.lessons || []).concat(id === 'data' && state.taught ? [{ pr: 72, rule: 'Old invoices default to Canadian dollars for this business. Don’t ask about currency backfills.', plain: 'Old invoices are always in Canadian dollars, so don’t ask.', sha: 'b7e21c9', pending: true }] : []);
      const off = state.reviewerOff[id];
      let control = '';
      if (isReviewer && GUARDED.includes(id)) {
        if (off) control = `<div class="pf-control guard"><b>${esc(a.name)} reviews are off for GitOrange</b><p class="small muted">Turned off by ${esc(off.by)} at ${esc(off.at)}: ${esc(off.reason)}</p><button class="btn primary" type="button" id="guard-on" data-agent="${id}">Turn back on</button></div>`;
        else if (turningOff === id) control = `<form class="pf-control guard" id="guard-form" data-agent="${id}"><b>Turn off ${esc(a.name)} for GitOrange?</b>
          <p class="small">Changes to ${id === 'security' ? 'sign-in, tokens and permissions' : 'the schema and stored data'} would merge without a ${esc(a.name.toLowerCase())} review. Everyone sees a banner until it’s back on.</p>
          <label for="guard-why">Reason (required)</label><input id="guard-why" required placeholder="For example: replacing it with a stricter reviewer">
          <div class="actions"><button class="btn danger" type="submit" id="guard-go">Turn off</button><button class="btn quiet" type="button" id="guard-cancel">Cancel</button></div></form>`;
        else control = onCrew(id) ? `<div class="pf-control"><span class="small">${icon('check', 'icon ok')} Reviews choyiny/gitorange</span><button class="btn small" type="button" id="guard-open" data-agent="${id}">Turn off…</button></div>` : `<div class="pf-control"><button class="btn primary" type="button" data-add="${id}">${icon('plus')}Add to GitOrange</button></div>`;
      } else if (isReviewer) {
        control = `<label class="switch pf-control"><span><b>Reviews GitOrange</b><br><span class="muted small">${a.recommend && !onCrew(id) ? `${esc(a.recommend.level)}. ${esc(a.recommend.text)}` : 'Reviews every change it’s relevant to.'}</span></span><input type="checkbox" id="crew-toggle" data-agent="${id}" ${onCrew(id) ? 'checked' : ''}></label>`;
      }
      const repoName = a.repo || '';
      const readme = repoName && GO.repoKit ? GO.repoKit.agentRepo(GO.REPOS.find(r => r.name === repoName) || { agent: id, name: repoName }).files['AGENT.md'].replace(/^---[\s\S]*?---\n/, '') : null;
      const tabs = [['overview', 'Overview'], ['reviews', 'Reviews'], ...(isReviewer ? [['rules', `Rules learned`]] : []), ['config', 'Configuration']];
      let body = '';
      if (profileTab === 'overview') body = `
        ${readme ? `<section class="pf-readme panel"><div class="readme-head">${icon('book')}<span class="mono small">${esc(repoName)} / <b>AGENT.md</b></span><span class="grow"></span><a class="btn small quiet" href="#repo-${repoName.replace('/', '~')}">Open repository</a></div><div class="md">${GO.repoKit.markdown(readme)}</div></section>` : `<section class="pf-readme panel"><div class="md"><h3 class="md-h">${esc(a.name)}</h3><p>${esc(a.job)}</p><ul>${a.looks.map(l => `<li>${esc(l)}</li>`).join('')}</ul><p class="muted">Built into GitOrange. It has no instruction repository.</p></div></section>`}
        <section class="section"><div class="section-head"><h2>Record this week</h2></div><div class="stats">${agentStats(id).map(([v, l]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join('')}</div>
          ${a.best ? `<p class="callout">${icon('star')}<span><b>Best catch.</b> ${esc(a.best)}</span></p>` : ''}</section>
        <section class="section"><div class="section-head"><h2>Activity</h2><span class="muted small">Reviews per day. Split across days is an example; the weekly total is real.</span></div><div class="panel pad">${activityGrid(id)}</div></section>
        ${a.checklist ? `<section class="section"><h2>Checked on every change</h2><ul class="ticks">${a.checklist.map(c => `<li>${icon('check', 'icon ok')}${esc(c)}</li>`).join('')}</ul><p class="muted small">${esc(a.limit)}</p></section>` : ''}`;
      if (profileTab === 'reviews') body = `<ul class="list revlist">${reviewsOf(id).map(r => `<li>${chip(r.st)}<span><a href="${r.href}"><b>${esc(r.title)}</b></a><br><span class="muted small">${esc(r.note)}</span></span><span class="when">${esc(r.when)}</span></li>`).join('') || '<li class="muted">No reviews yet.</li>'}</ul>`;
      if (profileTab === 'rules') body = lessons.length ? lessons.map(l => `<div class="lesson panel"><p><b>${esc(l.plain)}</b></p><div class="diff"><div class="diff-path mono">${esc(a.repo)} · AGENT.md · ${esc(l.sha)} · from #${l.pr}${l.pending ? ' · waiting for Cho to confirm' : ''}</div><div class="diff-add mono">+ ${esc(l.rule)}</div></div><button class="btn small quiet" type="button" data-revert>${icon('undo')}Revert</button></div>`).join('') : '<div class="panel pad"><p class="muted">None yet. When a person dismisses one of its requests, it proposes a rule in its own repository.</p></div>';
      if (profileTab === 'config') body = `<section class="panel pad config"><h2>${icon('sliders')}How it wakes</h2>
          ${a.repo ? `<p class="muted small">Instructions in <a class="mono" href="#repo-${a.repo.replace('/', '~')}">${esc(a.repo)}</a>. One reasoning-model pass per review, about $0.004 each.</p>` : '<p class="muted small">Built into GitOrange.</p>'}
          ${a.above ? `<label for="wake-q">Clef asks this about every change</label><textarea id="wake-q" rows="4" data-agent="${id}">${esc(dr.wake)}</textarea>
            <label for="wake-t">Wake when Clef is at least <b id="wake-t-out">${pct(dr.above)}</b> sure</label><input type="range" id="wake-t" min="5" max="95" value="${Math.round(dr.above * 100)}" data-agent="${id}">
            <div id="cal-wrap">${calibrationStrip(id, dr.above)}</div>
            ${dr.proposed ? `<p class="saved small">${icon('check', 'icon ok')}Opened <span class="mono">#12</span> on <span class="mono">${esc(a.repo)}</span>. Nothing changes until it merges.</p>` : `<div class="actions"><button class="btn small" type="button" id="save-agent" data-agent="${id}">Propose this change</button></div>`}` : `<p>${esc(a.wake)}</p>`}
        </section>`;
      root.innerHTML = `
        <div class="profile" style="--agent:${a.color}">
          <aside class="pf-side">
            <div class="pf-portrait">${avatar(id, 168, st)}</div>
            <h2 class="pf-name">${esc(a.name)}${a.group === 'flow' ? '' : ' Agent'}</h2>
            <p class="pf-handle mono">${esc(a.handle)}</p>
            <p class="pf-badges"><span class="chip">${icon('crew')}${a.group === 'flow' ? 'Built-in agent' : 'Reviewer agent'}</span>${chip(st)}</p>
            <p class="pf-bio">${esc(a.job)}</p>
            ${control}
            <ul class="pf-meta">
              ${a.repo ? `<li>${icon('repo')}<a class="mono" href="#repo-${a.repo.replace('/', '~')}">${esc(a.repo)}</a></li>` : ''}
              ${a.above ? `<li>${icon('gauge')}Wakes when Clef is ${pct(a.above)} sure</li>` : `<li>${icon('gauge')}${esc(a.wake)}</li>`}
              <li>${icon('spark')}${a.group === 'flow' ? (id === 'clef' ? 'Cloudflare’s Clef decision model' : 'Pi agent in a sandboxed workspace') : 'One reasoning-model pass'}</li>
              <li>${icon('clock')}Joined ${esc(JOINED[id] || 'Oct 5')}</li>
              ${a.example ? `<li>${icon('alert')}Example agent in this mockup</li>` : ''}
            </ul>
          </aside>
          <div class="pf-main">
            <nav class="subtabs" role="tablist">${tabs.map(([tid, l]) => `<button type="button" role="tab" data-ptab="${tid}" aria-selected="${profileTab === tid}">${esc(l)}${tid === 'rules' && lessons.length ? ` <span class="count">${lessons.length}</span>` : ''}${tid === 'reviews' ? ` <span class="count">${reviewsOf(id).length}</span>` : ''}</button>`).join('')}</nav>
            ${body}
          </div>
        </div>`;
    }
  });
  document.addEventListener('click', e => { const t = e.target.closest('[data-ptab]'); if (!t) return; profileTab = t.dataset.ptab; GO.rerender(); });

  /* =====================================================================
   * PULL REQUEST page
   * ===================================================================== */
  let rerunTries = 0;
  function diffBlock(n) {
    const d = DIFFS[n];
    if (!d) return "";
    const body = d.lines
      .map(
        ([k, step, text]) =>
          `<tr class="d-${k}"><td class="d-step mono">${esc(step)}</td><td class="d-sign mono">${k === "add" ? "+" : k === "del" ? "−" : ""}</td><td class="d-code mono">${esc(text)}</td></tr>`,
      )
      .join("");
    const fixer = d.fixer
      ? `<div class="diff-card"><div class="diff-head mono">Fixer’s attempt · ${esc(d.file)}</div><pre class="code mono">${d.fixer.map((l) => (/^(<{7}|={7}|>{7})/.test(l) ? `<span class="conflict">${esc(l)}</span>` : esc(l))).join("\n")}</pre><p class="small muted pad-x">Both changes wrap the same line. Fixer won’t pick an order for security code on its own, so it handed the change back with both intents.</p></div>`
      : "";
    return `<div class="diff-card" id="diff"><div class="diff-head"><span class="mono">${esc(d.file)}</span><span class="muted small">The left column shows the session step that wrote each line</span></div><div class="table-wrap flush"><table class="dtable">${body}</table></div></div>${fixer}`;
  }
  GO.registerView("pull", {
    title: (n) => `#${n}`,
    navAs: "project",
    skeleton: "detail",
    render(root, param) {
      const n = Number(param);
      if (!PULLS[n]) {
        root.innerHTML = pageHead({
          crumbs: [
            ["GitOrange", "project"],
            ["Pull requests", "pulls"],
            ["Not found"],
          ],
          title: "Pull request not found",
          lede: '<a href="#pulls">Back to pull requests</a>',
        });
        return;
      }
      const p = pull(n),
        s = SESSIONS[p.session],
        r = REQUESTS[p.req],
        b = OPEN.find((x) => x.n === n),
        st = prState(n);
      const woke = Object.entries(p.crew).filter(([, v]) => v[0] !== "skipped");
      const merged = state.landed.includes(n);
      const next = merged
        ? "Merged onto main. The branch was deleted."
        : n === 72 && state.decision === "pending"
          ? "Data needs Mahmoud to confirm that existing invoices were all in Canadian dollars."
          : blocker(n);
      const relation = p.stackedOn
        ? `#${n} must account for #${p.stackedOn}: both change invoice currency, so it merges right after it.`
        : p.after
          ? `#${n} waits on #${p.after}: both change the request handler in worker/src/index.ts.`
          : n === 76
            ? "#77 waits on this one. It merges first because it was opened first."
            : n === 72
              ? "#73 is stacked on this one and merges right after it."
              : "";
      const target =
        p.stackedOn && !state.landed.includes(p.stackedOn)
          ? OPEN.find((x) => x.n === p.stackedOn).name
          : "main";
      root.innerHTML = `
        ${pageHead({
          crumbs: [
            ["GitOrange", "project"],
            ["Pull requests", "pulls"],
            [`#${n}`],
          ],
          titleHtml: `${esc(p.title)} <span class="num mono">#${n}</span>`,
          lede: `<span class="pr-meta">${chip(st.st, st.label)} ${coderLink(p.session)} <span class="muted">wants to merge <span class="mono">${esc(b ? b.name : "")}</span> into <span class="mono">${esc(target)}</span></span></span>`,
          tab: "pulls",
        })}
        <div class="mergebox panel">
          <div class="mergebox-main"><span class="eyebrow">What happens next</span><p><b>${esc(next)}</b></p>${merged ? "" : `<p class="muted small">Estimate: ${esc(eta(n))}${p.held ? " · held" : ""}${state.mergingPaused ? " · merging is paused" : ""}</p>`}</div>
          <div class="actions">${n === 72 && state.decision === "pending" ? '<a class="btn primary" href="#decision-72">Answer Data’s question</a>' : ""}${merged ? "" : `<button class="btn" type="button" data-hold="${n}">${p.held ? "Release" : "Hold auto-merge"}</button><button class="btn" type="button" id="rerun">${icon("redo")}Re-run checks</button>`}<button class="btn quiet" type="button" id="to-diff">View diff</button></div>
        </div>
        <div class="cols">
          <div class="col">
            <section class="section"><h2>Why this change</h2>
              <p class="why">${icon("spark")}<span><b>${esc(r.by)} asked:</b> ${esc(r.text)}</span></p>
              ${s.coder !== "person" ? `<p class="muted small">${esc(s.tool)} · <a href="#session-${p.session}">session ${esc(s.label)}</a> · ${s.steps} steps · ${s.minutes} min</p>` : '<p class="muted small">Written by hand. No agent session.</p>'}
              ${p.checkpoints ? `<ol class="checkpoints">${p.checkpoints.map((c) => `<li><a class="mono" href="#session-${p.session}">${esc(c.sha)}</a><span>${esc(c.turn)}</span></li>`).join("")}</ol>` : ""}
            </section>
            ${relation ? `<section class="section"><h2>Order</h2><p>${esc(relation)}</p></section>` : ""}
            <section class="section"><h2>What Clef read</h2><p class="muted small">A one-line summary of each file. Clef decides from these in about 40 ms.</p><ul class="summaries">${(SUMMARIES[n] || []).map(([f, t]) => `<li><span class="mono">${esc(f)}</span><span>${esc(t)}</span></li>`).join("")}</ul></section>
            <section class="section"><h2>Changes</h2>${diffBlock(n)}</section>
          </div>
          <aside class="col side">
            <section class="panel pad"><h2>Reviews</h2>
              <ul class="reviews">${woke.map(([id, v]) => `<li><a href="#agent-${id}">${dot(id)}</a>${chip(merged ? "clear" : v[0])}<span class="muted small">Woken at ${pct(v[1])}; wakes at ${pct(AGENTS[id].above || 0)}</span></li>`).join("")}</ul>
              <p class="muted small">Not needed: ${
                Object.entries(p.skipped || {})
                  .map(
                    ([id, pr]) =>
                      `${esc(AGENTS[id].name)} at ${pct(pr)} (wakes at ${pct(AGENTS[id].above)})`,
                  )
                  .join(", ") || "none"
              }.</p>
              <p class="muted small">Tests: ${p.tests[0]} of ${p.tests[1]} modules${p.testsRunning ? ", running" : ""}. The rest can’t be affected by these files.</p>
            </section>
            ${b ? `<section class="panel pad"><h2>Branch</h2><p class="mono small">${esc(b.name)}</p><p class="muted small">${b.ahead} ahead · ${b.behind} behind main. GitOrange rebases it when it merges.</p><a class="btn small" href="#branches">${icon("branch")}Branches</a></section>` : ""}
            <details class="panel pad"><summary>Technical details</summary><p class="small">State code <span class="mono">${esc(p.reason.kind)}</span> · head <span class="mono">${esc((p.checkpoints || [{ sha: "f00ba12" }]).slice(-1)[0].sha)}</span> · base <span class="mono">c9a41f0</span> · Clef ${p.clefMs} ms</p></details>
          </aside>
        </div>`;
    },
  });

  /* =====================================================================
   * SESSION page: an agent's context, step by step
   * ===================================================================== */
  GO.registerView("session", {
    title: (id) => (SESSIONS[id] ? SESSIONS[id].label : "Session"),
    navAs: "project",
    skeleton: "detail",
    render(root, id) {
      const s = SESSIONS[id];
      if (!s || s.coder === "person") {
        root.innerHTML = pageHead({
          crumbs: [["GitOrange", "project"], ["Not found"]],
          title: "Session not found",
          lede: '<a href="#live">Back to Live</a>',
        });
        return;
      }
      const req = Object.values(REQUESTS).find((r) => r.sessions.includes(id));
      const prs = Object.keys(PULLS)
        .map(Number)
        .filter((n) => PULLS[n].session === id);
      const kindIcon = {
        prompt: "person",
        plan: "book",
        edit: "file",
        test: "check",
        push: "arrow",
        handback: "redo",
        claim: "spark",
      };
      root.innerHTML = `
        ${pageHead({ crumbs: [["GitOrange", "project"], ["Live", "live"], [s.label]], titleHtml: `<span class="agent-title">${coder(id, { noFor: true })}</span>`, lede: `${esc(s.tool)} session for ${esc(s.forWhom)} · started ${esc(s.started)} · ${s.steps} steps · ${s.minutes} min`, tab: "live" })}
        <div class="cols">
          <div class="col">
            <section class="section"><h2>Request</h2><p class="why">${icon("spark")}<span><b>${esc(req.by)} asked:</b> ${esc(req.text)}</span></p></section>
            <section class="section"><h2>Steps</h2><ol class="steps">${(SESSION_STEPS[id] || []).map(([t, k, text, sha]) => `<li class="k-${k}"><span class="mono muted small">${t}</span><span class="step-icon">${icon(kindIcon[k] || "dot")}</span><span>${esc(text)}${sha ? ` <span class="mono muted small">${esc(sha)}</span>` : ""}</span></li>`).join("")}</ol></section>
          </div>
          <aside class="col side"><section class="panel pad"><h2>Pull requests</h2><ul class="plain">${prs.map((n) => `<li><a href="#pull-${n}"><span class="mono muted">#${n}</span> ${esc(PULLS[n].title)}</a><div>${chip(prState(n).st, prState(n).label)}</div></li>`).join("")}</ul></section>
            <section class="panel pad"><h2>Context kept</h2><p class="small">The request, the plan and each step are stored with the commits they produced, so reviewers and Fixer can see why a line exists.</p></section></aside>
        </div>`;
    },
  });

  /* =====================================================================
   * DECISION page (#72)
   * ===================================================================== */
  let answerChoice = null,
    sequenceStep = 0,
    sequenceTimer = null;
  const SEQ = [
    [
      "Approved at c41e9f2",
      "You approved this commit. A new commit would ask you again.",
    ],
    ["Last checks passed on #72", "4 of 7 test modules"],
    [
      "#72 merged",
      "Compare-and-swap confirmed main was still c9a41f0, then moved it to e41b7d2.",
    ],
    [
      "#73 rebased and merged",
      "main moved from e41b7d2 to 5a90c13. Both branches were deleted.",
    ],
  ];
  function finishLanding() {
    if (state.landed.includes(72)) return;
    state.landed.push(72, 73);
    GO.audit("merge", "Merged #72 Store a currency with every invoice", {
      by: "GitOrange auto-merge",
      approved: state.taught ? "Mahmoud (rule proposed to Data)" : "Mahmoud",
      cas: "c9a41f0 → e41b7d2",
    });
    GO.audit("merge", "Merged #73 Show the currency on invoice PDFs", {
      by: "GitOrange auto-merge",
      approved: "Features passed",
      cas: "e41b7d2 → 5a90c13",
    });
  }
  function runSequence() {
    clearInterval(sequenceTimer);
    if (state.mergingPaused) {
      sequenceStep = 1;
      return;
    }
    if (GO.reduced) {
      sequenceStep = SEQ.length;
      finishLanding();
      return;
    }
    sequenceStep = 1;
    sequenceTimer = setInterval(() => {
      sequenceStep++;
      if (sequenceStep >= SEQ.length) {
        clearInterval(sequenceTimer);
        finishLanding();
      }
      GO.emit("landing");
    }, 1100);
  }
  GO.registerView("decision", {
    title: "Invoice currency",
    navAs: "approvals",
    skeleton: "detail",
    render(root) {
      const d = state.decision,
        answered = d !== "pending",
        landed = state.landed.includes(72);
      const head = pageHead({
        crumbs: [["Approvals", "approvals"], ["Invoice currency"]],
        titleHtml: `<span class="agent-title">${avatar("data", 56, answered ? (d === "fix" ? "asked" : "clear") : "needs")}Were all your invoices so far in Canadian dollars?</span>`,
        lede: `Data is asking about <a href="#pull-72">#72</a> on GitOrange. You’re answering for commit <span class="mono">c41e9f2</span>.`,
      });
      const nextBtn = findings()
        ? '<a class="btn primary" href="#approvals">Next finding</a>'
        : '<a class="btn primary" href="#home">Back to Home</a>';
      let body = "";
      if (d === "approved") {
        const done = (i) => landed || i < sequenceStep;
        const seq = SEQ.map(
          ([t, sub], i) =>
            `<li class="${done(i) ? "done" : i === sequenceStep ? "now" : ""}">${done(i) ? icon("check", "icon ok") : i === sequenceStep ? '<span class="spinner"></span>' : icon("dot")}<span><b>${esc(t)}</b><br><span class="muted small">${esc(sub)}</span></span></li>`,
        ).join("");
        body = `<div class="outcome panel"><h2>${landed ? "Merged" : state.mergingPaused ? "Approved. Waiting because merging is paused" : "Approved. Merging now"}</h2>
          ${state.taught ? `<div class="diff"><div class="diff-path mono">dataagent/dataagent · AGENT.md · b7e21c9 · waiting for Cho to confirm</div><div class="diff-add mono">+ Old invoices default to Canadian dollars for this business. Don’t ask about currency backfills.</div></div>` : ""}
          <ol class="sequence">${seq}</ol>
          <div class="actions">${nextBtn}${landed ? '<a class="btn" href="#audit">See it in the audit log</a>' : '<button class="btn" type="button" id="change-answer">Change answer</button>'}</div></div>`;
      } else if (d === "fix" || d === "askedCho") {
        body = `<div class="outcome panel"><h2>${d === "fix" ? "Sent to Claude·s4" : "Sent to Cho"}</h2><p>${d === "fix" ? "“Some invoices were in US dollars. Ask which ones before setting a currency, and keep theirs.” Data reviews the new commit when it arrives." : "Cho has this question now. You’ll get a reminder at 5 pm if it’s still open."}</p><div class="actions">${nextBtn}<button class="btn" type="button" id="change-answer">Change answer</button></div></div>`;
      } else {
        const opts = [
          [
            "approved",
            "Yes, all were Canadian dollars",
            "Approve the change. It merges, then #73.",
          ],
          [
            "teach",
            "Yes, and don’t ask about currency defaults again",
            "Approve, and propose a rule for Data. Cho confirms Data rules.",
          ],
          [
            "fix",
            "No, some were US dollars",
            "Ask Claude to keep their currency before this merges.",
          ],
          ["askedCho", "I’m not sure", "Ask Cho, who requested the change."],
        ];
        body = `<div class="answer panel" id="answers"><h2>Your answer</h2>
          <fieldset class="choices"><legend class="sr">Your answer</legend>${opts.map(([v, l, sub]) => `<label class="choice${answerChoice === v ? " on" : ""}"><input type="radio" name="answer" value="${v}" ${answerChoice === v ? "checked" : ""}><span><b>${l}</b><br><span class="muted small">${sub}</span></span></label>`).join("")}</fieldset>
          ${
            answerChoice === "teach"
              ? `<div class="teach"><label for="teach-scope">The rule applies to</label><input id="teach-scope" class="mono" value="migrations that change invoices">
            <div class="diff"><div class="diff-path mono">dataagent/dataagent · AGENT.md</div><div class="diff-add mono">+ Old invoices default to Canadian dollars for this business. Don’t ask about currency backfills.</div></div></div>`
              : ""
          }
          <div class="actions"><button class="btn primary" type="button" id="submit-answer" ${answerChoice ? "" : "disabled"}>${answerChoice === "fix" ? "Send to Claude" : answerChoice === "askedCho" ? "Ask Cho" : answerChoice === "teach" ? "Approve and propose rule" : "Approve"}</button><button class="btn quiet" type="button" id="remind">${icon("clock")}Remind me at 5 pm</button></div>
        </div>`;
      }
      root.innerHTML = `${head}
        <div class="cols">
          <div class="col">
            <p class="plain-text">Claude is adding a currency to every invoice, for Cho. Your 1,284 existing invoices don’t record a currency, so all of them will be marked Canadian dollars. If any were in US dollars, their totals will be wrong.</p>
            <div class="callout">${icon("db")}<span><b>Data’s assessment.</b> None of your existing clients has a US address, and the new US client hasn’t been invoiced yet. Safe if you’ve never billed in US dollars.</span></div>
            <div class="table-wrap"><table class="table"><thead><tr><th>Invoice INV-0418</th><th>Today</th><th>After this change</th></tr></thead>
              <tbody><tr><td>Amount</td><td class="mono">1,250.00</td><td class="mono">1,250.00</td></tr><tr><td>Currency</td><td class="muted">Not stored</td><td class="mono new">CAD</td></tr></tbody></table></div>
            ${body}
          </div>
          <aside class="col side">
            <section class="panel pad"><h2>Before you answer</h2><ul class="ticks">
              <li>${icon("check", "icon ok")}Amounts don’t change, only the currency label.</li>
              <li>${icon("undo")}Any invoice’s currency can be changed later.</li>
              <li>${icon("shield")}Shipping and Features reviewed this change. Both passed.</li>
              <li>${icon("clock")}#73 waits for this answer.</li></ul></section>
            <details class="panel pad"><summary>Technical details</summary>
              <p>${coderLink("s4")}</p>
              <pre class="code mono"><span class="add">+ ALTER TABLE invoices ADD COLUMN currency
+   TEXT NOT NULL DEFAULT 'CAD';</span></pre>
              <div class="verdicts">${Object.entries(PULLS[72].crew)
                .map(([id, v]) => verdict(id, v[0], v[1]))
                .join("")}</div>
            </details>
          </aside>
        </div>`;
    },
  });
  function undoAnswer() {
    clearInterval(sequenceTimer);
    sequenceStep = 0;
    if (state.landed.includes(72)) {
      GO.toast("It already merged. Open a revert from Branches instead.", {
        icon: "alert",
      });
      return;
    }
    state.decision = "pending";
    state.taught = false;
    GO.audit("approval", "Withdrew the answer on #72", { by: "Mahmoud" });
    GO.emit("decision", "pending");
    GO.toast("Answer withdrawn. The question is open again.", { icon: "undo" });
  }

  /* =====================================================================
   * Events
   * ===================================================================== */
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    const id = t.id;
    if (id === "submit-answer") {
      const choice = answerChoice;
      if (!choice) return;
      const d = choice === "teach" ? "approved" : choice;
      await GO.pending(
        t,
        choice === "fix"
          ? "Sending to Claude…"
          : choice === "askedCho"
            ? "Asking Cho…"
            : choice === "teach"
              ? "Approving and proposing rule…"
              : "Approving…",
        750,
      );
      state.decision = d;
      state.taught = choice === "teach";
      answerChoice = null;
      GO.audit(
        "approval",
        d === "approved"
          ? "Approved Data’s finding on #72 at c41e9f2"
          : d === "fix"
            ? "Requested changes on #72: keep US-dollar invoices’ currency"
            : "Asked Cho about #72",
        { by: "Mahmoud" },
      );
      if (state.taught)
        GO.audit(
          "setting",
          "Rule proposed in dataagent/dataagent at b7e21c9, waiting for Cho to confirm",
          { by: "Data, from Mahmoud’s answer on #72" },
        );
      if (d === "approved") runSequence();
      GO.emit("decision", d);
      GO.toast(
        d === "approved"
          ? "Approved"
          : d === "fix"
            ? "Sent to Claude·s4"
            : "Sent to Cho",
        { undo: () => undoAnswer() },
      );
      return;
    }
    if (id === "change-answer") {
      await GO.pending(t, "Reopening…", 450);
      undoAnswer();
      return;
    }
    if (id === "remind") {
      await GO.pending(t, "Scheduling…", 450);
      GO.toast("Reminder set for 5 pm", { icon: "clock" });
      GO.go("approvals");
      return;
    }
    if (t.dataset.add) {
      const aid = t.dataset.add;
      await GO.pending(t, "Adding…", 500);
      if (!state.crew.gitorange.includes(aid)) state.crew.gitorange.push(aid);
      delete state.reviewerOff[aid];
      GO.audit("setting", `${AGENTS[aid].name} added to GitOrange`, {
        by: "Mahmoud",
      });
      GO.emit("crew");
      GO.toast(`${AGENTS[aid].name} now reviews GitOrange`, {
        undo: () => {
          state.crew.gitorange = state.crew.gitorange.filter((x) => x !== aid);
          GO.emit("crew");
        },
      });
      return;
    }
    if (t.dataset.hold) {
      const n = Number(t.dataset.hold),
        held = state.held.includes(n);
      await GO.pending(t, held ? "Releasing…" : "Holding…", 450);
      state.held = held
        ? state.held.filter((x) => x !== n)
        : state.held.concat(n);
      GO.audit(
        "setting",
        `${held ? "Released" : "Held"} #${n} ${held ? "back into" : "out of"} the merge queue`,
        { by: "Mahmoud" },
      );
      GO.emit("queue");
      GO.toast(
        held
          ? `#${n} is back in the queue`
          : `#${n} won’t merge until it’s released`,
        { icon: held ? "check" : "pause" },
      );
      return;
    }
    if (t.dataset.move) {
      const n = Number(t.dataset.move),
        i = queue.indexOf(n),
        above = queue[i - 1];
      movePreview = {
        n,
        text: `Moving <b>#${n}</b> above <b>#${above}</b>: #${n} would merge onto <span class="mono">c9a41f0</span> first, then #${above} rebases onto the result. Neither depends on the other.`,
      };
      GO.rerender();
      return;
    }
    if (id === "move-confirm") {
      const n = movePreview.n,
        i = queue.indexOf(n);
      await GO.pending(t, "Reordering…", 500);
      queue.splice(i, 1);
      queue.splice(i - 1, 0, n);
      GO.audit("setting", `Moved #${n} up the merge queue`, { by: "Mahmoud" });
      movePreview = null;
      GO.emit("queue");
      GO.toast(`#${n} moved up`);
      return;
    }
    if (id === "move-cancel") {
      movePreview = null;
      GO.rerender();
      return;
    }
    if (id === "pause-open") {
      pausing = true;
      GO.rerender();
      const f = $("#pause-why");
      if (f) f.focus();
      return;
    }
    if (id === "pause-cancel") {
      pausing = false;
      GO.rerender();
      return;
    }
    if (id === "revert-open") {
      reverting = true;
      GO.rerender();
      return;
    }
    if (id === "revert-cancel") {
      reverting = false;
      GO.rerender();
      return;
    }
    if (id === "revert-go") {
      await GO.pending(t, "Opening revert…", 700);
      reverting = false;
      GO.audit("setting", "Opened a revert of #71 as a new pull request", {
        by: "Mahmoud",
      });
      GO.toast("Revert of #71 opened. It goes through the same reviews.", {
        icon: "undo",
      });
      GO.rerender();
      return;
    }
    if (id === "archive-stale" || id === "restore-stale") {
      await GO.pending(t, archived ? "Restoring…" : "Archiving…", 500);
      archived = !archived;
      GO.audit(
        "setting",
        `${archived ? "Archived" : "Restored"} branch cho/old-insights-spike`,
        { by: "Mahmoud" },
      );
      GO.toast(archived ? "Branch archived" : "Branch restored");
      GO.rerender();
      return;
    }
    if (id === "rerun") {
      rerunTries++;
      const ok = await GO.pending(
        t,
        "Re-running…",
        800,
        rerunTries === 1 ? { fail: "The runner didn’t respond" } : {},
      );
      if (ok) GO.toast("Checks re-queued", { icon: "redo" });
      return;
    }
    if (id === "to-diff") {
      const d = $("#diff");
      if (d) d.scrollIntoView({ behavior: GO.reduced ? "auto" : "smooth" });
      return;
    }
    if (t.dataset.afilter) {
      auditFilter = t.dataset.afilter;
      GO.rerender();
      return;
    }
    if (id === "guard-open") {
      turningOff = t.dataset.agent;
      GO.rerender();
      const f = $("#guard-why");
      if (f) f.focus();
      return;
    }
    if (id === "guard-cancel") {
      turningOff = null;
      GO.rerender();
      return;
    }
    if (id === "guard-on") {
      const aid = t.dataset.agent;
      await GO.pending(t, "Turning on…", 500);
      delete state.reviewerOff[aid];
      if (!state.crew.gitorange.includes(aid)) state.crew.gitorange.push(aid);
      GO.audit(
        "setting",
        `${AGENTS[aid].name} reviews turned back on for GitOrange`,
        { by: "Mahmoud" },
      );
      GO.emit("crew");
      GO.toast(`${AGENTS[aid].name} reviews are on`);
      return;
    }
    if (id === "save-agent") {
      const aid = t.dataset.agent;
      await GO.pending(t, "Opening pull request…", 700);
      agentDraft[aid].proposed = true;
      GO.audit(
        "setting",
        `Proposed a change to ${AGENTS[aid].repo}: wake at ${pct(agentDraft[aid].above)}`,
        { by: "Mahmoud" },
      );
      GO.rerender();
      return;
    }
    if (t.hasAttribute("data-revert")) {
      await GO.pending(t, "Reverting…", 500);
      t.closest(".lesson").innerHTML =
        `<p class="muted">${icon("undo")} Reverted. The rule no longer applies from the next review.</p>`;
      GO.audit("setting", "Reverted a learned rule", { by: "Mahmoud" });
      GO.toast("Rule reverted", { icon: "undo" });
      return;
    }
    if (id === "mk-dry") {
      draft.dry = true;
      await GO.pending(t, "Running on 20 changes…", 1100);
      $("#mk-dry-out").hidden = false;
      GO.setAvatarState($("#mk-avatar"), "clear");
      return;
    }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (f.id === "maker") {
      e.preventDefault();
      await GO.pending($("#mk-create"), "Creating…", 800);
      draft.made = true;
      $("#mk-made").hidden = false;
      GO.setAvatarState($("#mk-avatar"), "clear");
      GO.audit("setting", `Created reviewer @${handleOf(draft.name)}agent`, {
        by: "Mahmoud",
      });
      GO.toast(`Created @${handleOf(draft.name)}agent`);
      return;
    }
    if (f.id === "pause-form") {
      e.preventDefault();
      const why = ($("#pause-why").value || "").trim() || "No reason given";
      await GO.pending($("#pause-go"), "Pausing…", 600);
      state.mergingPaused = { by: "Mahmoud", reason: why, at: GO.clock() };
      pausing = false;
      GO.audit("setting", `Paused merging on GitOrange: ${why}`, {
        by: "Mahmoud",
      });
      GO.emit("merging");
      GO.toast("Merging paused", { icon: "pause" });
      return;
    }
    if (f.id === "stale-form") {
      e.preventDefault();
      staleDays = $("#stale-days").value;
      await GO.pending($("#stale-save"), "Saving…", 450);
      GO.audit(
        "setting",
        `Stale branches now archive after ${staleDays} days`,
        { by: "Mahmoud" },
      );
      GO.toast("Clean-up policy saved");
      return;
    }
    if (f.id === "guard-form") {
      e.preventDefault();
      const aid = f.dataset.agent,
        why = ($("#guard-why").value || "").trim();
      if (!why) {
        $("#guard-why").focus();
        return;
      }
      await GO.pending($("#guard-go"), "Turning off…", 600);
      state.reviewerOff[aid] = { by: "Mahmoud", reason: why, at: GO.clock() };
      turningOff = null;
      GO.audit(
        "setting",
        `${AGENTS[aid].name} reviews turned off for GitOrange: ${why}`,
        { by: "Mahmoud" },
      );
      GO.emit("crew");
      GO.toast(`${AGENTS[aid].name} reviews are off. Everyone sees a banner.`, {
        icon: "alert",
      });
      return;
    }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.name === "answer") {
      answerChoice = t.value;
      GO.rerender();
      const b = $("#submit-answer");
      if (b) b.focus();
      return;
    }
    if (t.id === "b-sort") {
      branchSort = t.value;
      GO.rerender();
      return;
    }
    if (t.id === "crew-toggle") {
      const aid = t.dataset.agent,
        on = t.checked;
      if (on) {
        if (!state.crew.gitorange.includes(aid)) state.crew.gitorange.push(aid);
      } else
        state.crew.gitorange = state.crew.gitorange.filter((x) => x !== aid);
      GO.audit(
        "setting",
        `${AGENTS[aid].name} ${on ? "added to" : "removed from"} GitOrange`,
        { by: "Mahmoud" },
      );
      GO.emit("crew");
      GO.toast(
        on
          ? `${AGENTS[aid].name} now reviews GitOrange`
          : `${AGENTS[aid].name} no longer reviews GitOrange`,
        { icon: on ? "check" : "moon" },
      );
    }
  });
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "b-search") {
      branchQuery = t.value;
      GO.rerender();
      const s = $("#b-search");
      if (s) {
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }
      return;
    }
    if (t.id === "mk-name") {
      draft.name = t.value || "Reviewer";
      $("#mk-title").textContent = draft.name;
      $("#mk-handle").textContent = `@${handleOf(draft.name)}agent`;
    }
    if (t.id === "mk-watch") {
      draft.watch = t.value;
      $("#mk-q").textContent = wakeQuestion(t.value);
    }
    if (t.id === "mk-above") {
      draft.above = Number(t.value);
      $("#mk-above-out").textContent = `${draft.above}%`;
    }
    if (t.id === "mk-paths") draft.paths = t.value;
    if (t.name === "mk-act") draft.act = t.value;
    if (t.id === "wake-q") agentDraft[t.dataset.agent].wake = t.value;
    if (t.id === "wake-t") {
      const v = Number(t.value) / 100,
        aid = t.dataset.agent;
      agentDraft[aid].above = v;
      $("#wake-t-out").textContent = pct(v);
      $("#cal-wrap").innerHTML = calibrationStrip(aid, v);
    }
  });
})();
