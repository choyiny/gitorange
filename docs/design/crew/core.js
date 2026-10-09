/* GitOrange Crew mockup: shared data, helpers and router.
 * Every view file registers itself with GO.registerView(...) and builds HTML with GO.h helpers.
 * Real data: GitOrange's numbers for 1-8 October 2026, the four live agents' trigger questions,
 * and the two lessons learned on #67. Everything else is example data and is labelled as such. */
window.GO = (function () {
  "use strict";

  /* ---------- Crew ----------
   * Shape rule: squarer heads check rules, rounder heads weigh judgement (round 0-100).
   * Colours are a validated categorical order; Shipping is a deliberate neutral. */
  const AGENTS = {
    clef: {
      name: "Clef",
      role: "Dispatcher",
      group: "flow",
      handle: "built in",
      color: "#e26a17",
      round: 100,
      icon: "route",
      job: "Sends each change to the helpers and tests it needs.",
      looks: [
        "Which helpers a change concerns, and how likely",
        "Which test modules a change can affect",
        "Which changes build on, wait for or clash with each other",
      ],
      wake: "Every push",
      track: { line: "Read all 67 changes this week in about 40 ms each." },
      voice: {
        clear:
          "#75: woke Features only. Ran 3 of 7 test modules; the rest can’t be affected.",
        needs:
          "#76 and #77 change the same lines. #76 goes first; #77 waits for it.",
      },
    },
    fixer: {
      name: "Fixer",
      role: "Untangles clashes",
      group: "flow",
      handle: "built in",
      color: "#e34948",
      round: 70,
      icon: "wrench",
      job: "Untangles changes that collide so they can go in.",
      looks: [
        "Lines two changes both edited",
        "What each side was trying to do",
        "Whether tests still pass after untangling",
      ],
      wake: "When a change no longer fits on top of main",
      track: {
        line: "Settled 9 of 54 clashes. Handed 45 back to their agents with both sides’ intent.",
      },
      voice: {
        clear:
          "Untangled a clash in the invoice form: both edits kept, and tests pass.",
        needs:
          "Couldn’t untangle #77: it logs every sign-in where #76 now rate-limits. Claude is redoing #77 on top of #76.",
      },
    },
    security: {
      name: "Security",
      role: "Reviewer",
      group: "review",
      handle: "@securityagent",
      repo: "securityagent/securityagent",
      color: "#2a78d6",
      round: 15,
      icon: "shield",
      job: "Makes sure nobody gets in who shouldn’t, and nothing leaks.",
      looks: [
        "Sign-in, sessions and tokens",
        "Who can see what",
        "User input reaching pages, SQL, shell or links",
        "Secrets and outbound requests (OWASP Top 10)",
      ],
      checklist: [
        "Sign-in can’t be skipped",
        "Customers can’t see each other’s data",
        "No passwords or keys left in the code",
        "Forms can’t attack the database",
      ],
      limit: "Reviews every change. It isn’t a full penetration test.",
      wake: "Could this change affect security: authentication, sessions, tokens, permissions or who can see what, user input reaching HTML, SQL, shell or URLs, secrets, file serving, or outbound requests?",
      above: 0.3,
      track: { raised: 12, setAside: 0, rules: 0 },
      best: "Stopped a token check attackers could time, before it went live (#74, Tuesday).",
      voice: {
        clear: "#75 changes no sign-in, permission or secret. Nothing to fix.",
        needs:
          "#74 compares tokens in a way attackers can time. Codex is fixing it; nothing went live.",
      },
    },
    data: {
      name: "Data",
      role: "Reviewer",
      group: "review",
      handle: "@dataagent",
      repo: "dataagent/dataagent",
      color: "#199e70",
      round: 45,
      icon: "db",
      job: "Makes sure your saved data survives every change.",
      looks: [
        "Tables, columns and indexes",
        "Migrations and backfills",
        "How existing rows are read or rewritten",
      ],
      wake: "Does this change how data is stored: the database schema, a migration, what columns or JSON fields hold, or how existing rows are read or rewritten?",
      above: 0.4,
      track: { raised: 13, setAside: 1, rules: 1 },
      best: "Caught that the invoice-currency change would relabel 1,284 old invoices.",
      lessons: [
        {
          pr: 67,
          when: "Today",
          rule: "Backfills inside migrations are allowed. Check that they rewrite rows safely instead of flagging them.",
          plain:
            "Filling in old records during an update is fine, if it’s done safely.",
          sha: "d47ef24",
        },
      ],
      voice: {
        clear:
          "#81 adds an optional field to invoices. Your 1,284 existing ones read exactly as before.",
        needs:
          "This marks your 1,284 existing invoices as Canadian dollars. Any really in US dollars will show wrong totals.",
      },
    },
    speed: {
      name: "Speed",
      role: "Reviewer",
      group: "review",
      handle: "@speedagent",
      repo: "speedagent/speedagent",
      color: "#c98500",
      round: 85,
      icon: "gauge",
      example: true,
      job: "Watches how fast your app loads and answers.",
      looks: [
        "Page load against a 2.5 second budget",
        "Slow or repeated database queries",
        "How much code each page downloads",
      ],
      wake: "Could this change make a page or request slower: queries, loops over data, bundle size, images or caching?",
      above: 0.35,
      track: { raised: 5, setAside: 1, rules: 0 },
      best: "Homepage loads in 1.8 seconds after Cho’s image change, down from 3.1.",
      recommend: {
        level: "Optional",
        text: "No speed problems seen on GitOrange this month.",
      },
      voice: {
        clear:
          "Homepage loads in 1.8 seconds, down from 3.1, inside the 2.5 second budget.",
        needs:
          "#84’s chart library adds 300 KB to every page, about a second on phones. Approve if one chart is worth it.",
      },
    },
    features: {
      name: "Features",
      role: "Reviewer",
      group: "review",
      handle: "@featureagent",
      repo: "featureagent/featureagent",
      color: "#d55181",
      round: 60,
      icon: "layers",
      job: "Notices when something people use is removed or broken.",
      looks: [
        "Pages, routes and API fields",
        "Tools agents use, and settings",
        "New features nobody asked for",
      ],
      wake: "Does this change what people or agents can do with the product: remove, rename or change a page, route, API field, MCP tool, setting or behaviour, or add a new one?",
      above: 0.5,
      track: { raised: 42, setAside: 2, rules: 1 },
      best: "Noticed a settings page had quietly lost its Save button.",
      lessons: [
        {
          pr: 67,
          when: "Today",
          rule: "Renaming an internal type isn’t a breaking change when every use of it is updated in the same pull request.",
          plain:
            "Renaming something inside the code is fine when every place that uses it changes too.",
          sha: "39851a5",
        },
      ],
      voice: {
        clear:
          "#75 adds a findings tab. Nothing people use was removed or renamed.",
        needs:
          "#79 removes CSV export from Reports. Anyone who downloads reports that way loses it. Was that intended?",
      },
    },
    reliability: {
      name: "Reliability",
      role: "Reviewer",
      group: "review",
      handle: "@reliabilityagent",
      repo: "reliabilityagent/reliabilityagent",
      color: "#008300",
      round: 30,
      icon: "pulse",
      example: true,
      job: "Checks what happens when something goes wrong.",
      looks: [
        "Errors that are caught, retried or lost",
        "Timeouts on calls to other services",
        "How much breaks if this part fails",
      ],
      wake: "Does this change how failures are handled: errors, retries, timeouts, queues or calls to other services?",
      above: 0.35,
      track: { raised: 0, setAside: 0, rules: 0 },
      recommend: {
        level: "Recommended",
        text: "3 errors reached people using GitOrange this week, up from 1.",
      },
      voice: {
        clear:
          "If the payment service is down, #82 retries twice, then shows a clear error.",
        needs:
          "#83 retries failed charges. If the first went through, a customer pays twice. Approve only if your provider blocks duplicates.",
      },
    },
    privacy: {
      name: "Privacy",
      role: "Reviewer",
      group: "review",
      handle: "@privacyagent",
      repo: "privacyagent/privacyagent",
      color: "#6b5cc9",
      round: 95,
      icon: "eyeoff",
      example: true,
      job: "Keeps people’s personal details private.",
      looks: [
        "Personal details collected or logged",
        "Who they’re shared with",
        "How long they’re kept",
      ],
      wake: "Does this change collect, store, log, share or delete personal information about people?",
      above: 0.3,
      track: { raised: 0, setAside: 0, rules: 0 },
      recommend: {
        level: "Recommended",
        text: "GitOrange stores people’s names and email addresses, and nobody checks how they’re handled.",
      },
      voice: {
        clear:
          "#85 logs order numbers, not names or emails. Nothing personal leaves your app.",
        needs:
          "#86 sends customers’ emails to the analytics service on every page view. Does your privacy policy allow that?",
      },
    },
    shipping: {
      name: "Shipping",
      role: "Reviewer",
      group: "review",
      handle: "@shippingagent",
      repo: "shippingagent/shippingagent",
      color: "#55606e",
      round: 5,
      icon: "box",
      job: "Lists what must happen before a change goes live.",
      looks: [
        "Database migrations to run",
        "New settings, secrets and connections",
        "The order things must be deployed in",
      ],
      wake: "Will deploying this change need anything beyond a normal deploy: a migration, a new or changed binding, secret or environment variable, a dependency change, or a specific deploy order?",
      above: 0.3,
      track: { raised: 20, setAside: 0, rules: 0 },
      best: "Listed the three secrets a new deploy needed before anyone hit the error.",
      voice: {
        clear: "#73 needs nothing special. A normal deploy is enough.",
        needs:
          "Run migration 0043 before deploying #72, or the invoices page errors until it runs.",
      },
    },
  };
  const REVIEWERS = [
    "security",
    "data",
    "features",
    "shipping",
    "speed",
    "reliability",
    "privacy",
  ];

  /* Avatar states. `play` is the avatar action; `hold` keeps a continuous expression. */
  const STATES = {
    clear: { label: "Passed", cls: "good", icon: "check", play: "success" },
    needs: { label: "Needs a person", cls: "warn", icon: "alert", hold: "input" },
    asked: {
      label: "Changes requested",
      cls: "serious",
      icon: "redo",
      play: "send",
    },
    reviewing: { label: "Checking", cls: "info", icon: "eye", play: "inspect" },
    running: { label: "Working", cls: "info", icon: "spark", hold: "waiting" },
    blocked: {
      label: "Blocking merge",
      cls: "critical",
      icon: "stop",
      play: "blocked",
    },
    learned: {
      label: "Rule saved",
      cls: "good",
      icon: "book",
      play: "surprise",
      then: "send",
    },
    skipped: { label: "Not needed", cls: "off", icon: "moon", play: "sleep" },
    off: {
      label: "Off for this project",
      cls: "off",
      icon: "moon",
      play: "sleep",
    },
    idle: { label: "Ready", cls: "off", icon: "dot" },
  };

  /* ---------- Coding agents (they write the code; never drawn as crew robots) ---------- */
  const SESSIONS = {
    s4: {
      coder: "claude",
      label: "Claude·s4",
      tool: "Claude Code",
      forWhom: "Cho",
      started: "08:31",
      steps: 23,
      minutes: 41,
      files: 3,
    },
    s2: {
      coder: "codex",
      label: "Codex·s2",
      tool: "Codex CLI",
      forWhom: "Mahmoud",
      started: "10:02",
      steps: 9,
      minutes: 12,
      files: 1,
    },
    s5: {
      coder: "codex",
      label: "Codex·s5",
      tool: "Codex CLI",
      forWhom: "Mahmoud",
      started: "11:40",
      steps: 14,
      minutes: 22,
      files: 2,
    },
    s6: {
      coder: "claude",
      label: "Claude·s6",
      tool: "Claude Code",
      forWhom: "Cho",
      started: "11:44",
      steps: 17,
      minutes: 26,
      files: 2,
    },
    hand: { coder: "person", label: "Cho", tool: "By hand", forWhom: "Cho" },
  };
  const CODERS = {
    claude: { name: "Claude", mono: "C" },
    codex: { name: "Codex", mono: "X" },
    person: { name: "Person", mono: "" },
  };

  /* ---------- Requests: what a person asked for. The agent-native unit of work. ---------- */
  const REQUESTS = {
    R1: {
      by: "Cho",
      text: "Bill the first US client in US dollars",
      sessions: ["s4"],
      pulls: [72, 73],
    },
    R2: {
      by: "Mahmoud",
      text: "Protect the live-updates feed with a token",
      sessions: ["s2"],
      pulls: [74],
    },
    R3: {
      by: "Cho",
      text: "Show findings per agent on Insights",
      sessions: ["hand"],
      pulls: [75],
    },
    R4: {
      by: "Mahmoud",
      text: "Rate-limit the public API",
      sessions: ["s5"],
      pulls: [76],
    },
    R5: {
      by: "Cho",
      text: "Log every sign-in attempt",
      sessions: ["s6"],
      pulls: [77],
    },
  };

  /* ---------- Open pull requests (examples) ----------
   * lane: person | agent | checking | ready   (GitOrange pullState: human_review | agent_followup | waiting | ready)
   * crew: reviewers Clef woke, with Clef's probability. skipped: reviewers Clef didn't wake. */
  const PULLS = {
    72: {
      req: "R1",
      session: "s4",
      title: "Store a currency with every invoice",
      plain: "the invoice-currency change",
      lane: "person",
      since: "09:12",
      inState: "3 h 02 min",
      crew: {
        data: ["needs", 0.97],
        shipping: ["clear", 0.88],
        features: ["clear", 0.71],
      },
      skipped: { security: 0.06 },
      tests: [4, 7],
      clefMs: 41,
      files: [
        "worker/src/db/app.schema.ts",
        "migrations/0043_invoice_currency.sql",
        "worker/src/billing/invoices.ts",
      ],
      reason: {
        kind: "needs_person",
        agent: "data",
        text: "Existing invoices will be set to CAD.",
      },
      checkpoints: [
        {
          sha: "3f9a2c1",
          turn: "Add a currency column to invoices, defaulting to CAD",
        },
        {
          sha: "8be0d47",
          turn: "Write migration 0043 and backfill existing rows",
        },
        { sha: "c41e9f2", turn: "Show the currency in the invoice API" },
      ],
    },
    73: {
      req: "R1",
      session: "s4",
      title: "Show the currency on invoice PDFs",
      plain: "the invoice PDF change",
      lane: "ready",
      inState: "1 h 10 min",
      stackedOn: 72,
      crew: { features: ["clear", 0.64] },
      skipped: { data: 0.12, shipping: 0.09, security: 0.04 },
      tests: [2, 7],
      clefMs: 37,
      files: ["worker/src/billing/pdf.ts", "src/pages/Invoice.tsx"],
      reason: {
        kind: "stacked",
        text: "Builds on #72, so it goes in right after it.",
      },
      checkpoints: [
        { sha: "a1d5e60", turn: "Print the currency code beside every total" },
      ],
    },
    74: {
      req: "R2",
      session: "s2",
      title: "Require a token for the live-updates feed",
      plain: "the live-feed token change",
      lane: "agent",
      inState: "6 min",
      crew: { security: ["asked", 0.93] },
      skipped: { data: 0.03, features: 0.31, shipping: 0.22 },
      tests: [3, 7],
      clefMs: 39,
      files: ["worker/src/live/hub.ts"],
      claimedBy: "s2",
      claimedFor: "3 min",
      reason: {
        kind: "change_requested",
        agent: "security",
        text: "Compare tokens in constant time.",
      },
      checkpoints: [
        {
          sha: "5c0b8e3",
          turn: "Check a bearer token before opening the socket",
        },
      ],
    },
    75: {
      req: "R3",
      session: "hand",
      title: "Insights: show findings per agent",
      plain: "the Insights findings change",
      lane: "checking",
      inState: "4 min",
      crew: { features: ["reviewing", 0.58] },
      skipped: { data: 0.08, security: 0.05, shipping: 0.11 },
      tests: [3, 7],
      testsRunning: true,
      clefMs: 35,
      files: ["src/pages/RepoInsights.tsx", "worker/src/lib/insights.ts"],
      reason: {
        kind: "waiting",
        text: "Tests running: 3 of 7 modules. Clef skipped 4 this change can’t affect.",
      },
    },
    76: {
      req: "R4",
      session: "s5",
      title: "Rate-limit the public API",
      plain: "the rate-limit change",
      lane: "checking",
      inState: "2 min",
      before: 77,
      crew: { security: ["reviewing", 0.62], shipping: ["reviewing", 0.41] },
      skipped: { data: 0.05, features: 0.44 },
      tests: [5, 7],
      testsRunning: true,
      clefMs: 44,
      files: ["worker/src/index.ts", "worker/src/lib/limits.ts"],
      reason: {
        kind: "waiting",
        text: "Security and Shipping are checking it. Goes before #77.",
      },
      checkpoints: [
        {
          sha: "e72a913",
          turn: "Add a per-token rate limit to every /api route",
        },
      ],
    },
    77: {
      req: "R5",
      session: "s6",
      title: "Log every sign-in attempt",
      plain: "the sign-in log change",
      lane: "agent",
      inState: "9 min",
      after: 76,
      clash: { with: 76, file: "worker/src/index.ts" },
      crew: { security: ["clear", 0.81], privacy: ["skipped", 0] },
      skipped: { data: 0.21, shipping: 0.18 },
      tests: [4, 7],
      clefMs: 40,
      files: ["worker/src/index.ts", "worker/src/auth/index.ts"],
      reason: {
        kind: "rebase_conflict",
        text: "Clashes with #76 in worker/src/index.ts. Fixer couldn’t untangle it and handed it back to Claude·s6 with both sides’ intent.",
      },
      checkpoints: [
        { sha: "0d6f2b8", turn: "Write a row for every sign-in attempt" },
      ],
    },
  };
  const LANES = [
    { id: "person", label: "Needs a person", icon: "person" },
    { id: "agent", label: "Changes requested", icon: "redo" },
    { id: "checking", label: "Checking", icon: "eye" },
    { id: "ready", label: "Queued to merge", icon: "check" },
  ];

  /* ---------- Real numbers: choyiny/gitorange, 1-8 October 2026 ---------- */
  const WEEK = {
    landed: 67,
    hands_off: 56,
    auto: 56,
    byPerson: 11,
    neededPerson: 8,
    medianWaitMin: 7,
    medianLandMin: 12,
    ciRuns: 291,
    ciPass: 0.96,
    fixerOk: 9,
    fixerTried: 54,
    rulesLearned: 2,
  };

  /* ---------- Repositories on this instance ---------- */
  const REPOS = [
    { name: "choyiny/gitorange", owner: "choyiny", repo: "gitorange", kind: "code", visibility: "Internal", description: "A code host where AI agents ship the code and people approve the risk.", language: "TypeScript", updated: "today", open: 6 },
    { name: "dataagent/dataagent", owner: "dataagent", repo: "dataagent", kind: "agent", agent: "data", visibility: "Internal", description: "Instructions and knowledge for the Data reviewer agent.", language: "Markdown", updated: "today", open: 0 },
    { name: "featureagent/featureagent", owner: "featureagent", repo: "featureagent", kind: "agent", agent: "features", visibility: "Internal", description: "Instructions and knowledge for the Features reviewer agent.", language: "Markdown", updated: "today", open: 0 },
    { name: "securityagent/securityagent", owner: "securityagent", repo: "securityagent", kind: "agent", agent: "security", visibility: "Internal", description: "Instructions and knowledge for the Security reviewer agent.", language: "Markdown", updated: "2 days ago", open: 0 },
    { name: "shippingagent/shippingagent", owner: "shippingagent", repo: "shippingagent", kind: "agent", agent: "shipping", visibility: "Internal", description: "Instructions and knowledge for the Shipping reviewer agent.", language: "Markdown", updated: "2 days ago", open: 0 },
  ];

  /* ---------- Mutable state, shared across views ---------- */
  const state = {
    decision: "pending", // pending | approved | fix | askedCho
    taught: false, // Data learned "don't ask about currency defaults" via the sheet
    crew: { gitorange: ["security", "data", "features", "shipping"] },
    delegate: {
      shipping: true,
      features: true,
      data: false,
      security: false,
      speed: false,
      reliability: false,
      privacy: false,
    },
    devOpen: false,
    repo: "choyiny/gitorange",
    mergingPaused: null, // { by, reason, at } when someone pauses merging
    reviewerOff: {}, // agentId -> { by, reason, at } when a guarded reviewer is turned off
    held: [], // PR numbers held out of the merge queue
    audit: [], // events appended by actions this session (newest first)
    visited: {}, // route -> true, so revisits paint without a skeleton
  };
  try {
    state.devOpen = localStorage.getItem("go-dev") === "1";
  } catch (e) {}

  /* ---------- Tiny event bus ---------- */
  const listeners = {};
  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
  }
  function emit(name, data) {
    (listeners[name] || []).forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
    rerender();
  }

  /* ---------- HTML helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) =>
    String(s == null ? "" : s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const icon = (id, cls = "icon") =>
    `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const pct = (p) => Math.round(p * 100) + "%";

  function avatar(id, size, st, extra = "") {
    const a = AGENTS[id];
    const el = `<agent-robot-avatar size="${size}" color="${a.color}" auto-sleep="0" wake-on="manual" motion="auto" data-agent="${id}"
      data-round="${a.round}" data-state="${st || "idle"}" style="--s:${size}px;--c:${a.color}" aria-hidden="true" ${extra}></agent-robot-avatar>`;
    if (size < 28) return el;
    /* A soft halo in the agent's colour; a quiet ring only while it is checking, working or waiting on a person. */
    const live = ["reviewing", "needs", "running"].includes(st) ? " live" : "";
    return `<span class="ava st-${st || "idle"}${live}" style="--agent:${a.color}">${el}</span>`;
  }
  function chip(st, label) {
    const s = STATES[st] || STATES.idle;
    return `<span class="chip ${s.cls}">${icon(s.icon)}${esc(label || s.label)}</span>`;
  }
  /* A small robot with its emblem badge and a status ring; always carries a text title. */
  function mini(id, st, size = 34) {
    const a = AGENTS[id],
      s = STATES[st] || STATES.idle;
    return `<span class="mini ${s.cls}" title="${esc(a.name)}: ${esc(s.label)}" style="--agent:${a.color}">${avatar(id, size, st)}<span class="badge">${icon(a.icon)}</span></span>`;
  }
  /* Text verdict for dense developer views: coloured dot (identity) + name + state. */
  function verdict(id, st, p) {
    const a = AGENTS[id],
      s = STATES[st] || STATES.idle;
    const tip = p != null ? ` title="${esc(a.name)}: ${esc(s.label)}. Clef woke it at ${pct(p)}${a.above ? `; it wakes at ${pct(a.above)}` : ""}."` : ` title="${esc(a.name)}: ${esc(s.label)}"`;
    return `<span class="verdict ${s.cls}" style="--agent:${a.color}"${tip}><i></i>${esc(a.name)}<span class="v-state">${icon(s.icon)}${esc(s.label)}</span></span>`;
  }
  /* Coding-agent identity: a monogram tile, never a robot. */
  function coder(sessionId, opts = {}) {
    const s = SESSIONS[sessionId];
    if (!s) return "";
    const c = CODERS[s.coder];
    const tile =
      s.coder === "person"
        ? `<span class="mono-tile person">${icon("person")}</span>`
        : `<span class="mono-tile ${s.coder}">${c.mono}</span>`;
    const label =
      s.coder === "person"
        ? `${esc(s.label)} <span class="muted">by hand</span>`
        : `${esc(s.label)}${opts.noFor ? "" : ` <span class="muted">for ${esc(s.forWhom)}</span>`}`;
    return `<span class="coder">${tile}<span>${label}</span></span>`;
  }
  /* Coder tile that links to its session page (use only outside other links). */
  function coderLink(sessionId, opts = {}) {
    const s = SESSIONS[sessionId];
    if (!s || s.coder === "person") return coder(sessionId, opts);
    return `<a class="coder-link" href="#session-${sessionId}">${coder(sessionId, opts)}</a>`;
  }
  /* Repo header and tabs (GitHub-style) on every repository page. */
  const TAB_ALIAS = { project: "health", rules: "rsettings" };
  const REPO_TABS = [
    ["code", "Code", "file", "code"], ["health", "Health", "pulse", "project"], ["pulls", "Pull requests", "branch", "pulls"],
    ["branches", "Branches", "branch", "branches"], ["live", "Live", "live", "live"], ["actions", "Actions", "play", "actions"],
    ["insights", "Insights", "gauge", "insights"], ["audit", "Audit log", "book", "audit"], ["rsettings", "Settings", "sliders", "rsettings-general"],
  ];
  const AGENT_REPO_TABS = ["code", "commits", "rsettings"];
  function currentRepo() { return REPOS.find((r) => r.name === state.repo) || REPOS[0]; }
  function repoHeader(active) {
    const r = currentRepo();
    const tabs = r.kind === "agent" ? [["code", "Code", "file", "code"], ["commits", "Commits", "clock", "commits"], ["rsettings", "Settings", "sliders", "rsettings-general"]] : REPO_TABS;
    const pr = Object.keys(PULLS).length - (state.landed ? state.landed.length : 0);
    return `<div class="rhead">
      <div class="rhead-row"><span class="rhead-name">${icon(r.kind === "agent" ? "crew" : "branch")}<a href="#profile-${r.owner}">${esc(r.owner)}</a><span class="sep">/</span><a href="#repo-${r.name.replace("/", "~")}"><b>${esc(r.repo)}</b></a></span><span class="vis">${esc(r.visibility)}</span>${r.kind === "agent" ? `<span class="vis">Agent instructions</span>` : ""}</div>
      <nav class="rtabs" aria-label="Repository">${tabs.map(([id, label, ic, route]) => `<a href="#${route}" ${id === active ? 'aria-current="page"' : ""}>${icon(ic)}${esc(label)}${id === "pulls" && r.kind !== "agent" ? ` <span class="count">${pr}</span>` : ""}</a>`).join("")}</nav>
    </div>`;
  }
  function projectTabs() { return ""; }
  /* Every page: the trail and name go to the top band; the content gets the page's statement, lede and actions. */
  function pageHead(o) {
    let trail = (o.crumbs || []).slice();
    const tab = o.tab ? TAB_ALIAS[o.tab] || o.tab : null;
    if (tab) {
      const r = currentRepo();
      trail = [[r.owner, "profile-" + r.owner], [r.repo, "repo-" + r.name.replace("/", "~")]].concat(trail.slice(1));
    }
    const last = trail.length ? trail[trail.length - 1][0] : o.title;
    GO.ph = { crumbs: trail.length ? trail : [[o.title || ""]], title: o.bandTitle || last || o.title || "", icon: o.icon || (tab ? (REPO_TABS.find((t) => t[0] === tab) || [])[2] : null) };
    return `${tab ? repoHeader(tab) : ""}<header class="phead">
      <div class="phead-row"><div class="phead-main">${o.pre || ""}<h2 class="ph-title">${o.titleHtml || esc(o.title)}</h2>${o.lede ? `<p class="lede">${o.lede}</p>` : ""}</div>${o.actions ? `<div class="phead-actions">${o.actions}</div>` : ""}</div>
    </header>`;
  }
  function audit(kind, text, extra = {}) {
    state.audit.unshift(Object.assign({ at: clock(), kind, text }, extra));
  }
  function clock() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  /* Sparkline: single series, area fill, emphasised endpoint, native hover titles per point. */
  function spark(values, o = {}) {
    const w = o.w || 120,
      h = o.h || 32,
      pad = 3;
    const min = Math.min(...values),
      max = Math.max(...values),
      span = max - min || 1;
    const x = (i) => pad + (i * (w - pad * 2)) / (values.length - 1);
    const y = (v) => h - pad - ((v - min) / span) * (h - pad * 2);
    const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const area = `M${x(0)},${h - pad} L${pts.join(" L")} L${x(values.length - 1)},${h - pad} Z`;
    const labels = o.labels || values.map((_, i) => `Week ${i + 1}`);
    const dots = values
      .map(
        (v, i) =>
          `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${i === values.length - 1 ? 3.2 : 6}" class="${i === values.length - 1 ? "end" : "hit"}"><title>${esc(labels[i])}: ${esc(v)}${esc(o.unit || "")}</title></circle>`,
      )
      .join("");
    return `<svg class="spark ${o.cls || ""}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(o.label || "Trend")}"><path class="area" d="${area}"/><polyline class="line" points="${pts.join(" ")}"/>${dots}</svg>`;
  }

  /* ---------- Avatars ----------
   * Serious by default: an avatar changes expression only when its state changes. No idle re-animation. */
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function applyState(el) {
    const s = STATES[el.dataset.state];
    try {
      if (el.setHeadRoundness) el.setHeadRoundness(Number(el.dataset.round || 50));
      if (!s) { el.reset && el.reset(); return; }
      if (s.play === "sleep") { el.sleep(); return; }
      if (s.hold === "waiting") { el.startWaiting(); return; }
      if (s.hold === "input") { el.input(true); return; }
      if (s.play) {
        const r = el.play(s.play);
        if (s.then && r && r.then) r.then(() => { try { el.play(s.then); } catch (e) {} });
      }
    } catch (e) { /* decoration only */ }
  }
  function setAvatarState(el, st) {
    if (!el) return;
    el.dataset.state = st;
    try {
      if (el.input) el.input(false);
      if (el.stopWaiting) el.stopWaiting();
      if (st !== "off" && st !== "skipped" && el.wake) el.wake();
    } catch (e) {}
    applyState(el);
  }
  function animate(root) {
    if (!root || !window.customElements) return;
    customElements.whenDefined("agent-robot-avatar").then(() => {
      $$("agent-robot-avatar", root).forEach((el) => {
        try { el.setPointerFollow && el.setPointerFollow(Number(el.getAttribute("size")) >= 40 && !reduced); } catch (e) {}
        applyState(el);
      });
    });
  }

  /* ---------- Feedback: pending buttons, failures and toasts ---------- */
  /* pending(btn, label, ms, { fail }) resolves true on success. With fail, it resolves false and shows the
   * error inline on the button so the person can retry. */
  function pending(btn, label, ms = 650, opts = {}) {
    return new Promise((resolve) => {
      if (!btn) return resolve(true);
      const html = btn.dataset.html || btn.innerHTML;
      btn.dataset.html = html;
      btn.disabled = true;
      btn.classList.remove("is-error");
      btn.setAttribute("aria-busy", "true");
      btn.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label)}`;
      setTimeout(() => {
        if (!btn.isConnected) return resolve(!opts.fail);
        btn.disabled = false;
        btn.removeAttribute("aria-busy");
        if (opts.fail) {
          btn.classList.add("is-error");
          btn.innerHTML = `${icon("alert")}${esc(opts.fail)} · Retry`;
          resolve(false);
        } else {
          btn.innerHTML = html;
          delete btn.dataset.html;
          resolve(true);
        }
      }, reduced ? Math.min(ms, 250) : ms);
    });
  }
  let toastTimer = null;
  function toast(text, opts = {}) {
    let el = $("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.innerHTML = `${icon(opts.icon || "check")}<span>${esc(text)}</span>${opts.undo ? '<button class="btn small quiet" type="button" id="toast-undo">Undo</button>' : ""}`;
    el.classList.add("show");
    const u = $("#toast-undo");
    if (u) u.onclick = () => { el.classList.remove("show"); opts.undo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), opts.ms || 8000);
    el.onmouseenter = () => clearTimeout(toastTimer);
    el.onmouseleave = () => { toastTimer = setTimeout(() => el.classList.remove("show"), 2500); };
  }

  /* ---------- Global banners: things that change how the whole project behaves ---------- */
  function banners() {
    const out = [];
    if (state.mergingPaused) out.push(`<div class="gbanner warn" role="alert">${icon("pause")}<span><b>Merging is paused on GitOrange.</b> ${esc(state.mergingPaused.by)} paused it at ${esc(state.mergingPaused.at)}: ${esc(state.mergingPaused.reason)}. Nothing merges until it resumes.</span><button class="btn small" type="button" data-resume-merging>Resume merging</button></div>`);
    Object.entries(state.reviewerOff).forEach(([id, o]) => out.push(`<div class="gbanner serious" role="alert">${icon("alert")}<span><b>${esc(AGENTS[id].name)} reviews are off for GitOrange.</b> ${esc(o.by)} turned them off at ${esc(o.at)}: ${esc(o.reason)}.</span><a class="btn small" href="#agent-${id}">Review setting</a></div>`));
    const el = $("#banners");
    if (el) el.innerHTML = out.join("");
  }

  /* ---------- Router ----------
   * Hash routes: "name" or "name-param" (letters, digits and dashes, so links survive the artifact host).
   * First visit: a page-shaped skeleton, then the page with a short transition. Revisits paint at once.
   * A state change re-renders the current page in place, keeping scroll and focus where possible. */
  const views = {};
  let current = { id: "home", param: "" };
  let navToken = 0;
  function registerView(id, def) { views[id] = def; }
  function parse(hash) {
    const h = (hash || "").replace(/^#/, "") || "home";
    if (views[h]) return { id: h, param: "" };
    const i = h.indexOf("-");
    const id = i > 0 ? h.slice(0, i) : h;
    return views[id] ? { id, param: i > 0 ? h.slice(i + 1) : "" } : { id: "home", param: "" };
  }
  function rootEl() {
    let root = $("#page");
    if (!root) { root = document.createElement("section"); root.id = "page"; root.className = "view"; $("main").appendChild(root); }
    return root;
  }
  function markNav(def, param) {
    const as = typeof def.navAs === "function" ? def.navAs(param) : def.navAs || current.id;
    $$("[data-nav]").forEach((a) => { if (a.dataset.nav === as) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    const n = approvalsCount();
    $$(".nav-count").forEach((c) => { c.textContent = String(n); c.toggleAttribute("data-zero", !n); });
  }
  function paint(def, param, focus) {
    const root = rootEl();
    root.setAttribute("aria-busy", "false");
    def.render(root, param);
    root.dataset.view = current.id;
    animate(root);
    markNav(def, param);
    banners();
    if (def.title) document.title = `${typeof def.title === "function" ? def.title(param) : def.title} · GitOrange`;
    if (GO.shell) GO.shell.update();
    if (focus) { const h = $("#ph h1") || $("h1", root); if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); } }
  }
  const SKELETONS = {
    list: `<div class="sk sk-line w20"></div><div class="sk sk-title"></div><div class="sk sk-line w50"></div><div class="sk-rows">${'<div class="sk sk-row"></div>'.repeat(6)}</div>`,
    detail: `<div class="sk sk-line w20"></div><div class="sk sk-title"></div><div class="sk-cols"><div class="sk-rows">${'<div class="sk sk-row tall"></div>'.repeat(3)}</div><div class="sk sk-side"></div></div>`,
    graph: `<div class="sk sk-line w20"></div><div class="sk sk-title"></div><div class="sk sk-block short"></div><div class="sk sk-block"></div>`,
    overview: `<div class="sk sk-line w20"></div><div class="sk sk-title"></div><div class="sk sk-line w50"></div><div class="sk sk-block short"></div><div class="sk-grid"><div class="sk sk-card"></div><div class="sk sk-card"></div><div class="sk sk-card"></div></div>`,
  };
  function skeleton(def) {
    const root = rootEl();
    root.setAttribute("aria-busy", "true");
    root.innerHTML = `<div class="sk-page" aria-label="Loading">${SKELETONS[def.skeleton || "overview"] || SKELETONS.overview}</div>`;
  }
  function route() {
    const next = parse(location.hash);
    const def = views[next.id];
    /* These pages belong to choyiny/gitorange; opening one makes it the current repository. */
    if (["project", "pulls", "branches", "live", "audit", "rules", "pull", "session", "decision", "finding", "actions", "run", "agentrun", "insights"].includes(next.id)) state.repo = "choyiny/gitorange";
    const key = next.id + "-" + next.param;
    current = next;
    const token = ++navToken;
    scroller().scrollTop = 0;
    if (state.visited[key] || reduced) { paint(def, next.param, true); return; }
    state.visited[key] = true;
    skeleton(def);
    markNav(def, next.param);
    let painted = false;
    const swap = () => {
      if (painted || token !== navToken) return;
      painted = true;
      paint(def, next.param, true);
      const r = rootEl(); r.classList.remove("enter"); void r.offsetWidth; r.classList.add("enter");
    };
    setTimeout(() => { if (token === navToken) swap(); }, def.loadMs != null ? def.loadMs : 280);
  }
  /* The work panel scrolls, never the window (see .content in app.css). */
  function scroller() { return document.getElementById("main") || document.scrollingElement; }
  function rerender() {
    const def = views[current.id];
    if (!def || rootEl().getAttribute("aria-busy") === "true") return;
    const y = scroller().scrollTop;
    const active = document.activeElement && document.activeElement.id;
    paint(def, current.param, false);
    scroller().scrollTop = y;
    if (active) { const el = document.getElementById(active); if (el) el.focus({ preventScroll: true }); }
  }
  function approvalsCount() { return (state.decision === "pending" ? 1 : 0) + (GO.extraApprovals ? GO.extraApprovals() : 0); }
  function go(target) { if (location.hash === "#" + target) route(); else location.hash = target; }
  function boot() {
    window.addEventListener("hashchange", route);
    document.addEventListener("click", (e) => {
      const t = e.target.closest("[data-resume-merging]");
      if (!t) return;
      audit("merging", "Mahmoud resumed merging on GitOrange");
      state.mergingPaused = null;
      emit("merging");
      toast("Merging resumed");
    });
    route();
  }

  return {
    AGENTS, REVIEWERS, STATES, SESSIONS, CODERS, REQUESTS, PULLS, LANES, WEEK, REPOS, state, currentRepo,
    on, emit, registerView, go, boot, rerender, approvalsCount, current: () => current,
    animate, applyState, setAvatarState, reduced, pending, toast, audit, clock,
    h: { $, $$, esc, icon, pct, avatar, chip, mini, verdict, coder, coderLink, spark, pageHead, projectTabs, repoHeader },
    ui: {
      openPull: (n) => go("pull-" + n),
      openAgent: (id) => go("agent-" + id),
      openFinding: (n) => go(String(n) === "72" ? "decision-72" : "finding-" + n),
      openSession: (id) => go("session-" + id),
    },
  };
})();
