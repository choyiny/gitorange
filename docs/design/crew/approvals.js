/* Approvals (#approvals) and one page per developer finding (#finding-<id>).
 * Dense list, keyboard first, GitHub vocabulary: Approve, Request changes, Dismiss. Security and Data are
 * guarded: no bulk or one-key approval, and approving needs a reason. Every action shows a pending state,
 * writes GO.audit, and leaves a one-line receipt with Undo until you leave the page. The owner decision
 * (#72) lives on #decision-72; the developer findings below are examples. Robots are static. */
(function () {
  "use strict";
  const G = window.GO,
    H = G.h,
    A = G.AGENTS,
    esc = H.esc,
    icon = (id, c) => H.icon(id, c);
  const GUARD = new Set(["data", "security"]);
  const DEL_ORDER = [
    "shipping",
    "features",
    "speed",
    "reliability",
    "privacy",
    "data",
    "security",
  ];
  const REASONS = [
    ["False positive", "The finding is wrong."],
    ["Accepted risk", "The risk is real and you accept it."],
    ["Intended behaviour", "It works this way on purpose."],
  ];
  const OUTCOME = {
    approved: "Approved. #72 goes in when its checks pass, then #73.",
    fix: "Sent back to Claude·s4 for a change.",
    askedCho: "Passed to Cho.",
  };

  /* ---------- Example findings (module state). The id is the route: #finding-<id>. ---------- */
  const items = [
    {
      id: "79",
      agent: "features",
      pr: 79,
      session: "s5",
      wait: "25 min",
      p: 0.82,
      sha: "e19c0a4",
      title: "Reports: replace CSV export with the new Downloads page",
      short: "CSV export, #79",
      head: "#79 removes CSV export from Reports",
      text: "#79 removes CSV export from Reports. Anyone who downloads reports that way loses it. Was that intended?",
      plain:
        "Codex is replacing the Reports page’s CSV export with a new Downloads page, for Mahmoud. The description doesn’t say what replaces CSV export, so Features can’t tell whether removing it was intended.",
      assess:
        "Approve if the Downloads page gives people the same CSV files. Otherwise request changes.",
      ex: {
        path: "src/pages/Reports.tsx",
        diff: [
          [" ", "<Toolbar>"],
          ["-", "  <Button onClick={exportCsv}>Export CSV</Button>"],
          ["+", '  <Link to="/downloads">Downloads</Link>'],
          [" ", "</Toolbar>"],
        ],
      },
      facts: [
        ["person", "Reports were exported as CSV 41 times in September."],
        ["layers", "Features asked because a control people use was removed."],
        ["undo", "If you approve and change your mind, #79 can be reverted."],
      ],
      fix: "Keep CSV export or name its replacement in the description.",
      why: "The Downloads page replaces CSV export, and the description says so.",
      rule: "Removing a feature is intended when the pull request description names its replacement.",
      files: ["src/pages/Reports.tsx", "worker/src/reports/csv.ts"],
    },
    {
      id: "ship72",
      agent: "shipping",
      pr: 72,
      session: "s4",
      wait: "3 h",
      p: 0.88,
      sha: "a03c6e8",
      kind: "Deploy step",
      title: G.PULLS[72].title,
      short: "Deploy step, #72",
      approveLabel: "Mark as planned",
      head: "Run migration 0043 before deploying #72",
      approved:
        "Marked as planned. Migration 0043 is on the #72 deploy checklist.",
      text: "Run migration 0043 before deploying #72, or the invoices page errors until it runs.",
      plain:
        "#72 reads a new currency column on invoices. Migration 0043 adds that column. If the new code goes live before the migration runs, the invoices page errors until it does.",
      assess:
        "Mark as planned if your deploy runs migrations first. GitOrange’s deploy steps already do.",
      ex: {
        head: ["Deploy order", "Invoices page"],
        rows: [
          ["Migration 0043, then #72", "Works throughout"],
          ["#72, then migration 0043", "Errors until the migration runs"],
        ],
      },
      facts: [
        [
          "box",
          "Migration 0043 adds one column with a default. It runs in under a second.",
        ],
        [
          "check",
          "yarn db:migrate:prod runs before yarn deploy in the deploy steps.",
        ],
        ["undo", "The column can be dropped if #72 is reverted."],
      ],
      fix: "Make the invoices page work until migration 0043 runs.",
      why: "Our deploy script runs migrations first.",
      rule: "Skip the deploy note when the deploy script already runs migrations first.",
      files: ["migrations/0043_invoice_currency.sql"],
    },
    {
      id: "80",
      agent: "security",
      pr: 80,
      session: "s6",
      wait: "12 min",
      p: 0.91,
      sha: "7b2d91f",
      title: "Share project files by link",
      short: "File links, #80",
      head: "#80 lets anyone with a link download private files",
      text: "#80 lets anyone with a project link download its private files without signing in. Approve only if they’re meant to be public.",
      plain:
        "Claude is adding share links for project files, for Cho. Opening a link downloads the file without checking who is signed in. Anyone who gets a link to a private project can read its files.",
      assess:
        "Request changes unless every shared project is meant to be public.",
      ex: {
        path: "worker/src/files/share.ts",
        diff: [
          [" ", 'app.get("/share/:token", async (c) => {'],
          ["-", "  const user = await requireUser(c);"],
          ["+", '  const link = await findShareLink(c.req.param("token"));'],
          [" ", "  return streamFile(c, link.fileId);"],
        ],
      },
      facts: [
        [
          "shield",
          "Approving needs a reason. It goes in the audit log with your name.",
        ],
        ["link", "Links don’t expire and can be forwarded."],
        ["eye", "3 of GitOrange’s 5 projects are private."],
        ["redo", "If you request changes, Claude·s6 adds a sign-in check."],
      ],
      fix: "Require sign-in to download files unless the link is marked public.",
      why: "These links are marked public on purpose.",
      rule: "Links that are explicitly marked public may skip sign-in.",
      files: ["worker/src/files/share.ts", "src/pages/ProjectFiles.tsx"],
    },
    /* These two return when you undo one of Claude's answers. */
    {
      id: "ship70",
      agent: "shipping",
      pr: 70,
      session: "s4",
      wait: "now",
      p: 0.79,
      sha: "9c4f0a1",
      hidden: true,
      kept: true,
      kind: "Deploy step",
      title: "Email invoice reminders",
      short: "Deploy step, #70",
      approveLabel: "Mark as planned",
      head: "Add the EMAIL binding before deploying #70",
      approved:
        "Marked as planned. The EMAIL binding is on the #70 deploy checklist.",
      text: "Add the EMAIL binding before deploying #70, or reminder emails fail to send.",
      plain:
        "#70 sends invoice reminders through the EMAIL binding. If the binding is missing when #70 goes live, every reminder fails to send.",
      assess:
        "Mark as planned if the binding is in your wrangler.jsonc. It is already in the example config.",
      ex: {
        path: "wrangler.jsonc.example",
        diff: [["+", '"send_email": [{ "name": "EMAIL" }],']],
      },
      facts: [
        ["box", "One binding. No migration."],
        ["undo", "Claude marked this as planned at 12:02. You undid that."],
      ],
      fix: "Stop the deploy with a clear message when the EMAIL binding is missing.",
      why: "The binding is already in the example config.",
      rule: "Skip the deploy note when the binding is already in the example config.",
      files: ["worker/src/billing/reminders.ts"],
    },
    {
      id: "68",
      agent: "features",
      pr: 68,
      session: "s2",
      wait: "now",
      p: 0.66,
      sha: "5e81c2d",
      hidden: true,
      kept: true,
      title: "Rename Export to Download on invoices",
      short: "Export button, #68",
      head: "#68 renames Export to Download on invoices",
      text: "#68 renames the Export button on invoices to Download. People who look for Export may not find it.",
      plain:
        "#68 changes the label of the invoice page’s Export button to Download. The button stays in the same place and does the same thing.",
      assess:
        "Approve if the new label is clearer. People who look for Export may take a moment to find it.",
      ex: {
        head: ["", "Before", "After"],
        rows: [["Invoice page button", "Export", "Download"]],
      },
      facts: [
        [
          "layers",
          "Only the label changes. The file and its format stay the same.",
        ],
        ["undo", "Claude approved this at 11:31. You undid that."],
      ],
      fix: "Keep the word Export in the button’s tooltip.",
      why: "Download is clearer, and the button stays in the same place.",
      rule: "Renaming a button is fine when it stays in the same place and does the same thing.",
      files: ["src/pages/Invoice.tsx"],
    },
  ];
  const log = [
    {
      id: "l1",
      time: "12:02",
      restores: "ship70",
      text: "Claude marked Shipping’s deploy note on #70 as planned",
    },
    {
      id: "l2",
      time: "11:31",
      restores: "68",
      text: "Claude approved Features’ note on #68",
    },
  ];
  const modes = {},
    drafts = {},
    morph = {},
    selected = new Set(),
    fresh = new Set(),
    undoable = new Set();
  let current = null,
    focusAfter = "",
    busy = false;
  /* Receipts keep their Undo until you leave the page. */
  window.addEventListener("hashchange", () => undoable.clear());

  /* ---------- Helpers ---------- */
  const byId = (id) => items.find((v) => v.id === id);
  const live = (v) => !!v && !v.hidden && !v.done && !v.snoozed;
  const isOpen = (id) =>
    id === "owner" ? G.state.decision === "pending" : live(byId(id));
  const openIds = () =>
    (G.state.decision === "pending" ? ["owner"] : []).concat(
      items.filter(live).map((v) => v.id),
    );
  const guarded = (it) => GUARD.has(it.agent);
  const onFinding = () => G.current().id === "finding";
  const draft = (it) =>
    (drafts[it.id] = drafts[it.id] || {
      fix: it.fix,
      why: it.why,
      teach: true,
      reason: "",
      note: "",
    });
  const who = (it) => `${A[it.agent].name}’s finding on #${it.pr}`;
  const guardMsg = (it) =>
    `${A[it.agent].name} findings need a reason. Open it to decide.`;
  const href = (id) => (id === "owner" ? "#decision-72" : "#finding-" + id);
  const prRef = (n) =>
    n >= 72 && n <= 77
      ? `<button type="button" class="ap-pr ap-link" data-ap-act="pull" data-ap-pr="${n}" aria-label="Open pull request #${n}">#${n}</button>`
      : `<span class="ap-pr">#${n}</span>`;
  const robot = (id, st) =>
    H.mini(id, st, 34).replace(/data-state="[^"]*"/, 'data-state="idle"');
  const dot = (id) =>
    `<i class="ap-dot" style="--agent:${A[id].color}" aria-hidden="true"></i>`;
  const claudeTile = `<span class="mono-tile claude ap-tile-sm" aria-hidden="true">C</span>`;
  const btn = (act, id, label, cls = "", extra = "") =>
    `<button class="btn small ${cls}" type="button" data-ap-act="${act}" id="ap-b-${act}-${id}"${extra}>${label}</button>`;
  const ctxRules = (it) =>
    (A[it.agent].lessons || [])
      .map((l) => l.rule)
      .concat(
        items
          .filter((v) => v.agent === it.agent && v.done === "rule" && v !== it)
          .map((v) => v.rule),
      );
  const snap = (id) => {
    const el = document.getElementById("ap-item-" + id);
    morph[id] = el ? el.getBoundingClientRect().height : 0;
  };

  G.extraApprovals = () => items.filter(live).length;

  /* [robot state, icon, receipt line, undo label, toast] */
  function receipt(it) {
    const a = A[it.agent],
      s = G.SESSIONS[it.session],
      g = guarded(it);
    return {
      approve: [
        "clear",
        "check",
        g
          ? `Approved as ${draft(it).reason.toLowerCase()}. Recorded in the audit log.`
          : it.approved ||
            `You approved #${it.pr}. It goes in when its checks pass.`,
        "Undo",
        g
          ? "Approved. Reason recorded in the audit log."
          : `Approved #${it.pr}`,
      ],
      changes: [
        "asked",
        "redo",
        `Changes requested from ${s.label}. It picked this up.`,
        "Undo",
        `Changes requested from ${s.label}`,
      ],
      dismiss: [
        "clear",
        "x",
        `Dismissed for #${it.pr} only. ${a.name} will ask again next time.`,
        "Undo",
        "Dismissed once",
      ],
      rule: [
        "learned",
        "book",
        `${a.name} saved a rule. It’s now in ${a.repo} (commit ${it.sha}).`,
        "Revert",
        `Rule saved to ${a.repo}`,
      ],
      proposed: [
        "needs",
        "person",
        "Rule proposed: waiting for Cho to confirm.",
        "Withdraw",
        "Rule proposed. Cho needs to confirm it.",
      ],
    }[it.done];
  }
  function auditOf(it) {
    const a = A[it.agent];
    return {
      approve: [
        "approval",
        `Mahmoud approved ${who(it)}${guarded(it) ? `. Reason: ${draft(it).reason}${draft(it).note ? `. Note: ${draft(it).note}` : ""}` : ""}`,
      ],
      changes: [
        "changes",
        `Mahmoud requested changes on #${it.pr} from ${G.SESSIONS[it.session].label}`,
      ],
      dismiss: ["dismissal", `Mahmoud dismissed ${who(it)} once`],
      rule: [
        "rule",
        `Mahmoud dismissed ${who(it)}. ${a.name} saved a rule (commit ${it.sha})`,
      ],
      proposed: [
        "rule",
        `Mahmoud dismissed ${who(it)} and proposed a ${a.name} rule. Cho must confirm it`,
      ],
    }[it.done];
  }
  function announce(msg) {
    let el = document.getElementById("ap-announce");
    if (!el) {
      el = document.createElement("div");
      el.id = "ap-announce";
      el.className = "sr";
      el.setAttribute("aria-live", "polite");
      document.body.appendChild(el);
    }
    el.textContent = "";
    setTimeout(() => (el.textContent = msg), 40);
  }

  /* ---------- Shared markup ---------- */
  function diffHTML(it, compact, hide) {
    const add = `<div class="ap-line ap-add"><span aria-hidden="true">+</span><span><span class="sr">Added line: </span>${esc(it.rule)}</span></div>`;
    if (compact) return `<div class="ap-diff ap-diff-compact">${add}</div>`;
    const ctx = ["## Rules from people"]
      .concat(ctxRules(it))
      .map(
        (t) =>
          `<div class="ap-line ap-ctx"><span></span><span>${esc(t)}</span></div>`,
      )
      .join("");
    return `<figure class="ap-diff" id="ap-diff-${it.id}"${hide ? " hidden" : ""}>
      <figcaption class="ap-diff-path">${icon("file")}<span>${esc(A[it.agent].repo)} · AGENT.md</span></figcaption>${ctx}${add}</figure>`;
  }
  function excerptHTML(it) {
    const x = it.ex;
    if (x.diff)
      return `<figure class="ap-diff"><figcaption class="ap-diff-path">${icon("file")}<span>${esc(x.path)}</span></figcaption>${x.diff
        .map(
          ([s, t]) =>
            `<div class="ap-line ${s === "+" ? "ap-add" : s === "-" ? "ap-del" : "ap-ctx"}"><span aria-hidden="true">${s}</span><span>${s === "+" ? '<span class="sr">Added: </span>' : s === "-" ? '<span class="sr">Removed: </span>' : ""}${esc(t)}</span></div>`,
        )
        .join("")}</figure>`;
    const row = (r) =>
      `<tr>${r.map((c, i) => (i ? `<td>${esc(c)}</td>` : `<th scope="row">${esc(c)}</th>`)).join("")}</tr>`;
    return `<div class="ap-tablewrap"><table class="ap-table"><thead><tr>${x.head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${x.rows.map(row).join("")}</tbody></table></div>`;
  }

  function panelHTML(it, mode) {
    const a = A[it.agent],
      s = G.SESSIONS[it.session],
      d = draft(it),
      id = it.id,
      g = guarded(it);
    const cancel = btn("cancel", id, "Cancel", "quiet");
    if (mode === "changes")
      return `<div class="ap-panel" id="ap-panel-${id}">
        <label class="ap-label" for="ap-fix-${id}">Instruction for ${esc(s.label)}</label>
        <textarea class="ap-input" id="ap-fix-${id}" data-ap-draft="fix" rows="2">${esc(d.fix)}</textarea>
        <p class="ap-small">${esc(a.name)} drafted this. Edit it before sending.</p>
        <div class="ap-actions">${btn("send", id, `${icon("arrow")}Send to ${esc(s.label)}`, "primary")}${cancel}</div></div>`;
    if (mode === "dismiss")
      return `<div class="ap-panel" id="ap-panel-${id}">
        <label class="ap-label" for="ap-why-${id}">Reason</label>
        <textarea class="ap-input" id="ap-why-${id}" data-ap-draft="why" rows="2">${esc(d.why)}</textarea>
        <label class="ap-check" for="ap-teach-${id}"><input type="checkbox" id="ap-teach-${id}" data-ap-teach${d.teach ? " checked" : ""}>Save a rule so ${esc(a.name)} doesn’t ask again</label>
        ${diffHTML(it, false, !d.teach)}
        <p class="ap-small" id="ap-diffnote-${id}"${d.teach ? "" : " hidden"}>${g ? `${icon("person")}${esc(a.name)} rules need a second person. Cho confirms this one before it’s committed.` : `${esc(a.name)} commits this line with your reason. You can revert it from its repository.`}</p>
        <div class="ap-actions">${btn("dismiss", id, d.teach ? `${icon("book")}Dismiss and save a rule` : `${icon("x")}Dismiss`, "primary")}${btn("dismiss-once", id, "Dismiss once", "", d.teach ? "" : " hidden")}${cancel}</div></div>`;
    const radios = REASONS.map(
      ([r, help], i) =>
        `<label class="ap-radio" for="ap-reason-${id}-${i}"><input type="radio" id="ap-reason-${id}-${i}" name="ap-reason-${id}" value="${r}" data-ap-reason${d.reason === r ? " checked" : ""}><span><b>${r}</b><small>${help}</small></span></label>`,
    ).join("");
    return `<fieldset class="ap-panel" id="ap-panel-${id}">
      <legend class="ap-label">Reason for approving</legend>${radios}
      <label class="ap-label" for="ap-note-${id}">Note for the audit log <span class="muted">(optional)</span></label>
      <textarea class="ap-input" id="ap-note-${id}" data-ap-draft="note" rows="2">${esc(d.note)}</textarea>
      <p class="ap-small">${icon("shield")}Recorded in the audit log with your name and reason.</p>
      <div class="ap-actions">${btn("approve-reason", id, `${icon("check")}Approve`, "primary", d.reason ? "" : " disabled")}${cancel}</div></fieldset>`;
  }

  /* ---------- Approvals list ---------- */
  const doneRow = (id, rob, body, extra = "") =>
    `<li class="ap-item ap-done${extra}${fresh.has(id) ? " ap-fresh" : ""}" id="ap-item-${id}" data-ap-done="${id}"><span></span><div class="ap-lead">${rob}</div><div class="ap-body">${body}</div></li>`;
  const undoBtn = (id, label) =>
    `<button class="btn quiet small" type="button" data-ap-act="reopen" id="ap-b-reopen-${id}">${icon("undo")}${label}</button>`;

  function doneHTML(it) {
    const a = A[it.agent],
      [st, ic, line, undo] = receipt(it);
    const text =
      it.done === "rule"
        ? `${esc(a.name)} saved a rule. It’s now in ${esc(a.repo)} (commit <button type="button" class="ap-link ap-sha" data-ap-act="agent" data-ap-agent="${it.agent}" aria-label="Commit ${esc(it.sha)}, open ${esc(a.name)}">${esc(it.sha)}</button>).`
        : esc(line);
    return doneRow(
      it.id,
      robot(it.agent, st),
      `<div class="ap-rline"><p class="ap-receipt">${icon(ic)}<span>${text} <span class="ap-ctxt">${esc(a.name)} on #${it.pr}</span></span></p>
        <span class="ap-rbtns"><a class="btn quiet small" href="#finding-${it.id}">View</a>${undoable.has(it.id) ? undoBtn(it.id, undo) : ""}</span></div>
      ${it.done === "rule" || it.done === "proposed" ? diffHTML(it, true) : ""}`,
      ` ap-${it.done}`,
    );
  }

  function rowHTML(it) {
    if (it.done) return doneHTML(it);
    const a = A[it.agent],
      id = it.id,
      g = guarded(it),
      mode = g && modes[id] !== "changes" ? null : modes[id];
    const auto = G.state.delegate[it.agent] && !it.kept && !g;
    const cls =
      (current === id ? " ap-current" : "") +
      (selected.has(id) ? " ap-picked" : "") +
      (fresh.has(id) ? " ap-fresh" : "");
    const exp = (m) =>
      ` aria-expanded="${mode === m}" aria-controls="ap-panel-${id}"`;
    const lead = g
      ? `<span class="ap-lock" title="${esc(a.name)} findings can’t be bulk-approved">${icon("shield")}<span class="sr">${esc(a.name)} findings can’t be bulk-approved</span></span>`
      : `<label class="ap-pick" for="ap-pick-${id}"><input type="checkbox" id="ap-pick-${id}" data-ap-pick${selected.has(id) ? " checked" : ""}><span class="sr">Select ${esc(a.name)} on #${it.pr}</span></label>`;
    const acts = g
      ? btn(
          "m-changes",
          id,
          `${icon("redo")}Request changes`,
          "primary",
          exp("changes"),
        ) +
        `<a class="btn small" href="#finding-${id}">Review and decide${icon("arrow")}</a>`
      : btn(
          "approve",
          id,
          `${icon("check")}${esc(it.approveLabel || "Approve")}`,
          "primary",
        ) +
        btn(
          "m-changes",
          id,
          `${icon("redo")}Request changes`,
          "",
          exp("changes"),
        ) +
        btn("m-dismiss", id, `${icon("x")}Dismiss`, "", exp("dismiss"));
    return `<li class="ap-item${cls}" id="ap-item-${id}" data-ap-item="${id}" tabindex="-1" aria-labelledby="ap-t-${id}">
      ${lead}<div class="ap-lead">${robot(it.agent, "needs")}</div>
      <div class="ap-body">
        <div class="ap-top"><p class="ap-meta"><b>${esc(a.name)}</b> ${prRef(it.pr)} <a class="ap-title" href="#finding-${id}">${esc(it.title)}</a></p>
          <span class="ap-wait">${icon("clock")}<span class="sr">Waiting </span>${esc(it.wait)}</span></div>
        <p class="ap-text" id="ap-t-${id}">${esc(it.text)}</p>
        <p class="ap-by">${it.kind ? `<span class="ap-tag">${esc(it.kind)}</span>` : ""}${g ? `<span class="ap-tag">${icon("shield")}Needs a reason to approve</span>` : ""}${H.coderLink(it.session)}
          ${auto ? `<span class="ap-auto">${claudeTile}Claude will answer this at 12:30 unless you do</span>` : ""}
          ${it.kept ? `<span class="ap-auto">${icon("undo")}You undid Claude’s answer. This one waits for you.</span>` : ""}</p>
        <div class="ap-actions">${acts}${btn("snooze", id, `${icon("clock")}Remind me later`, "quiet")}</div>
        ${mode ? panelHTML(it, mode) : ""}
      </div></li>`;
  }

  function ownerHTML() {
    if (G.state.decision !== "pending")
      return doneRow(
        "owner",
        robot("data", G.state.taught ? "learned" : "clear"),
        `<div class="ap-rline"><p class="ap-receipt">${icon("check")}<span>You answered Data about #72. <span class="ap-ctxt">${esc(OUTCOME[G.state.decision] || "")}</span></span></p>
          <span class="ap-rbtns"><a class="btn quiet small" href="#decision-72">View</a></span></div>
        ${G.state.taught ? `<p class="ap-small">${icon("book")}Data saved a rule from your answer.</p>` : ""}`,
      );
    return `<li class="ap-item ap-owner${current === "owner" ? " ap-current" : ""}" id="ap-item-owner" data-ap-item="owner" tabindex="-1" aria-labelledby="ap-t-owner">
      <span class="ap-lock">${icon("person")}<span class="sr">Only you can answer this</span></span><div class="ap-lead">${robot("data", "needs")}</div>
      <div class="ap-body">
        <div class="ap-top"><p class="ap-meta"><b>Data</b> ${prRef(72)} <a class="ap-title" href="#decision-72">${esc(G.PULLS[72].title)}</a></p>
          <span class="ap-wait">${icon("clock")}<span class="sr">Waiting </span>3 h</span></div>
        <p class="ap-text ap-q" id="ap-t-owner">Were all your invoices so far in Canadian dollars?</p>
        <p class="ap-text ap-soft">Data is checking the invoice-currency change before it goes in. Existing invoices would be set to Canadian dollars.</p>
        <p class="ap-by"><span class="ap-tag ap-tag-accent">Needs your answer</span>${H.coderLink("s4")}</p>
        <div class="ap-actions">${btn("owner", "owner", `Answer${icon("arrow")}`, "primary")}</div>
      </div></li>`;
  }

  function sideHTML() {
    const toggles = DEL_ORDER.map((k) => {
      const a = A[k],
        locked = GUARD.has(k),
        on = !locked && !!G.state.delegate[k];
      return `<li><label class="ap-toggle${locked ? " is-locked" : ""}" for="ap-del-${k}">${dot(k)}
        <span class="ap-toggle-txt"><b>${esc(a.name)}</b><small>${locked ? "Always comes to you" : on ? "Claude answers" : "You answer"}</small></span>
        <input type="checkbox" role="switch" id="ap-del-${k}" data-ap-del="${k}"${on ? " checked" : ""}${locked ? " disabled" : ""}><span class="ap-switch" aria-hidden="true"></span></label></li>`;
    }).join("");
    const entries = log
      .map(
        (l) =>
          `<li><time class="ap-time">${l.time}</time><div class="ap-log-body"><p>${esc(l.text)}</p>${
            l.undone
              ? `<p class="ap-small">${icon("undo")}Undone. It’s back in your list.</p>`
              : `<p class="ap-log-foot"><span class="who">${claudeTile}by Claude for Mahmoud</span><button class="btn quiet small" type="button" data-ap-act="undo" data-ap-log="${l.id}" id="ap-undo-${l.id}">${icon("undo")}Undo</button></p>`
          }</div></li>`,
      )
      .join("");
    return `<aside class="ap-side" aria-label="Claude decisions">
      <section class="ap-box" aria-labelledby="ap-del-h">
        <div class="ap-box-head"><h2 id="ap-del-h">${claudeTile}Let Claude decide for you</h2></div>
        <p class="ap-side-lede">Claude can answer findings for you. Each decision is recorded as “by Claude for Mahmoud”, and you can undo it.</p>
        <ul class="ap-toggles" aria-label="Reviewers Claude answers for">${toggles}</ul>
        <p class="ap-note">Uses GitOrange moderator apps. Data and Security always come to you.</p>
      </section>
      <section class="ap-box" aria-labelledby="ap-log-h">
        <div class="ap-box-head"><h2 id="ap-log-h">What Claude did today</h2></div>
        <ol class="ap-log">${entries}</ol>
      </section></aside>`;
  }

  function listPage() {
    const n = G.approvalsCount(),
      picked = [...selected].filter(isOpen).length;
    const shown = items.filter((v) => !v.hidden && !v.snoozed),
      snoozed = items.filter((v) => !v.hidden && v.snoozed);
    const answered =
      items.filter((v) => !v.hidden && v.done).length +
      (G.state.decision === "pending" ? 0 : 1);
    const lede = n
      ? `${n} ${n === 1 ? "item needs" : "items need"} you. Your reviewers raised these for a person.`
      : "Nothing needs you. Your crew will ask when something does.";
    const keys = [
      ["j", "k", "move"],
      ["o", "open"],
      ["a", "approve"],
      ["r", "request changes"],
      ["d", "dismiss"],
      ["x", "select"],
      ["A", "approve selected"],
    ]
      .map(
        (k) =>
          `<li>${k
            .slice(0, -1)
            .map((c) => `<kbd>${c}</kbd>`)
            .join("")}<span>${k[k.length - 1]}</span></li>`,
      )
      .join("");
    const empty = n
      ? ""
      : `<div class="ap-empty" id="ap-empty" tabindex="-1">${H.avatar("clef", 56, "idle")}<div><p class="ap-empty-h">Nothing needs you.</p><p class="ap-small">Your crew will ask when something does.</p></div></div>`;
    const snz = snoozed.length
      ? `<section class="ap-box" aria-labelledby="ap-snz-h"><div class="ap-box-head"><h2 id="ap-snz-h">Snoozed <span class="ap-n">${snoozed.length}</span></h2></div>
        <ul class="ap-snz">${snoozed.map((it) => `<li data-ap-snz="${it.id}" id="ap-item-${it.id}"${fresh.has(it.id) ? ' class="ap-fresh"' : ""}>${dot(it.agent)}<p class="ap-meta"><b>${esc(A[it.agent].name)}</b> <span class="ap-pr">#${it.pr}</span> <a class="ap-title" href="#finding-${it.id}">${esc(it.title)}</a></p>${btn("unsnooze", it.id, `${icon("up")}Unsnooze`)}</li>`).join("")}</ul></section>`
      : "";
    return `<div class="ap">${H.pageHead({ crumbs: [["Home", "home"], ["Approvals"]], title: "Approvals", lede })}
      <ul class="ap-keys" aria-label="Keyboard shortcuts">${keys}</ul>
      <div class="ap-grid"><div class="ap-stack">
        <section class="ap-box" aria-labelledby="ap-list-h">
          <div class="ap-box-head">
            <h2 id="ap-list-h">Waiting on you <span class="ap-n">${n}</span>${answered ? `<span class="ap-n-done">${answered} answered</span>` : ""}</h2>
            <div class="ap-bulk" id="ap-bulk"${picked ? "" : " hidden"}><span id="ap-bulk-n">${picked} selected</span>
              <button class="btn quiet small" type="button" data-ap-act="clearsel">Clear</button>
              <button class="btn primary small" type="button" data-ap-act="bulk" id="ap-bulk-go">${icon("check")}Approve selected</button></div>
          </div>
          ${empty}<ol class="ap-list">${ownerHTML()}${shown.map(rowHTML).join("")}</ol>
        </section>${snz}</div>
        ${sideHTML()}
      </div></div>`;
  }

  /* ---------- Finding page ---------- */
  function nextAfter(id) {
    const ids = openIds().filter((x) => x !== id);
    return ids.length ? ids[0] : null;
  }
  function answerHTML(it) {
    const id = it.id,
      g = guarded(it),
      a = A[it.agent],
      mode = modes[id];
    const exp = (m) =>
      ` aria-expanded="${mode === m}" aria-controls="ap-panel-${id}"`;
    const acts = g
      ? btn(
          "m-changes",
          id,
          `${icon("redo")}Request changes`,
          "primary",
          exp("changes"),
        ) +
        btn(
          "m-approve",
          id,
          `${icon("check")}Approve with a reason`,
          "",
          exp("approve"),
        ) +
        btn("m-dismiss", id, `${icon("x")}Dismiss`, "", exp("dismiss"))
      : btn(
          "approve",
          id,
          `${icon("check")}${esc(it.approveLabel || "Approve")}`,
          "primary",
        ) +
        btn(
          "m-changes",
          id,
          `${icon("redo")}Request changes`,
          "",
          exp("changes"),
        ) +
        btn("m-dismiss", id, `${icon("x")}Dismiss`, "", exp("dismiss"));
    return `<section class="ap-answer panel" id="ap-answer-${id}" data-ap-item="${id}" tabindex="-1" aria-labelledby="ap-ans-h">
      <h2 id="ap-ans-h">Your answer</h2>
      ${g ? `<p class="ap-small">${icon("shield")}${esc(a.name)} findings can’t be approved in bulk. Approving needs a reason.</p>` : ""}
      <div class="ap-actions">${acts}</div>
      ${mode ? panelHTML(it, mode) : ""}
      <div class="ap-more">${btn("snooze", id, `${icon("clock")}Remind me later`, "quiet")}</div></section>`;
  }
  function outcomeHTML(it) {
    const id = it.id;
    if (it.snoozed)
      return `<section class="ap-outcome panel" id="ap-outcome" data-ap-done="${id}" tabindex="-1">${icon("clock")}<div><p><b>Snoozed.</b> It’s in the Snoozed group on Approvals and doesn’t count as waiting.</p>
        <div class="ap-actions">${btn("unsnooze", id, `${icon("up")}Unsnooze`, "primary")}<a class="btn small" href="#approvals">Back to Approvals</a></div></div></section>`;
    const [, ic, line] = receipt(it),
      nx = nextAfter(id);
    const next = nx
      ? `<a class="btn primary small" href="${href(nx)}">Next: ${esc(nx === "owner" ? "Data" : A[byId(nx).agent].name)} on #${nx === "owner" ? 72 : byId(nx).pr}${icon("arrow")}</a>`
      : `<a class="btn primary small" href="#approvals">Back to Approvals</a>`;
    return `<section class="ap-outcome panel ap-${it.done}" id="ap-outcome" data-ap-done="${id}" tabindex="-1">${icon(ic)}<div>
      <p><b>${esc(line)}</b></p>${it.done === "rule" || it.done === "proposed" ? diffHTML(it, true) : ""}
      <div class="ap-actions">${next}<button class="btn small" type="button" data-ap-act="reopen" id="ap-b-reopen-${id}">${icon("undo")}Change answer</button></div></div></section>`;
  }
  function findingPage(id) {
    const it = byId(id);
    if (!it || it.hidden)
      return H.pageHead({
        crumbs: [["Approvals", "approvals"], ["Not found"]],
        title: "Finding not found",
        lede: 'This finding isn’t waiting on anyone. <a href="#approvals">Back to Approvals</a>',
      });
    const a = A[it.agent];
    const pre = `<p class="ap-asker" style="--agent:${a.color}">${robot(it.agent, it.done ? receipt(it)[0] : "needs")}<span class="eyebrow">${esc(a.name)} is asking · GitOrange · #${it.pr}</span></p>`;
    const facts = it.facts
      .map(([ic, t]) => `<li>${icon(ic)}<span>${esc(t)}</span></li>`)
      .join("");
    return `<div class="ap">${H.pageHead({ crumbs: [["Approvals", "approvals"], [it.short]], title: it.head, pre })}
      <div class="ap-cols"><div class="ap-col">
        <p class="ap-plain">${esc(it.plain)}</p>
        <div class="ap-advice" style="--agent:${a.color}">${icon(a.icon)}<span><b>${esc(a.name)}’s assessment.</b> ${esc(it.assess)}</span></div>
        ${excerptHTML(it)}
        ${it.done || it.snoozed ? outcomeHTML(it) : answerHTML(it)}
      </div>
      <aside class="ap-col ap-aside">
        <section class="ap-box" aria-labelledby="ap-facts-h"><div class="ap-box-head"><h2 id="ap-facts-h">Before you answer</h2></div><ul class="ap-facts">${facts}</ul></section>
        <details class="ap-box ap-tech"${G.state.devOpen ? " open" : ""}><summary>${icon("sliders")}Technical details</summary><div class="ap-tech-body">
          <p>${H.coderLink(it.session)}</p>
          <p>${H.verdict(it.agent, it.done ? receipt(it)[0] : "needs", it.p)}</p>
          <p class="ap-small">Clef woke ${esc(a.name)} at ${H.pct(it.p)}. It wakes at ${H.pct(a.above)}.</p>
          <ul class="ap-files">${it.files.map((f) => `<li>${icon("file")}<span>${esc(f)}</span></li>`).join("")}</ul>
          <div class="ap-actions">${it.pr >= 72 && it.pr <= 77 ? `<a class="btn small" href="#pull-${it.pr}">Open #${it.pr}</a>` : ""}<a class="btn small quiet" href="#agent-${it.agent}">About ${esc(a.name)}</a></div>
        </div></details>
      </aside></div></div>`;
  }

  /* ---------- Actions ---------- */
  function grow(el, from) {
    if (!el || !el.animate || G.reduced) return;
    const to = el.getBoundingClientRect().height;
    if (Math.abs(to - from) < 2) return;
    el.style.overflow = "hidden";
    el.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 220,
      easing: "cubic-bezier(.2,0,0,1)",
    }).finished.then(
      () => (el.style.overflow = ""),
      () => {},
    );
  }
  function setCurrent(id, focus) {
    if (!id) return;
    current = id;
    H.$$(".ap-item.ap-current").forEach((e) =>
      e.classList.remove("ap-current"),
    );
    const el = document.getElementById("ap-item-" + id);
    if (!el) return;
    el.classList.add("ap-current");
    if (focus) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({
        block: "nearest",
        behavior: G.reduced ? "auto" : "smooth",
      });
    }
  }
  function setMode(id, mode, keep) {
    if (!live(byId(id))) return;
    const was = modes[id];
    modes[id] = keep || was !== mode ? mode : null;
    current = id;
    snap(id);
    G.rerender();
    const m = modes[id];
    const t = !m
      ? document.getElementById(`ap-b-m-${was || mode}-${id}`)
      : m === "changes"
        ? document.getElementById("ap-fix-" + id)
        : m === "dismiss"
          ? document.getElementById("ap-b-dismiss-" + id)
          : document.querySelector(`input[name="ap-reason-${id}"]`);
    if (!t) return;
    t.focus({ preventScroll: true });
    if (t.tagName === "TEXTAREA")
      t.setSelectionRange(t.value.length, t.value.length);
    setTimeout(
      () =>
        t.scrollIntoView({
          block: "nearest",
          behavior: G.reduced ? "auto" : "smooth",
        }),
      230,
    );
  }
  const closeMode = (id) => setMode(id, modes[id]);
  function togglePick(id, val) {
    const it = byId(id);
    if (!live(it) || guarded(it)) return;
    const on = val == null ? !selected.has(id) : val;
    on ? selected.add(id) : selected.delete(id);
    const el = document.getElementById("ap-item-" + id),
      cb = document.getElementById("ap-pick-" + id);
    if (el) el.classList.toggle("ap-picked", on);
    if (cb) cb.checked = on;
    const n = [...selected].filter(isOpen).length,
      bar = document.getElementById("ap-bulk");
    if (bar) {
      bar.hidden = !n;
      document.getElementById("ap-bulk-n").textContent = `${n} selected`;
    }
  }
  /* Every state-changing action: a pending button (600 ms, aria-busy), then the change. */
  async function run(b, label, fn) {
    if (busy || !b) return;
    busy = true;
    const box = b.closest(
      ".ap-item, .ap-answer, .ap-outcome, .ap-log li, .ap-snz li, .ap-box-head",
    );
    if (box) box.classList.add("ap-busy");
    const ok = await G.pending(b, label, 600);
    busy = false;
    if (box) box.classList.remove("ap-busy");
    if (ok) fn();
  }
  function moveOn(id) {
    if (current !== id) return;
    const ids = openIds(),
      i = ids.indexOf(id);
    current = ids[i + 1] || ids[i - 1] || null;
  }
  function resolve(id, kind, quiet) {
    const it = byId(id);
    if (!live(it)) return;
    snap(id);
    moveOn(id);
    it.done = kind;
    modes[id] = null;
    selected.delete(id);
    fresh.add(id);
    undoable.add(id);
    const [kindA, text] = auditOf(it),
      r = receipt(it);
    G.audit(kindA, text, { pr: it.pr, agent: it.agent });
    announce(r[2]);
    if (kind === "rule") G.state.learnedExtra = (G.state.learnedExtra || 0) + 1;
    if (quiet) return;
    focusAfter = onFinding()
      ? "ap-outcome"
      : current
        ? "ap-item-" + current
        : "ap-empty";
    G.toast(r[4], { icon: r[1], undo: () => reopen(id) });
    G.emit(kind === "rule" ? "learned" : "approvals");
  }
  function approveSelected() {
    const ids = [...selected].filter(isOpen);
    if (!ids.length) return;
    ids.forEach((id) => resolve(id, "approve", true));
    if (!isOpen(current)) current = openIds()[0] || null;
    focusAfter = current ? "ap-item-" + current : "ap-empty";
    G.toast(
      `Approved ${ids.length} ${ids.length === 1 ? "finding" : "findings"}`,
      {
        undo: () =>
          ids.forEach((id) => reopen(id, true)) || G.emit("approvals"),
      },
    );
    G.emit("approvals");
  }
  function reopen(id, quiet) {
    const it = byId(id);
    if (!it || !it.done) return;
    const was = it.done;
    snap(id);
    if (was === "rule")
      G.state.learnedExtra = Math.max(0, (G.state.learnedExtra || 0) - 1);
    G.audit(
      "undo",
      `Mahmoud reopened ${who(it)}${was === "rule" ? ". The rule was reverted" : was === "proposed" ? ". The rule proposal was withdrawn" : ""}`,
      { pr: it.pr, agent: it.agent },
    );
    it.done = null;
    undoable.delete(id);
    fresh.add(id);
    current = id;
    if (quiet) return;
    focusAfter = onFinding() ? "ap-answer-" + id : "ap-item-" + id;
    announce(
      was === "rule"
        ? `Reverted. ${A[it.agent].name} dropped the rule. The finding is back in your list.`
        : "Reopened. It’s back in your list.",
    );
    G.emit(was === "rule" ? "learned" : "approvals");
  }
  function snooze(id, on) {
    const it = byId(id);
    if (!it || it.done || !!it.snoozed === on) return;
    if (on) moveOn(id);
    it.snoozed = on;
    modes[id] = null;
    selected.delete(id);
    fresh.add(id);
    G.audit("snooze", `Mahmoud ${on ? "snoozed" : "unsnoozed"} ${who(it)}`, {
      pr: it.pr,
      agent: it.agent,
    });
    focusAfter = onFinding()
      ? on
        ? "ap-outcome"
        : "ap-answer-" + id
      : on
        ? current
          ? "ap-item-" + current
          : "ap-empty"
        : "ap-item-" + id;
    if (!on) current = id;
    if (on)
      G.toast("Snoozed. It’s in Snoozed on Approvals.", {
        icon: "clock",
        undo: () => snooze(id, false),
      });
    announce(on ? "Snoozed." : "Unsnoozed. It’s back in your list.");
    G.emit("approvals");
  }
  function undoLog(logId) {
    const l = log.find((x) => x.id === logId),
      it = l && byId(l.restores);
    if (!it || l.undone) return;
    l.undone = true;
    it.hidden = false;
    morph[it.id] = 0;
    fresh.add(it.id);
    current = it.id;
    focusAfter = "ap-item-" + it.id;
    G.audit("undo", `Mahmoud undid Claude’s answer on #${it.pr}`, {
      pr: it.pr,
      agent: it.agent,
    });
    announce("Undone. It’s back in your list.");
    G.emit("approvals");
  }

  function onClick(e) {
    const b = e.target.closest("[data-ap-act]");
    if (!b || busy) return;
    const row = b.closest("[data-ap-item], [data-ap-done], [data-ap-snz]");
    const id = row
        ? row.dataset.apItem || row.dataset.apDone || row.dataset.apSnz
        : "",
      it = byId(id),
      act = b.dataset.apAct;
    if (act === "owner") return G.ui.openFinding(72);
    if (act === "pull") return G.ui.openPull(Number(b.dataset.apPr));
    if (act === "agent") return G.ui.openAgent(b.dataset.apAgent);
    if (act.startsWith("m-")) return setMode(id, act.slice(2));
    if (act === "cancel") return closeMode(id);
    if (act === "clearsel")
      return [...selected].forEach((s) => togglePick(s, false));
    if (act === "approve")
      return run(
        b,
        it.approveLabel ? "Marking as planned…" : "Approving…",
        () => resolve(id, "approve"),
      );
    if (act === "approve-reason")
      return (
        draft(it).reason && run(b, "Approving…", () => resolve(id, "approve"))
      );
    if (act === "send") return run(b, "Sending…", () => resolve(id, "changes"));
    if (act === "dismiss-once")
      return run(b, "Dismissing…", () => resolve(id, "dismiss"));
    if (act === "dismiss") {
      const kind = !draft(it).teach
        ? "dismiss"
        : guarded(it)
          ? "proposed"
          : "rule";
      return run(
        b,
        {
          dismiss: "Dismissing…",
          proposed: "Proposing rule…",
          rule: "Saving rule…",
        }[kind],
        () => resolve(id, kind),
      );
    }
    if (act === "snooze") return run(b, "Snoozing…", () => snooze(id, true));
    if (act === "unsnooze")
      return run(b, "Unsnoozing…", () => snooze(id, false));
    if (act === "bulk") return run(b, "Approving…", approveSelected);
    if (act === "reopen")
      return run(
        b,
        { rule: "Reverting…", proposed: "Withdrawing…" }[it.done] ||
          "Reopening…",
        () => reopen(id),
      );
    if (act === "undo")
      return run(b, "Undoing…", () => undoLog(b.dataset.apLog));
  }
  function onChange(e) {
    const t = e.target,
      box = t.closest("[data-ap-item]"),
      id = box && box.dataset.apItem;
    if (t.matches("[data-ap-pick]")) return togglePick(id, t.checked);
    if (t.matches("[data-ap-reason]")) {
      draft(byId(id)).reason = t.value;
      document.getElementById("ap-b-approve-reason-" + id).disabled = false;
      return;
    }
    if (t.matches("[data-ap-del]")) {
      const k = t.dataset.apDel,
        name = A[k].name;
      G.state.delegate[k] = t.checked;
      G.audit(
        "delegation",
        t.checked
          ? `Mahmoud let Claude answer ${name}’s findings`
          : `Mahmoud took ${name}’s findings back from Claude`,
        { agent: k },
      );
      G.emit("delegate");
      return G.toast(
        t.checked
          ? `Claude now answers ${name}’s findings`
          : `${name}’s findings come to you`,
        { icon: t.checked ? "check" : "person" },
      );
    }
    if (t.matches("[data-ap-teach]")) {
      const on = (draft(byId(id)).teach = t.checked);
      ["ap-diff-", "ap-diffnote-", "ap-b-dismiss-once-"].forEach(
        (p) => (document.getElementById(p + id).hidden = !on),
      );
      document.getElementById("ap-b-dismiss-" + id).innerHTML = on
        ? `${icon("book")}Dismiss and save a rule`
        : `${icon("x")}Dismiss`;
    }
  }
  function onInput(e) {
    const t = e.target,
      f = t.dataset && t.dataset.apDraft;
    if (f) draft(byId(t.closest("[data-ap-item]").dataset.apItem))[f] = t.value;
  }
  function onFocusIn(e) {
    const li = e.target.closest && e.target.closest("li[data-ap-item]");
    if (li && li.dataset.apItem !== current)
      setCurrent(li.dataset.apItem, false);
  }

  document.addEventListener("keydown", (e) => {
    if (
      busy ||
      e.metaKey ||
      e.ctrlKey ||
      e.altKey ||
      document.querySelector("dialog[open]")
    )
      return;
    const t = e.target instanceof Element ? e.target : document.body,
      k = e.key;
    if (k === "Escape" && t.closest(".ap-panel")) {
      closeMode(t.closest("[data-ap-item]").dataset.apItem);
      return e.preventDefault();
    }
    if (location.hash !== "#approvals" || !document.querySelector(".ap-list"))
      return;
    if (
      t.matches(
        "textarea, select, [contenteditable], input:not([type=checkbox]):not([type=radio])",
      )
    )
      return;
    if (k === "Enter" && t.closest("button, a, input, label, summary")) return;
    const click = (id) => {
      const b = document.getElementById(id);
      if (b && !b.closest("[hidden]")) b.click();
    };
    const it = byId(current),
      g = it && guarded(it);
    if (k === "j" || k === "k") {
      const ids = openIds(),
        i = ids.indexOf(current);
      if (!ids.length) return;
      setCurrent(
        ids[
          i < 0
            ? 0
            : Math.max(0, Math.min(ids.length - 1, i + (k === "j" ? 1 : -1)))
        ],
        true,
      );
    } else if (k === "A") click("ap-bulk-go");
    else if (!current || !isOpen(current)) return;
    else if (
      k === "o" ||
      k === "Enter" ||
      (current === "owner" && (k === "a" || k === "r" || k === "d"))
    )
      G.ui.openFinding(current === "owner" ? 72 : current);
    else if (g && (k === "a" || k === "d" || k === "x"))
      G.toast(guardMsg(it), { icon: "shield" });
    else if (k === "a") click("ap-b-approve-" + current);
    else if (k === "r") setMode(current, "changes", true);
    else if (k === "d") setMode(current, "dismiss", true);
    else if (k === "x") togglePick(current);
    else return;
    e.preventDefault();
  });

  function paint(root, html) {
    if (!root.dataset.apBound) {
      root.dataset.apBound = "1";
      root.addEventListener("click", onClick);
      root.addEventListener("change", onChange);
      root.addEventListener("input", onInput);
      root.addEventListener("focusin", onFocusIn);
    }
    root.innerHTML = html;
    fresh.clear();
    Object.keys(morph).forEach((id) => {
      grow(document.getElementById("ap-item-" + id), morph[id]);
      delete morph[id];
    });
    if (!focusAfter) return;
    const el = document.getElementById(focusAfter);
    focusAfter = "";
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
    }
  }

  G.registerView("approvals", {
    title: "Approvals",
    skeleton: "list",
    render(root) {
      if (!current || !isOpen(current)) current = openIds()[0] || null;
      paint(root, listPage());
    },
  });
  G.registerView("finding", {
    navAs: "approvals",
    skeleton: "detail",
    title: (id) => (byId(id) && !byId(id).hidden ? byId(id).short : "Finding"),
    render(root, id) {
      paint(root, findingPage(id));
    },
  });
})();
