/* GitOrange mockup: the rest of the application. Repositories, the code browser (tree, files, README),
 * commits, Actions, Insights, repository settings, personal settings, site admin and profiles.
 * choyiny/gitorange uses real data from REPO_DATA; agent repositories are generated from the agents. */
(function () {
  "use strict";
  const { AGENTS, REPOS, PULLS, SESSIONS, state } = GO;
  const { $, esc, icon, pct, avatar, chip, verdict, coder, pageHead, spark } = GO.h;
  const D = window.REPO_DATA || {
    paths: [],
    entries: {},
    files: {},
    commits: [],
    branches: [],
    languages: [],
    details: {},
    sizes: {},
  };
  const NOW = Date.parse("2026-10-08T20:30:00Z");
  const LANG_COLOR = {
    TypeScript: "#3178c6",
    JavaScript: "#f1e05a",
    CSS: "#663399",
    SQL: "#e38c00",
    Shell: "#89e051",
    YAML: "#cb171e",
    HTML: "#e34c26",
    Python: "#3572a5",
    Dockerfile: "#384d54",
  };

  /* ---------- Helpers ---------- */
  function ago(iso) {
    const d = (NOW - Date.parse(iso)) / 1000;
    if (d < 90) return "just now";
    if (d < 3600) return `${Math.round(d / 60)} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    const days = Math.round(d / 86400);
    return days === 1
      ? "yesterday"
      : days < 31
        ? `${days} days ago`
        : new Date(iso).toLocaleDateString("en-CA", {
            month: "short",
            day: "numeric",
          });
  }
  const dayOf = (iso) =>
    new Date(iso).toLocaleDateString("en-CA", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: "America/Toronto",
    });
  const bytes = (n) =>
    n > 1024 * 1024
      ? `${(n / 1048576).toFixed(1)} MB`
      : n > 1024
        ? `${(n / 1024).toFixed(1)} KB`
        : `${n} bytes`;
  const repoOf = () => GO.currentRepo();
  const isMain = () => repoOf().name === "choyiny/gitorange";
  const initials = (n) =>
    n
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  const person = (name, size = 20) =>
    `<span class="pav" style="--s:${size}px" aria-hidden="true">${esc(initials(name))}</span>`;
  const claude = (c) =>
    c.coauthors && c.coauthors.some((x) => /claude/i.test(x));
  function authorLine(c) {
    return `<span class="authors">${person(c.author)}${claude(c) ? '<span class="mono-tile claude sm" title="Co-authored by Claude">C</span>' : ""}<b>${esc(c.author)}</b>${claude(c) ? '<span class="muted"> with Claude</span>' : ""}</span>`;
  }

  /* ---------- Agent repositories, generated from the agents ---------- */
  const KNOW = {
    data: "migrations.md",
    features: "surfaces.md",
    security: "owasp.md",
    shipping: "deploy.md",
  };
  function agentRepo(r) {
    const a = AGENTS[r.agent];
    const lessons = a.lessons || [];
    const agentMd = `---\nname: ${a.name} Agent\nbio: ${a.job}\ntrigger:\n  ask: ${a.wake}\n  above: ${a.above}\nengine: pass\n---\n\n# How ${a.name} reviews\n\n${a.looks.map((l) => `- ${l}`).join("\n")}\n\n## When to raise something\n\nRaise a finding for a person only when the change can lose data, expose something private, or break something people use. Otherwise request changes from the pull request's own agent, with an instruction it can follow.\n${lessons.length ? `\n## Rules learned from dismissals\n\n${lessons.map((l) => `- ${l.rule} (from #${l.pr}, ${l.sha})`).join("\n")}\n` : ""}`;
    const files = {
      "AGENT.md": agentMd,
      "knowledge/README.md": `# Knowledge\n\nMaterial ${a.name} reads when it reviews and can cite. At most 20 files or 64 KB are read, in path order.\n`,
      ["knowledge/" + KNOW[r.agent]]:
        `# ${a.name}: notes\n\n${a.looks.map((l) => `## ${l}\n\nWhat good looks like in this codebase, with links to examples.\n`).join("\n")}`,
    };
    const commits = lessons
      .map((l) => ({
        short: l.sha,
        subject: `Learn from #${l.pr}: ${l.plain}`,
        author: `${a.name} Agent`,
        date: "2026-10-08T15:30:00Z",
        coauthors: [],
      }))
      .concat([
        {
          short: "5a1c03e",
          subject: `Create ${a.name} Agent`,
          author: "Cho Yin Yong",
          date: "2026-10-05T21:00:00Z",
          coauthors: ["Claude"],
        },
      ]);
    return { files, commits, paths: Object.keys(files).concat(["avatar.png"]) };
  }

  /* ---------- Tree helpers ---------- */
  function children(dir) {
    if (!isMain()) {
      const g = agentRepo(repoOf()),
        prefix = dir ? dir + "/" : "";
      const kids = {};
      g.paths
        .filter((p) => p.startsWith(prefix))
        .forEach((p) => {
          const rest = p.slice(prefix.length),
            name = rest.split("/")[0];
          kids[name] = rest.includes("/") ? "dir" : kids[name] || "file";
        });
      return Object.entries(kids)
        .sort((a, b) =>
          a[1] !== b[1] ? (a[1] === "dir" ? -1 : 1) : a[0].localeCompare(b[0]),
        )
        .map(([n, k]) => [
          n,
          k,
          g.commits[0].subject,
          g.commits[0].date,
          g.commits[0].short,
        ]);
    }
    if (D.entries[dir]) return D.entries[dir];
    const prefix = dir ? dir + "/" : "",
      kids = {};
    D.paths
      .filter((p) => p.startsWith(prefix))
      .forEach((p) => {
        const rest = p.slice(prefix.length),
          name = rest.split("/")[0];
        if (rest.includes("/")) kids[name] = "dir";
        else if (!kids[name]) kids[name] = "file";
      });
    return Object.entries(kids)
      .sort((a, b) =>
        a[1] !== b[1] ? (a[1] === "dir" ? -1 : 1) : a[0].localeCompare(b[0]),
      )
      .map(([n, k]) => [n, k, "", "", ""]);
  }
  function pathCrumbs(path, isFile) {
    const parts = path ? path.split("/") : [];
    const r = repoOf();
    return `<nav class="pathbar" aria-label="Path"><a href="#code"><b>${esc(r.repo)}</b></a>${parts
      .map((p, i) => {
        const sub = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return `<span class="sep">/</span>${last ? `<b>${esc(p)}</b>` : `<a href="#tree-${sub}">${esc(p)}</a>`}`;
      })
      .join("")}${isFile ? "" : '<span class="sep">/</span>'}</nav>`;
  }
  function fileTable(dir) {
    const rows = children(dir);
    const latest = isMain() ? D.commits[0] : agentRepo(repoOf()).commits[0];
    const head = `<div class="ft-head">${isMain() ? authorLine(latest) : `<span class="authors">${person(latest.author)}<b>${esc(latest.author)}</b></span>`}<a class="ft-msg" href="#commit-${latest.short}">${esc(latest.subject)}</a><span class="ft-meta"><span class="mono">${esc(latest.short)}</span> · ${ago(latest.date)}</span><a class="ft-count" href="#commits">${icon("clock")}<b>${isMain() ? D.commitCount : agentRepo(repoOf()).commits.length}</b> commits</a></div>`;
    const up = dir
      ? `<tr><td colspan="3"><a class="ft-name" href="#${dir.includes("/") ? "tree-" + dir.split("/").slice(0, -1).join("/") : "code"}">${icon("folder")}..</a></td></tr>`
      : "";
    return `<div class="filetable panel">${head}<table class="ft"><tbody>${up}${rows
      .map(([name, kind, subj, date, sha]) => {
        const p = dir ? `${dir}/${name}` : name;
        return `<tr><td class="ft-namecell"><a class="ft-name" href="#${kind === "dir" ? "tree-" : "blob-"}${p}">${icon(kind === "dir" ? "folder" : "file", "icon " + kind)}${esc(name)}</a></td><td class="ft-subj">${subj ? `<a href="#commit-${esc(sha)}">${esc(subj)}</a>` : ""}</td><td class="ft-date">${date ? ago(date) : ""}</td></tr>`;
      })
      .join("")}</tbody></table></div>`;
  }

  /* ---------- A small Markdown renderer for READMEs and docs ---------- */
  function inline(t) {
    let s = esc(t);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
      .replace(/_([^_]+)_/g, "<i>$1</i>");
    s = s.replace(
      /!\[([^\]]*)\]\([^)]+\)/g,
      '<span class="md-img">[image: $1]</span>',
    );
    s = s.replace(
      /\[([^\]]+)\]\((https?:[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, txt, href) =>
      href.startsWith("#")
        ? `<span class="md-link">${txt}</span>`
        : `<a href="#blob-${href.replace(/^\.\//, "")}">${txt}</a>`,
    );
    return s;
  }
  function markdown(src) {
    const lines = src
      .replace(/<[^>]+>/g, (m) => (/^<img/i.test(m) ? "" : ""))
      .split("\n");
    let out = "",
      i = 0,
      list = null,
      para = [];
    const flush = () => {
      if (para.length) {
        out += `<p>${inline(para.join(" "))}</p>`;
        para = [];
      }
    };
    const endList = () => {
      if (list) {
        out += `</${list}>`;
        list = null;
      }
    };
    while (i < lines.length) {
      const l = lines[i];
      if (/^```/.test(l)) {
        flush();
        endList();
        const lang = l.slice(3).trim();
        let code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i]))
          code.push(lines[i++]);
        i++;
        out += `<pre class="md-code${lang === "mermaid" ? " mermaid-src" : ""}"><code>${esc(code.join("\n"))}</code></pre>`;
        continue;
      }
      const h = l.match(/^(#{1,4})\s+(.*)/);
      if (h) {
        flush();
        endList();
        out += `<h${h[1].length + 1} class="md-h">${inline(h[2])}</h${h[1].length + 1}>`;
        i++;
        continue;
      }
      if (/^\|.*\|\s*$/.test(l)) {
        flush();
        endList();
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) =>
          r
            .trim()
            .slice(1, -1)
            .split("|")
            .map((c) => c.trim());
        const body = rows.filter((r) => !/^\|\s*:?-{2,}/.test(r));
        out += `<div class="md-table"><table><thead><tr>${cells(body[0])
          .map((c) => `<th>${inline(c)}</th>`)
          .join("")}</tr></thead><tbody>${body
          .slice(1)
          .map(
            (r) =>
              `<tr>${cells(r)
                .map((c) => `<td>${inline(c)}</td>`)
                .join("")}</tr>`,
          )
          .join("")}</tbody></table></div>`;
        continue;
      }
      const li = l.match(/^\s*([-*]|\d+\.)\s+(.*)/);
      if (li) {
        flush();
        const t = /\d/.test(li[1]) ? "ol" : "ul";
        if (list !== t) {
          endList();
          out += `<${t}>`;
          list = t;
        }
        let item = li[2];
        i++;
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]) &&
          !/^\s*([-*]|\d+\.)\s/.test(lines[i])
        )
          item += " " + lines[i++].trim();
        out += `<li>${inline(item)}</li>`;
        continue;
      }
      if (!l.trim()) {
        flush();
        endList();
        i++;
        continue;
      }
      endList();
      para.push(l.trim());
      i++;
    }
    flush();
    endList();
    return out;
  }

  /* ---------- Code view with light highlighting ---------- */
  const KW =
    /\b(const|let|var|function|return|if|else|for|while|export|import|from|type|interface|async|await|new|class|extends|true|false|null|undefined|default|case|switch|break|throw|try|catch|of|in)\b/g;
  function highlight(line, ext) {
    const hashComments = /^(yml|yaml|sh|toml|py)$/.test(ext);
    if (/^\s*(\/\*|\*|\*\/)/.test(line)) return `<span class="tk-c">${esc(line)}</span>`;
    let code = line,
      comment = "";
    const ci = hashComments ? line.search(/(^|\s)#/) : line.indexOf("//");
    if (ci >= 0 && !/https?:$/.test(line.slice(0, ci))) {
      code = line.slice(0, ci);
      comment = line.slice(ci);
    }
    const parts = code.split(
      /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/,
    );
    const body = parts
      .map((p, i) =>
        i % 2
          ? `<span class="tk-s">${esc(p)}</span>`
          : (/^(ts|tsx|js|mjs|jsonc)$/.test(ext)
              ? esc(p).replace(KW, '<span class="tk-k">$1</span>')
              : esc(p)
            ).replace(/\b(\d+(\.\d+)?)\b/g, '<span class="tk-n">$1</span>'),
      )
      .join("");
    return body + (comment ? `<span class="tk-c">${esc(comment)}</span>` : "");
  }
  function codeView(path, text) {
    const ext = (path.split(".").pop() || "").toLowerCase();
    const lines = text.split("\n");
    return `<div class="codeview"><table class="code-t"><tbody>${lines.map((l, i) => `<tr><td class="ln" data-n="${i + 1}"></td><td class="lc">${highlight(l, ext) || " "}</td></tr>`).join("")}</tbody></table></div>`;
  }

  /* =====================================================================
   * REPOSITORIES: a status board. What needs you, what's in flight, what merged, and who reviews.
   * ===================================================================== */
  let repoQuery = '', repoFilter = 'all', repoSort = 'updated';
  function commitsPerDay() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.parse('2026-10-08T16:00:00-04:00') - i * 86400000);
      const key = d.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' });
      days.push({ key, label: d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Toronto' }), n: 0 });
    }
    D.commits.forEach(c => { const k = new Date(c.date).toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); const d = days.find(x => x.key === k); if (d) d.n++; });
    return days;
  }
  function stateBar() {
    const counts = { needs: 0, asked: 0, reviewing: 0, clear: 0 };
    Object.keys(PULLS).map(Number).filter(n => !(GO.state.landed || []).includes(n)).forEach(n => {
      const lane = n === 72 ? (GO.state.decision === 'pending' || GO.state.decision === 'askedCho' ? 'person' : GO.state.decision === 'fix' ? 'agent' : 'ready') : PULLS[n].lane;
      counts[{ person: 'needs', agent: 'asked', checking: 'reviewing', ready: 'clear' }[lane]]++;
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0) || 1;
    const segs = [['needs', 'Needs a person'], ['asked', 'Changes requested'], ['reviewing', 'Checking'], ['clear', 'Queued']];
    return `<div class="sbar" role="img" aria-label="${segs.map(([k, l]) => `${counts[k]} ${l.toLowerCase()}`).join(', ')}">${segs.filter(([k]) => counts[k]).map(([k, l]) => `<i class="sb-${k}" style="flex:${counts[k]}" title="${counts[k]} ${l.toLowerCase()}"></i>`).join('')}</div>
      <div class="sbar-key">${segs.filter(([k]) => counts[k]).map(([k, l]) => `<span><i class="sb-${k}"></i>${counts[k]} ${l.toLowerCase()}</span>`).join('')}</div>`;
  }
  function codeRow(r) {
    const days = commitsPerDay(), total = days.reduce((a, d) => a + d.n, 0);
    const pending = GO.state.decision === 'pending';
    const f = GO.extraApprovals ? GO.extraApprovals() : 0;
    return `<li class="rrow2">
      <div class="rr-id">
        <a class="rl-name" href="#repo-${r.name.replace('/', '~')}">${icon('repo')}<span class="mono">${esc(r.owner)}/</span><b>${esc(r.repo)}</b></a> <span class="vis">${esc(r.visibility)}</span>
        <p class="muted">${esc(r.description)}</p>
        <p class="rl-meta"><span><i class="lang" style="--lc:${LANG_COLOR[r.language] || '#8b949e'}"></i>${esc(r.language)}</span><span>${icon('branch')}${D.branches.length} branches</span><span>Updated ${esc(ago(D.commits[0].date))}</span></p>
        <div class="rr-crew">${['security', 'data', 'features', 'shipping'].map(id => `<a href="#agent-${id}" title="${esc(AGENTS[id].name)}">${avatar(id, 40, 'idle')}</a>`).join('')}<span class="muted small">4 reviewers</span></div>
      </div>
      <div class="rr-flow">
        <span class="eyebrow">In flight</span>
        <b class="rr-big">${Object.keys(PULLS).length - (GO.state.landed || []).length} <span>open pull requests</span></b>
        ${stateBar()}
      </div>
      <div class="rr-week">
        <span class="eyebrow">Merged, last 7 days</span>
        <b class="rr-big">${total} <span>commits on main</span></b>
        ${spark(days.map(d => d.n), { w: 150, h: 34, label: 'Commits on main per day, last 7 days', labels: days.map(d => d.label), unit: ' commits', cls: 'better' })}
        <span class="muted small">84% merged with no merge click</span>
      </div>
      <div class="rr-health">
        ${pending ? chip('needs', '1 decision for you') : chip('clear', 'Healthy')}
        ${pending ? `<a class="small" href="#decision-72">Answer Data about #72</a>` : ''}
        ${f ? `<a class="small" href="#approvals">${f} developer finding${f === 1 ? '' : 's'}</a>` : ''}
        <span class="small">${icon('check', 'icon ok')}Tests on main passing</span>
        <span class="small">${icon('shield', 'icon ok')}0 changes overwritten</span>
        <span class="rr-actions"><a class="btn small" href="#branches">${icon('branch')}Branch map</a><a class="btn small primary" href="#repo-${r.name.replace('/', '~')}">Open</a></span>
      </div>
    </li>`;
  }
  function agentRow(r) {
    const a = AGENTS[r.agent], t = a.track || {}, lessons = a.lessons || [];
    const on = GO.state.crew.gitorange.includes(r.agent) && !GO.state.reviewerOff[r.agent];
    return `<li class="rrow2 agentrepo" style="--agent:${a.color}">
      <div class="rr-id rr-agent">
        <a href="#agent-${r.agent}">${avatar(r.agent, 56, on ? 'idle' : 'off')}</a>
        <span><a class="rl-name" href="#repo-${r.name.replace('/', '~')}"><span class="mono">${esc(r.owner)}/</span><b>${esc(r.repo)}</b></a> <span class="vis">Agent instructions</span>
        <p class="muted">${esc(a.job)}</p>
        <p class="rl-meta"><span>${icon('file')}AGENT.md and knowledge/</span><span>Updated ${esc(r.updated)}</span></p></span>
      </div>
      <div class="rr-flow">
        <span class="eyebrow">Reviews</span>
        <b class="rr-big">${t.raised || 0} <span>raised this week</span></b>
        <span class="small">${t.raised ? `${pct((t.raised - t.setAside) / t.raised)} kept · ${t.setAside} dismissed` : 'No reviews yet'}</span>
        <span class="small muted">${on ? 'On choyiny/gitorange' : 'Not on a repository'}</span>
      </div>
      <div class="rr-week">
        <span class="eyebrow">Learned</span>
        <b class="rr-big">${lessons.length} <span>rule${lessons.length === 1 ? '' : 's'}</span></b>
        <span class="small">${lessons.length ? esc(lessons[0].plain) : 'Nothing yet. Rules appear when a person dismisses a request.'}</span>
      </div>
      <div class="rr-health">
        ${on ? chip('clear', 'On duty') : chip('off', 'Off')}
        <span class="rr-actions"><a class="btn small" href="#agent-${r.agent}">Profile</a><a class="btn small primary" href="#repo-${r.name.replace('/', '~')}">Open</a></span>
      </div>
    </li>`;
  }
  GO.registerView('repos', {
    title: 'Repositories', skeleton: 'list',
    render(root) {
      const match = r => !repoQuery || (r.name + ' ' + r.description).toLowerCase().includes(repoQuery.toLowerCase());
      const needs = r => r.kind === 'code' && (GO.state.decision === 'pending' || (GO.extraApprovals && GO.extraApprovals()));
      let list = REPOS.filter(match).filter(r => repoFilter === 'all' || (repoFilter === 'attention' ? needs(r) : r.kind === repoFilter));
      if (repoSort === 'name') list = list.slice().sort((a, b) => a.repo.localeCompare(b.repo));
      const code = list.filter(r => r.kind === 'code'), agents = list.filter(r => r.kind === 'agent');
      const open = Object.keys(PULLS).length - (GO.state.landed || []).length;
      const n = GO.approvalsCount();
      const pills = [['all', 'All', REPOS.length], ['attention', 'Needs attention', REPOS.filter(needs).length], ['code', 'Code', REPOS.filter(r => r.kind === 'code').length], ['agent', 'Agent instructions', REPOS.filter(r => r.kind === 'agent').length]];
      root.innerHTML = `
        ${pageHead({ crumbs: [['Repositories']], title: 'Repositories', icon: 'repo', lede: 'Everything on git.xyspace.dev you can see: your code, and the repositories where each reviewer agent keeps its instructions.', actions: `<a class="btn primary" href="#new">${icon('plus')}New repository</a>` })}
        <div class="stats">
          <a class="stat link" href="#approvals"><b>${n}</b><span>need${n === 1 ? 's' : ''} you</span></a>
          <div class="stat"><b>${open}</b><span>open pull requests</span></div>
          <div class="stat"><b>67</b><span>merged this week</span></div>
          <div class="stat"><b>0</b><span>changes overwritten</span></div>
          <div class="stat"><b>${REPOS.length}</b><span>repositories</span></div>
        </div>
        <div class="toolbar"><label class="sr" for="repo-q">Find a repository</label><input id="repo-q" type="search" placeholder="Find a repository…" value="${esc(repoQuery)}">
          <span class="pills" role="group" aria-label="Filter">${pills.map(([v, l, c]) => `<button type="button" class="pill" data-rfilter="${v}" aria-pressed="${repoFilter === v}">${esc(l)} <span class="count">${c}</span></button>`).join('')}</span>
          <label class="sr" for="repo-sort">Sort</label><select id="repo-sort"><option value="updated" ${repoSort === 'updated' ? 'selected' : ''}>Recently updated</option><option value="name" ${repoSort === 'name' ? 'selected' : ''}>Name</option></select></div>
        ${code.length ? `<section class="section"><div class="section-head"><h2>Code</h2></div><ul class="rlist2 panel">${code.map(codeRow).join('')}</ul></section>` : ''}
        ${agents.length ? `<section class="section"><div class="section-head"><h2>Reviewer instructions</h2><span class="muted small">Each reviewer agent reads its instructions from its own repository. Dismissing one of its requests adds a rule here.</span></div><ul class="rlist2 panel">${agents.map(agentRow).join('')}</ul></section>` : ''}
        ${!code.length && !agents.length ? '<div class="panel pad"><p class="muted">No repositories match.</p></div>' : ''}`;
    }
  });
  document.addEventListener('click', e => { const t = e.target.closest('[data-rfilter]'); if (!t) return; repoFilter = t.dataset.rfilter; GO.rerender(); });
  document.addEventListener('change', e => { if (e.target.id === 'repo-sort') { repoSort = e.target.value; GO.rerender(); } });

  /* =====================================================================
   * NEW REPOSITORY
   * ===================================================================== */
  const newRepo = { owner: "mahmoud", name: "", created: false };
  GO.registerView("new", {
    title: "New repository",
    skeleton: "detail",
    render(root) {
      root.innerHTML = `
        ${pageHead({ crumbs: [["Repositories", "repos"], ["New repository"]], title: "Create a repository", icon: "plus", lede: "Git storage lives in Cloudflare Artifacts. Reviewer agents you add here start reviewing the first pull request." })}
        <div class="cols"><div class="col">
          ${
            newRepo.created
              ? `<div class="outcome panel"><h2>Created ${esc(newRepo.owner)}/${esc(newRepo.name)}</h2><p>Push your code with a personal access token as the password:</p>
            <pre class="code mono">git remote add origin https://git.xyspace.dev/${esc(newRepo.owner)}/${esc(newRepo.name)}.git\ngit push -u origin main</pre>
            <div class="actions"><a class="btn primary" href="#repos">Go to Repositories</a><a class="btn" href="#settings-tokens">Create a token</a></div></div>`
              : `<form class="form panel" id="newrepo" autocomplete="off">
            <div class="row2"><div><label for="nr-owner">Owner</label><select id="nr-owner"><option value="mahmoud">mahmoud</option><option value="xyspace">xyspace (team)</option></select></div>
              <div><label for="nr-name">Repository name</label><input id="nr-name" required placeholder="for example: client-portal" value="${esc(newRepo.name)}"></div></div>
            <label for="nr-desc">Description <span class="muted">(optional)</span></label><input id="nr-desc">
            <fieldset class="radios stack"><legend>Visibility</legend>
              <label><input type="radio" name="nr-vis" value="private" checked> <span><b>Private</b><br><span class="muted small">You, collaborators and site admins.</span></span></label>
              <label><input type="radio" name="nr-vis" value="internal"> <span><b>Internal</b><br><span class="muted small">Everyone on git.xyspace.dev can read it. Team repositories are always internal.</span></span></label></fieldset>
            <fieldset class="checks"><legend>Reviewer agents</legend>${["security", "data", "features", "shipping", "speed", "reliability", "privacy"].map((id) => `<label><input type="checkbox" name="nr-agent" value="${id}" ${["security", "data", "features", "shipping"].includes(id) ? "checked" : ""}> <span class="adot" style="--agent:${AGENTS[id].color}"><i></i>${esc(AGENTS[id].name)}</span> <span class="muted small">${esc(AGENTS[id].job)}</span></label>`).join("")}</fieldset>
            <label class="inline-check"><input type="checkbox" id="nr-readme" checked> Add a README</label>
            <div class="actions"><button class="btn primary" type="submit" id="nr-go">Create repository</button></div>
          </form>`
          }
        </div><aside class="col side"><section class="panel pad"><h2>What you get</h2><ul class="ticks">
          <li>${icon("check", "icon ok")}Rebase-only merges with compare-and-swap on main</li>
          <li>${icon("check", "icon ok")}Auto-merge when checks pass and reviewers approve</li>
          <li>${icon("check", "icon ok")}Actions on Cloudflare Containers, running your existing workflows</li>
          <li>${icon("check", "icon ok")}An audit log of every merge and every decision</li></ul></section></aside></div>`;
    },
  });

  /* =====================================================================
   * CODE: repository home, tree and file views
   * ===================================================================== */
  function codeSidebar() {
    const r = repoOf();
    if (!isMain()) {
      const a = AGENTS[r.agent];
      return `<aside class="col side"><section class="panel pad"><h2>About</h2><p>${esc(r.description)}</p><p><a href="#agent-${r.agent}">${avatar(r.agent, 40, "idle")} ${esc(a.name)} reviewer</a></p><p class="muted small">Changes to these files change how ${esc(a.name)} reviews. They go through pull requests like any other change, and dismissals add rules here automatically.</p></section></aside>`;
    }
    const langBar = `<div class="langbar" role="img" aria-label="Languages">${D.languages.map(([l, p]) => `<i style="width:${p}%;background:${LANG_COLOR[l] || "#8b949e"}" title="${esc(l)} ${p}%"></i>`).join("")}</div><ul class="langs">${D.languages.map(([l, p]) => `<li><i class="lang" style="--lc:${LANG_COLOR[l] || "#8b949e"}"></i><b>${esc(l)}</b> <span class="muted">${p}%</span></li>`).join("")}</ul>`;
    return `<aside class="col side">
      <section class="panel pad"><h2>About</h2><p>${esc(r.description)}</p>
        <div class="topics">${["cloudflare", "workers", "artifacts", "ai-agents", "code-review", "merge-queue"].map((t) => `<span class="topic">${t}</span>`).join("")}</div>
        <ul class="ticks small"><li>${icon("book")}<a href="#blob-README.md">Readme</a></li><li>${icon("shield")}<a href="#blob-LICENSE">Apache-2.0 license</a></li><li>${icon("branch")}<a href="#branches">${D.branches.length} branches</a></li></ul></section>
      <section class="panel pad"><h2>Health</h2>${GO.state.decision === "pending" ? chip("needs", "1 decision for you") : chip("clear", "Healthy")}<p class="small">67 merged this week, 56 with no one involved.</p><a class="btn small" href="#project">${icon("pulse")}Open Health</a></section>
      <section class="panel pad"><h2>Reviewer agents</h2><div class="agentstack">${["security", "data", "features", "shipping"].map((id) => `<a href="#agent-${id}" title="${esc(AGENTS[id].name)}">${avatar(id, 44, "idle")}</a>`).join("")}</div><a class="small" href="#rsettings-agents">Manage</a></section>
      <section class="panel pad"><h2>Languages</h2>${langBar}</section>
      <section class="panel pad"><h2>Contributors</h2><ul class="plain">${D.contributors.map(([n, c]) => `<li class="contrib">${person(n, 22)}<b>${esc(n)}</b><span class="muted small">${c} commits</span></li>`).join("")}<li class="contrib"><span class="mono-tile claude">C</span><b>Claude</b><span class="muted small">co-author on ${D.commits.filter(claude).length} of the last ${D.commits.length}</span></li></ul></section>
    </aside>`;
  }
  function codeTop(dir) {
    const r = repoOf();
    return `<div class="codebar">
      <span class="branchsel"><label class="sr" for="branch-sel">Branch</label>${icon("branch")}<select id="branch-sel"><option>main</option>${
        isMain()
          ? D.branches
              .filter((b) => b.name !== "main")
              .map((b) => `<option>${esc(b.name)}</option>`)
              .join("")
          : ""
      }</select></span>
      ${isMain() ? `<a class="btn small quiet" href="#branches">${icon("branch")}<b>${D.branches.length}</b> branches</a><a class="btn small" href="#branches">${icon("branch")}Branch map</a>` : ""}
      <span class="grow"></span>
      <button class="btn small" type="button" id="goto-file">${icon("search")}Go to file</button>
      <span class="clone-wrap"><button class="btn small primary" type="button" id="clone-open" aria-expanded="false">${icon("code")}Code${icon("down")}</button>
        <div class="ws-menu right clone-menu" id="clone-menu" hidden><div class="dd-label">Clone with HTTPS</div>
          <div class="clone-url"><input readonly id="clone-url" value="https://git.xyspace.dev/${esc(r.name)}.git"><button class="btn small" type="button" id="copy-clone" aria-label="Copy clone URL">${icon("copy")}</button></div>
          <p class="small muted pad-x">Use a personal access token as the password. <a href="#settings-tokens">Create one</a>. Large files use Git LFS, stored in R2.</p></div></span>
    </div>`;
  }
  function healthStrip() {
    if (!isMain() || GO.state.decision !== "pending") return "";
    return `<a class="strip-link" href="#decision-72">${avatar("data", 32, "needs")}<span><b>Data needs your answer</b> before #72 merges: were all your invoices so far in Canadian dollars?</span>${icon("arrow")}</a>`;
  }
  function renderCode(root, dir) {
    const r = repoOf();
    const readmePath = isMain() ? "README.md" : "AGENT.md";
    const readme = isMain()
      ? (D.files["README.md"] || {}).text || ""
      : agentRepo(r).files["AGENT.md"];
    root.innerHTML = `
      ${pageHead({ crumbs: [["repo"], [dir ? dir.split("/").pop() : "Code"]], title: dir ? dir : r.repo, tab: "code", icon: "code", lede: dir ? "" : esc(r.description) })}
      ${healthStrip()}
      <div class="cols"><div class="col">
        ${codeTop(dir)}
        ${dir ? pathCrumbs(dir, false) : ""}
        ${fileTable(dir)}
        ${!dir ? `<section class="readme panel"><div class="readme-head">${icon("book")}<b>${readmePath}</b></div><div class="md">${isMain() ? '<div class="md-logo"><svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="35" r="26" fill="#f6821f"/><path d="M32 9c2-4 8-6 12-4-2 4-6 6-12 4z" fill="#3fb950"/></svg><b>GitOrange</b></div>' : ""}${markdown(readme)}</div></section>` : ""}
      </div>${dir ? "" : codeSidebar()}</div>`;
  }
  GO.registerView("repo", {
    title: (p) => (p || "").replace("~", "/"),
    navAs: "repo",
    skeleton: "detail",
    loadMs: 200,
    render(root, param) {
      const name = (param || "").replace("~", "/");
      if (REPOS.some((r) => r.name === name)) GO.state.repo = name;
      renderCode(root, "");
    },
  });
  GO.registerView("code", {
    title: () => repoOf().name,
    navAs: "repo",
    skeleton: "detail",
    render(root) {
      renderCode(root, "");
    },
  });
  GO.registerView("tree", {
    title: (p) => p,
    navAs: "repo",
    skeleton: "list",
    render(root, p) {
      renderCode(root, p || "");
    },
  });
  GO.registerView("blob", {
    title: (p) => (p || "").split("/").pop(),
    navAs: "repo",
    skeleton: "detail",
    render(root, path) {
      const r = repoOf();
      const gen = isMain() ? null : agentRepo(r);
      const f = isMain()
        ? D.files[path]
        : gen.files[path]
          ? { text: gen.files[path], lines: gen.files[path].split("\n").length }
          : null;
      const size = isMain() ? D.sizes[path] : f ? f.text.length : 0;
      const known = isMain()
        ? D.paths.includes(path)
        : gen.paths.includes(path);
      const last = isMain() ? D.commits.find((c) => c.subject) : gen.commits[0];
      const isMd = /\.md$/i.test(path);
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], [path.split("/").pop()]], title: path.split("/").pop(), tab: "code", icon: "file" })}
        ${pathCrumbs(path, true)}
        ${
          !known
            ? `<div class="panel pad"><p>This file isn’t in <span class="mono">${esc(r.name)}</span>.</p><a class="btn small" href="#code">Back to code</a></div>`
            : `
        <div class="filebox panel">
          <div class="fb-head"><span class="authors">${isMain() ? authorLine(last) : person(last.author)}</span><span class="muted small ft-msg">${esc(last.subject)}</span><span class="muted small mono">${esc(last.short)} · ${ago(last.date)}</span></div>
          <div class="fb-bar"><span class="small"><b>${f ? f.lines : "—"}</b> lines · ${bytes(size || 0)}</span><span class="grow"></span>${isMd ? `<span class="seg mini-seg" role="group" aria-label="View"><button type="button" data-view="preview" aria-pressed="${blobMode !== "code"}">Preview</button><button type="button" data-view="code" aria-pressed="${blobMode === "code"}">Code</button></span>` : ""}<button class="btn small" type="button" id="copy-file">${icon("copy")}Copy</button><a class="btn small" href="#commits">${icon("clock")}History</a></div>
          ${f ? (isMd && blobMode !== "code" ? `<div class="md pad-md">${markdown(f.text)}</div>` : codeView(path, f.text)) + (f.truncated ? `<p class="small muted pad-md">Showing the first 260 of ${f.lines} lines.</p>` : "") : `<div class="pad-md"><p>The contents of this file aren’t included in the mockup.</p><p class="small muted">It’s real: ${bytes(size || 0)} at <span class="mono">${esc(D.commits[0] ? D.commits[0].short : "")}</span> on main.</p></div>`}
        </div>`
        }`;
    },
  });
  let blobMode = "preview";

  /* =====================================================================
   * COMMITS
   * ===================================================================== */
  GO.registerView("commits", {
    title: "Commits",
    navAs: "repo",
    skeleton: "list",
    render(root) {
      const list = isMain() ? D.commits : agentRepo(repoOf()).commits;
      const groups = [];
      list.forEach((c) => {
        const d = dayOf(c.date);
        const g = groups[groups.length - 1];
        if (g && g.d === d) g.items.push(c);
        else groups.push({ d, items: [c] });
      });
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Commits"]], title: "Commits", tab: isMain() ? "code" : "commits", icon: "clock", lede: isMain() ? `${D.commitCount} commits on main. ${D.commits.filter(claude).length} of the last ${D.commits.length} were co-written with Claude.` : "Every change to how this agent reviews." })}
        ${groups
          .map(
            (g) =>
              `<section class="section"><h2 class="daylabel">${icon("commit")}Commits on ${esc(g.d)}</h2><ul class="commitlist panel">${g.items
                .map(
                  (c) => `<li>
          <div class="cl-main"><span class="cl-top"><a class="cl-subj" href="#commit-${c.short}">${esc(c.subject.replace(/\s*\(#\d+\)\s*$/, ""))}</a>${c.pr ? `<span class="prref mono">#${c.pr}</span>` : ""}</span>
            <p class="small muted">${authorLine(c)} committed ${ago(c.date)}</p></div>
          <div class="cl-side"><a class="mono shabtn" href="#commit-${c.short}">${esc(c.short)}</a><button class="btn small quiet" type="button" data-copy="${esc(c.short)}" aria-label="Copy ${esc(c.short)}">${icon("copy")}</button><a class="btn small quiet" href="#code" aria-label="Browse the code at ${esc(c.short)}">${icon("code")}</a></div></li>`,
                )
                .join("")}</ul></section>`,
          )
          .join("")}`;
    },
  });
  GO.registerView("commit", {
    title: (p) => p,
    navAs: "repo",
    skeleton: "detail",
    render(root, sha) {
      const list = isMain() ? D.commits : agentRepo(repoOf()).commits;
      const c = list.find(
        (x) => x.short === sha || (x.sha && x.sha.startsWith(sha)),
      );
      if (!c) {
        root.innerHTML = pageHead({
          crumbs: [["repo"], ["Commit"]],
          title: "Commit not found",
          tab: "code",
          lede: '<a href="#commits">Back to commits</a>',
        });
        return;
      }
      const det = D.details[c.short];
      const diff = det
        ? det.patch
            .split("\n")
            .map((l) => {
              const k =
                l.startsWith("+++") || l.startsWith("---")
                  ? "meta"
                  : l.startsWith("diff ")
                    ? "file"
                    : l.startsWith("@@")
                      ? "hunk"
                      : l.startsWith("+")
                        ? "add"
                        : l.startsWith("-")
                          ? "del"
                          : "ctx";
              return k === "meta" || l.startsWith("index ")
                ? ""
                : `<div class="dl dl-${k}">${esc(l) || " "}</div>`;
            })
            .join("")
        : "";
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Commits", "commits"], [c.short]], title: c.subject, tab: "code", icon: "commit" })}
        <div class="panel commitbox">${det && det.body ? `<pre class="commit-body">${esc(det.body)}</pre>` : ""}<div class="cb-foot">${authorLine(c)}<span class="muted small">committed ${ago(c.date)}</span><span class="grow"></span><span class="mono small">commit ${esc(c.sha || c.short)}</span></div></div>
        ${
          det
            ? `<section class="section"><h2>${det.files} files changed</h2>
          <div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Added</th><th>Removed</th></tr></thead><tbody>${det.stats.map(([p, a, d]) => `<tr><td class="mono small"><a href="#blob-${esc(p)}">${esc(p)}</a></td><td class="mono ok">+${a}</td><td class="mono" style="color:var(--bad)">−${d}</td></tr>`).join("")}</tbody></table></div>
          <div class="diffview panel">${diff}</div>${det.patch.split("\n").length >= 220 ? '<p class="small muted">The rest of the diff isn’t included in the mockup.</p>' : ""}</section>`
            : '<div class="panel pad"><p>The diff for this commit isn’t included in the mockup. The three most recent commits have full diffs.</p></div>'
        }`;
    },
  });

  /* =====================================================================
   * ACTIONS: workflow runs and agent runs
   * ===================================================================== */
  const RUNS = [
    {
      n: 412,
      title: "Insights: show findings per agent",
      pr: 75,
      event: "pull_request",
      branch: "cho/insights-findings",
      status: "running",
      took: "2m 10s so far",
      when: "12 min ago",
      modules: "3 of 7",
    },
    {
      n: 411,
      title: "Rate-limit the public API",
      pr: 76,
      event: "pull_request",
      branch: "codex/s5-rate-limit",
      status: "running",
      took: "3m 02s so far",
      when: "30 min ago",
      modules: "5 of 7",
    },
    {
      n: 410,
      title: "Log every sign-in attempt",
      pr: 77,
      event: "pull_request",
      branch: "claude/s6-signin-log",
      status: "success",
      took: "4m 41s",
      when: "24 min ago",
      modules: "4 of 7",
    },
    {
      n: 409,
      title: "Require a token for the live-updates feed",
      pr: 74,
      event: "pull_request",
      branch: "codex/s2-live-token",
      status: "success",
      took: "3m 12s",
      when: "19 min ago",
      modules: "3 of 7",
    },
  ]
    .concat(
      D.commits
        .slice(0, 5)
        .map((c, i) => ({
          n: 408 - i,
          title: c.subject.replace(/\s*\(#\d+\)\s*$/, ""),
          event: "push",
          branch: "main",
          status: i === 3 ? "failure" : "success",
          took: ["6m 48s", "6m 31s", "6m 55s", "2m 04s", "6m 40s"][i],
          when: ago(c.date),
          modules: "7 of 7",
          sha: c.short,
        })),
    )
    .concat([
      {
        n: 403,
        title: "Show the currency on invoice PDFs",
        pr: 73,
        event: "pull_request",
        branch: "claude/s4-invoice-pdf",
        status: "success",
        took: "2m 51s",
        when: "2 h ago",
        modules: "2 of 7",
      },
      {
        n: 402,
        title: "Store a currency with every invoice",
        pr: 72,
        event: "pull_request",
        branch: "claude/s4-usd-invoices",
        status: "success",
        took: "3m 40s",
        when: "3 h ago",
        modules: "4 of 7",
      },
    ]);
  const AGENT_RUNS = [
    {
      id: "r1",
      kind: "Review",
      who: "data",
      title: "Data reviewed #72",
      status: "needs",
      steps: 6,
      took: "48 s",
      when: "3 h ago",
      decision:
        "Raised a finding for a person: existing invoices will be set to CAD.",
    },
    {
      id: "r2",
      kind: "Stack",
      who: "clef",
      title: "Stack discovery for #76 and #77",
      status: "clear",
      steps: 4,
      took: "2.1 s",
      when: "22 min ago",
      decision: "Same lines in worker/src/index.ts. Ordered #77 after #76.",
    },
    {
      id: "r3",
      kind: "Conflict resolution",
      who: "fixer",
      title: "Fixer on #77",
      status: "asked",
      steps: 9,
      took: "1 m 52 s",
      when: "15 min ago",
      decision:
        "Couldn’t combine safely. Handed back to Claude·s6 with both intents.",
    },
    {
      id: "r4",
      kind: "Review",
      who: "security",
      title: "Security reviewed #74",
      status: "asked",
      steps: 5,
      took: "41 s",
      when: "17 min ago",
      decision: "Requested changes: compare tokens in constant time.",
    },
    {
      id: "r5",
      kind: "Learn",
      who: "data",
      title: "Data learned from #67",
      status: "clear",
      steps: 7,
      took: "1 m 10 s",
      when: "today",
      decision: "Committed d47ef24: backfills inside migrations are allowed.",
      real: true,
    },
    {
      id: "r6",
      kind: "Learn",
      who: "features",
      title: "Features learned from #67",
      status: "clear",
      steps: 6,
      took: "58 s",
      when: "today",
      decision:
        "Committed 39851a5: renaming an internal type isn’t a breaking change.",
      real: true,
    },
  ];
  let actionsTab = "workflows";
  const runChip = (s) =>
    s === "running"
      ? `<span class="chip info"><span class="spinner"></span>In progress</span>`
      : s === "failure"
        ? chip("blocked", "Failed")
        : chip("clear", "Passed");
  GO.registerView("actions", {
    title: "Actions",
    navAs: "repo",
    skeleton: "list",
    render(root) {
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Actions"]], title: "Actions", tab: "actions", icon: "play", lede: "Your workflows run unchanged on Cloudflare Containers. Clef picks the test modules a change can affect. Every AI process GitOrange runs is listed under Agent runs." })}
        <div class="subtabs" role="tablist">${[
          ["workflows", "Workflow runs"],
          ["agents", "Agent runs"],
        ]
          .map(
            ([id, l]) =>
              `<button type="button" role="tab" data-atab="${id}" aria-selected="${actionsTab === id}">${l}</button>`,
          )
          .join("")}</div>
        ${
          actionsTab === "workflows"
            ? `<ul class="runlist panel">${RUNS.map(
                (
                  r,
                ) => `<li><span class="run-st">${r.status === "running" ? '<span class="spinner"></span>' : icon(r.status === "failure" ? "x" : "check", "icon " + (r.status === "failure" ? "bad" : "ok"))}</span>
            <div class="rl-main"><a class="cl-subj" href="#run-${r.n}">${esc(r.title)}</a><p class="small muted">CI #${r.n}: ${r.event === "push" ? `pushed to <span class="mono">main</span>${r.sha ? ` at <span class="mono">${r.sha}</span>` : ""}` : `pull request #${r.pr}`} · <span class="mono">${esc(r.branch)}</span> · ${esc(r.modules)} test modules</p></div>
            <div class="run-meta small muted"><span>${icon("clock")}${esc(r.took)}</span><span>${esc(r.when)}</span></div></li>`,
              ).join("")}</ul>`
            : `<ul class="runlist panel">${AGENT_RUNS.map(
                (
                  r,
                ) => `<li><span class="run-st">${AGENTS[r.who] ? avatar(r.who, 32, r.status) : ""}</span>
            <div class="rl-main"><a class="cl-subj" href="#agentrun-${r.id}">${esc(r.title)}</a> ${r.real ? "" : ""}<p class="small muted">${esc(r.kind)} · ${r.steps} steps · ${esc(r.decision)}</p></div>
            <div class="run-meta small muted">${chip(r.status)}<span>${esc(r.took)} · ${esc(r.when)}</span></div></li>`,
              ).join("")}</ul>`
        }`;
    },
  });
  let runJob = "test-billing";
  GO.registerView("run", {
    title: (p) => `Run #${p}`,
    navAs: "repo",
    skeleton: "detail",
    render(root, n) {
      const r = RUNS.find((x) => String(x.n) === String(n)) || RUNS[0];
      const jobs = [
        ["relevance", "Pick test modules (Clef)", "success", "4 s"],
        ["build", "Build", "success", "58 s"],
        [
          "test-billing",
          "test (billing)",
          r.status === "running" ? "running" : "success",
          "1m 12s",
        ],
        [
          "test-pulls",
          "test (pulls)",
          r.status === "failure" ? "failure" : "success",
          "1m 31s",
        ],
        ["test-review", "test (review)", "success", "49 s"],
        ["format", "Format", "success", "11 s"],
      ];
      const log = {
        "test-billing": [
          "$ yarn vitest run worker/src/__tests__/billing",
          " ✓ invoices.test.ts (14 tests) 2.4s",
          " ✓ pdf.test.ts (6 tests) 1.1s",
          " ✓ currency-migration.test.ts (9 tests) 3.0s",
          "",
          " Test Files  3 passed (3)",
          "      Tests  29 passed (29)",
          "   Duration  6.52s",
        ],
        relevance: [
          "Clef read 4 file summaries in 41 ms",
          "billing: likely (0.94)",
          "pulls: likely (0.62)",
          "review: likely (0.55)",
          "mcp: skip (0.03)",
          "live: skip (0.02)",
          "actions: skip (0.01)",
          "auth: skip (0.06)",
          "Running 3 of 7 modules",
        ],
      }[runJob] || ["Logs for this job aren’t included in the mockup."];
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Actions", "actions"], [`#${r.n}`]], title: r.title, tab: "actions", icon: "play", lede: `CI #${r.n} · ${r.event === "push" ? "push to main" : `pull request #${r.pr}`} · ${esc(r.took)} · ${esc(r.modules)} test modules` })}
        <div class="runlayout"><nav class="joblist panel" aria-label="Jobs">${jobs.map(([id, l, st, t]) => `<button type="button" data-job="${id}" aria-current="${runJob === id}">${st === "running" ? '<span class="spinner"></span>' : icon(st === "failure" ? "x" : "check", "icon " + (st === "failure" ? "bad" : "ok"))}<span>${esc(l)}</span><span class="muted small">${t}</span></button>`).join("")}</nav>
          <section class="logbox panel"><div class="log-head"><b>${esc((jobs.find((j) => j[0] === runJob) || jobs[0])[1])}</b><span class="muted small">standard-2 container</span></div><pre class="log mono">${log.map((l, i) => `<span class="ll"><i>${i + 1}</i>${esc(l)}</span>`).join("\n")}</pre></section></div>`;
    },
  });
  GO.registerView("agentrun", {
    title: "Agent run",
    navAs: "repo",
    skeleton: "detail",
    render(root, id) {
      const r = AGENT_RUNS.find((x) => x.id === id) || AGENT_RUNS[0];
      const steps =
        r.kind === "Conflict resolution"
          ? [
              ["Load both sides", "#76 and #77 on main at c9a41f0"],
              [
                "Read intents",
                "#76: limit each token to 60 requests a minute · #77: record every sign-in attempt",
              ],
              ["Open workspace", "Sandboxed checkout of worker/src"],
              ["Attempt merge", "Both edit line 41 of worker/src/index.ts"],
              [
                "Decide",
                "Order of middleware changes security behaviour. Not safe to choose.",
              ],
              ["Hand back", "Returned to Claude·s6 with both intents"],
            ]
          : [
              [
                "Wake",
                `Clef woke ${AGENTS[r.who] ? AGENTS[r.who].name : r.who}`,
              ],
              ["Read summaries", "One line per changed file"],
              [
                "Read instructions",
                AGENTS[r.who] && AGENTS[r.who].repo
                  ? AGENTS[r.who].repo
                  : "built in",
              ],
              ["Review the diff", "Cited lines collected"],
              ["Decide", r.decision],
            ];
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Actions", "actions"], [r.title]], title: r.title, tab: "actions", icon: "crew", lede: `${esc(r.kind)} · ${esc(r.took)} · ${esc(r.when)}` })}
        <div class="cols"><div class="col"><ol class="steps">${steps.map(([t, d], i) => `<li><span class="mono muted small">${i + 1}</span><span class="step-icon">${icon(i === steps.length - 1 ? "check" : "dot")}</span><span><b>${esc(t)}</b><br><span class="muted small">${esc(d)}</span></span></li>`).join("")}</ol></div>
        <aside class="col side"><section class="panel pad"><h2>Outcome</h2>${chip(r.status)}<p class="small">${esc(r.decision)}</p>${AGENTS[r.who] ? `<a class="btn small" href="#agent-${r.who}">About ${esc(AGENTS[r.who].name)}</a>` : ""}</section>
          <section class="panel pad"><h2>Model usage</h2><p class="small">${r.kind === "Conflict resolution" ? "Pi agent, 9 tool calls, 38k tokens" : "One reasoning-model pass, 6.1k tokens"} · about $0.004</p></section></aside></div>`;
    },
  });

  /* =====================================================================
   * INSIGHTS: real numbers for 1-8 October
   * ===================================================================== */
  GO.registerView("insights", {
    title: "Insights",
    navAs: "repo",
    skeleton: "list",
    render(root) {
      const flags = [
        ["features", 42, 19],
        ["shipping", 20, 11],
        ["data", 13, 7],
        ["security", 12, 6],
      ];
      const max = 42;
      root.innerHTML = `
        ${pageHead({ crumbs: [["repo"], ["Insights"]], title: "Insights", tab: "insights", icon: "gauge", lede: "How well agents land changes. Real numbers for choyiny/gitorange, 1–8 October." })}
        <div class="stats">
          <div class="stat"><b>67</b><span>pull requests merged</span></div>
          <div class="stat"><b>84%</b><span>auto-merged (56 of 67)</span></div>
          <div class="stat"><b>48</b><span>merged with no one involved</span></div>
          <div class="stat"><b>12 min</b><span>median time to merge (32 min when a person merged)</span></div>
          <div class="stat"><b>7 min</b><span>median wait for a person’s approval</span></div>
          <div class="stat"><b>96%</b><span>of 291 check runs passed</span></div>
        </div>
        <section class="section"><div class="section-head"><h2>Findings raised by each reviewer</h2><span class="muted small">Approved by a person in darker shade</span></div>
          <div class="panel pad bars">${flags.map(([id, raised, appr]) => `<div class="bar-row"><span class="bar-label">${GO.h.verdict ? `<span class="adot" style="--agent:${AGENTS[id].color}"><i></i>${esc(AGENTS[id].name)}</span>` : ""}</span><span class="bar-track"><span class="bar" style="width:${(raised / max) * 100}%"><span class="bar-in" style="width:${(appr / raised) * 100}%"></span></span></span><span class="bar-val mono">${raised} · ${appr} approved</span></div>`).join("")}</div></section>
        <section class="section"><div class="section-head"><h2>Clashes</h2></div><div class="panel pad"><p><b>54</b> conflict-resolution attempts across <b>13</b> pull requests. <b>9</b> succeeded. All 13 pull requests merged; the authors redid the other changes. Nothing was overwritten.</p></div></section>
        <section class="section"><div class="section-head"><h2>Learning</h2></div><div class="panel pad"><p>Features: 2 requests dismissed, 1 rule committed. Data: 1 dismissed, 1 rule committed.</p></div></section>`;
    },
  });

  /* =====================================================================
   * REPOSITORY SETTINGS
   * ===================================================================== */
  const RSET = [
    ["general", "General"],
    ["collaborators", "Collaborators"],
    ["agents", "Reviewer agents"],
    ["rules", "Rules for main"],
    ["danger", "Danger zone"],
  ];
  let dangerConfirm = "";
  GO.registerView("rsettings", {
    title: "Settings",
    navAs: "repo",
    skeleton: "detail",
    render(root, tab) {
      tab = tab || "general";
      if (tab === "rules") {
        GO.go("rules");
        return;
      }
      const r = repoOf();
      const nav = `<nav class="setnav" aria-label="Settings">${RSET.map(([id, l]) => `<a href="#${id === "rules" ? "rules" : "rsettings-" + id}" ${id === tab ? 'aria-current="page"' : ""}>${esc(l)}</a>`).join("")}</nav>`;
      let body = "";
      if (tab === "general")
        body = `<form class="form panel" id="rs-general"><h2>General</h2><label for="rs-name">Repository name</label><input id="rs-name" value="${esc(r.repo)}"><p class="small muted">Renaming never moves storage: the Artifacts repository is named by ID.</p>
        <label for="rs-desc">Description</label><input id="rs-desc" value="${esc(r.description)}">
        <label for="rs-branch">Default branch</label><select id="rs-branch"><option>main</option></select>
        <label>Merging</label><p class="small">Rebase only. Every merge is a compare-and-swap on the tip of main. <a href="#rules">Rules for main</a></p>
        <label class="inline-check"><input type="checkbox" checked id="rs-auto"> Auto-merge when checks pass and reviewers approve</label>
        <label class="inline-check"><input type="checkbox" checked id="rs-del"> Delete branches after they merge</label>
        <div class="actions"><button class="btn primary" type="submit" id="rs-save">Save</button></div></form>`;
      if (tab === "collaborators")
        body = `<section class="panel"><div class="pad"><h2>Collaborators</h2><p class="small muted">Collaborators can push and merge. Site admins can always.</p></div>
        <ul class="list flat">${[
          ["Cho Yin Yong", "choyiny", "Owner · site admin"],
          ["Mahmoud Halat", "mahmoud", "Write"],
        ]
          .map(
            ([n, h, role]) =>
              `<li>${person(n, 28)}<span><b>${esc(n)}</b> <span class="mono muted small">@${h}</span></span><span class="muted small">${role}</span></li>`,
          )
          .join("")}</ul>
        <form class="inline-form" id="rs-invite"><label for="rs-invite-who">Add a collaborator</label><div class="row-inline"><input id="rs-invite-who" placeholder="Username or email"><button class="btn" type="submit" id="rs-invite-go">Add</button></div></form></section>`;
      if (tab === "agents")
        body = `<section class="panel"><div class="pad"><h2>Reviewer agents</h2><p class="small muted">Invited agents review every change they’re relevant to. Security and Data can only be removed with a reason.</p></div>
        <ul class="list flat">${GO.REVIEWERS.map((id) => {
          const on =
            GO.state.crew.gitorange.includes(id) && !GO.state.reviewerOff[id];
          return `<li>${avatar(id, 40, on ? "idle" : "off")}<span><b>${esc(AGENTS[id].name)}</b><br><span class="muted small">${esc(AGENTS[id].job)}</span></span>${on ? (["security", "data"].includes(id) ? `<a class="btn small" href="#agent-${id}">Remove…</a>` : `<button class="btn small" type="button" data-remove-agent="${id}">Remove</button>`) : `<button class="btn small" type="button" data-add="${id}">${icon("plus")}Invite</button>`}</li>`;
        }).join("")}</ul></section>`;
      if (tab === "danger")
        body = `<section class="panel danger-zone"><div class="pad"><h2>Danger zone</h2></div><ul class="list flat">
        <li><span><b>Archive this repository</b><br><span class="muted small">Read-only for everyone. Agents stop reviewing.</span></span><button class="btn small danger" type="button" disabled>Archive</button></li>
        <li><span><b>Delete this repository</b><br><span class="muted small">Deletes the Artifacts repository, its LFS objects in R2 and its pull requests. This can’t be undone.</span></span>
          <form class="danger-form" id="rs-delete"><label class="sr" for="rs-del-confirm">Type ${esc(r.name)} to confirm</label><input id="rs-del-confirm" placeholder="Type ${esc(r.name)}" value="${esc(dangerConfirm)}"><button class="btn small danger" type="submit" ${dangerConfirm === r.name ? "" : "disabled"}>Delete</button></form></li></ul></section>`;
      root.innerHTML = `${pageHead({ crumbs: [["repo"], ["Settings"]], title: "Settings", tab: "rsettings", icon: "sliders" })}<div class="setlayout">${nav}<div class="setbody">${body}</div></div>`;
    },
  });

  /* =====================================================================
   * PERSONAL SETTINGS
   * ===================================================================== */
  const tokens = [
    {
      name: "MacBook git",
      scope: "Repositories: read and write",
      created: "Oct 5",
      used: "today",
      exp: "Jan 3, 2027",
    },
    {
      name: "Claude Code (gitorange-contribute)",
      scope: "Repositories: read and write",
      created: "Oct 5",
      used: "2 h ago",
      exp: "Nov 4, 2026",
    },
  ];
  let newToken = null,
    moderator = { claude: true, cdesk: false };
  GO.registerView("settings", {
    title: "Settings",
    navAs: "settings",
    skeleton: "detail",
    render(root, tab) {
      tab = tab || "tokens";
      const nav = `<nav class="setnav" aria-label="Your settings">${[
        ["tokens", "Access tokens", "key"],
        ["mcp", "Connected apps", "live"],
        ["emails", "Emails", "mail"],
      ]
        .map(
          ([id, l, ic]) =>
            `<a href="#settings-${id}" ${id === tab ? 'aria-current="page"' : ""}>${icon(ic)}${l}</a>`,
        )
        .join("")}</nav>`;
      let body = "";
      if (tab === "tokens")
        body = `<section class="panel"><div class="pad"><h2>Personal access tokens</h2><p class="small muted">Use a token as the password for git over HTTPS, and for Git LFS.</p></div>
        <ul class="list flat">${tokens.map((t) => `<li>${icon("key")}<span><b>${esc(t.name)}</b><br><span class="muted small">${esc(t.scope)} · created ${esc(t.created)} · last used ${esc(t.used)} · expires ${esc(t.exp)}</span></span><button class="btn small danger" type="button" data-revoke="${esc(t.name)}">Revoke</button></li>`).join("")}</ul>
        ${newToken ? `<div class="pad newtoken"><p><b>Copy your new token now.</b> You won’t see it again.</p><div class="clone-url"><input readonly value="${esc(newToken)}" id="tok-val"><button class="btn small" type="button" data-copy="${esc(newToken)}">${icon("copy")}Copy</button></div><p class="small muted">This is a mock value for the mockup.</p></div>` : ""}
        <form class="inline-form" id="tok-form"><label for="tok-name">New token name</label><div class="row-inline"><input id="tok-name" placeholder="for example: work laptop"><select id="tok-exp" aria-label="Expires"><option>30 days</option><option selected>90 days</option><option>1 year</option></select><button class="btn primary" type="submit" id="tok-go">Generate token</button></div></form></section>`;
      if (tab === "mcp")
        body = `<section class="panel"><div class="pad"><h2>Connected apps</h2><p class="small">Apps you’ve connected to GitOrange’s MCP server at <span class="mono">https://git.xyspace.dev/mcp</span>. They act as you.</p>
          <p class="small muted">A <b>moderator</b> app can also approve agent findings and pull requests for you. Each decision is recorded as “by the app for Mahmoud”. Security and Data findings always come to you.</p></div>
        <ul class="list flat">${[
          ["claude", "Claude Code", "MacBook · redirect localhost", "today"],
          ["cdesk", "Claude (claude.ai connector)", "claude.ai", "Oct 6"],
        ]
          .map(
            ([
              id,
              n,
              where,
              used,
            ]) => `<li><span class="mono-tile claude">C</span><span><b>${esc(n)}</b><br><span class="muted small">${esc(where)} · last used ${esc(used)}</span></span>
          <label class="switch inline"><span class="small">Moderator</span><input type="checkbox" data-moderator="${id}" ${moderator[id] ? "checked" : ""}></label><button class="btn small danger" type="button">Disconnect</button></li>`,
          )
          .join("")}</ul></section>`;
      if (tab === "emails")
        body = `<section class="panel"><div class="pad"><h2>Emails</h2><p class="small muted">Commits from any verified email are attributed to you.</p></div>
        <ul class="list flat"><li>${icon("mail")}<span><b>mahmoud@xyspace.dev</b><br><span class="muted small">Primary · verified</span></span>${chip("clear", "Verified")}</li></ul>
        <form class="inline-form" id="email-form"><label for="email-new">Add an email</label><div class="row-inline"><input id="email-new" type="email" placeholder="you@example.com"><button class="btn" type="submit" id="email-go">Add</button></div><p class="small muted">We send a link to verify it.</p></form></section>`;
      root.innerHTML = `${pageHead({ crumbs: [["Settings"]], title: "Your settings", icon: "sliders" })}<div class="setlayout">${nav}<div class="setbody">${body}</div></div>`;
    },
  });

  /* =====================================================================
   * SITE ADMIN
   * ===================================================================== */
  GO.registerView("admin", {
    title: "Site admin",
    navAs: "admin",
    skeleton: "detail",
    render(root, tab) {
      tab = tab || "users";
      const nav = `<nav class="setnav" aria-label="Site admin">${[
        ["users", "Users", "users"],
        ["agents", "Agents", "crew"],
        ["settings", "Settings", "sliders"],
        ["usage", "Usage and cost", "money"],
        ["setup", "Setup checks", "check"],
      ]
        .map(
          ([id, l, ic]) =>
            `<a href="#${id === "agents" ? "agents" : "admin-" + id}" ${id === tab ? 'aria-current="page"' : ""}>${icon(ic)}${l}</a>`,
        )
        .join("")}</nav>`;
      let body = "";
      if (tab === "users")
        body = `<section class="panel"><div class="pad"><h2>Users</h2><p class="small muted">Self sign-up is off. People join by invitation.</p></div>
        <ul class="list flat">${[
          ["Cho Yin Yong", "choyiny", "Site admin"],
          ["Mahmoud Halat", "mahmoud", "Member"],
        ]
          .map(
            ([n, h, r]) =>
              `<li>${person(n, 28)}<span><b>${esc(n)}</b> <span class="mono muted small">@${h}</span></span><span class="muted small">${r}</span></li>`,
          )
          .join("")}
        ${["security", "data", "features", "shipping"].map((id) => `<li>${avatar(id, 40, "idle")}<span><b>${esc(AGENTS[id].name)} Agent</b> <span class="mono muted small">${esc(AGENTS[id].handle)}</span></span><span class="muted small">Agent · can’t sign in</span></li>`).join("")}</ul>
        <form class="inline-form" id="invite-form"><label for="invite-email">Invite someone</label><div class="row-inline"><input id="invite-email" type="email" placeholder="name@company.com"><button class="btn primary" type="submit" id="invite-go">Send invitation</button></div></form></section>`;
      if (tab === "settings")
        body = `<form class="form panel" id="admin-settings"><h2>Instance settings</h2>
        <label for="as-name">Instance name</label><input id="as-name" value="XY SPACE GitOrange">
        <label for="as-sender">Invitations come from</label><input id="as-sender" value="git@xyspace.dev">
        <label for="as-decide">Decisions</label><select id="as-decide"><option>Clef (Workers AI)</option></select>
        <label for="as-reason">Explanations and reviews</label><select id="as-reason"><option>GLM-5.3</option></select>
        <label for="as-sum">File summaries</label><select id="as-sum"><option>GLM-5.3-flash</option></select>
        <div class="row2"><div><label for="as-jobs">Containers running at once</label><input id="as-jobs" type="number" value="4"></div><div><label for="as-keep">Keep Actions history (days)</label><input id="as-keep" type="number" value="30"></div></div>
        <div class="actions"><button class="btn primary" type="submit" id="as-save">Save</button></div></form>`;
      if (tab === "usage")
        body = `<section class="panel pad"><h2>Usage and cost this month</h2><p class="small muted">An estimate from Cloudflare usage. Example figures.</p>
        <div class="table-wrap"><table class="table"><thead><tr><th>Product</th><th>Use</th><th>Estimate</th></tr></thead><tbody>
        ${[
          ["Workers", "4.1M requests", "$5.00"],
          ["D1", "2.3 GB read, 41 MB stored", "$0.75"],
          ["Artifacts", "5 repositories, 180 MB", "$1.20"],
          ["Containers", "1,940 job minutes", "$14.80"],
          ["Workers AI: Clef", "6,200 decisions", "$3.10"],
          ["Workers AI: GLM", "2.1M tokens", "$9.40"],
          ["R2", "Logs, cache and LFS, 6 GB", "$0.90"],
        ]
          .map(
            ([p, u, c]) =>
              `<tr><th scope="row">${p}</th><td>${u}</td><td class="mono">${c}</td></tr>`,
          )
          .join("")}
        <tr><th scope="row">Total</th><td></td><td class="mono"><b>$35.15</b></td></tr></tbody></table></div></section>`;
      if (tab === "setup")
        body = `<section class="panel"><div class="pad"><h2>Setup checks</h2><p class="small muted">Misconfiguration shows here with the steps to fix it.</p></div>
        <ul class="list flat">${[
          ["Artifacts binding", "Connected to the gitorange namespace"],
          ["D1 database", "Migrations up to date (0043)"],
          ["R2 buckets", "Logs, cache and LFS buckets found"],
          [
            "R2 access keys",
            "Pre-signed URLs work for LFS and the Actions cache",
          ],
          ["Email", "Invitations send from git@xyspace.dev"],
          ["Workers AI", "Clef and GLM respond"],
          ["Containers", "Runner image built from actions/runner/Dockerfile"],
        ]
          .map(
            ([n, d]) =>
              `<li>${icon("check", "icon ok")}<span><b>${n}</b><br><span class="muted small">${d}</span></span>${chip("clear", "OK")}</li>`,
          )
          .join("")}</ul></section>`;
      root.innerHTML = `${pageHead({ crumbs: [["Site admin"]], title: "Site admin", icon: "shield" })}<div class="setlayout">${nav}<div class="setbody">${body}</div></div>`;
    },
  });

  /* =====================================================================
   * PROFILES
   * ===================================================================== */
  GO.registerView("profile", {
    title: (p) => p,
    navAs: "home",
    skeleton: "detail",
    render(root, h) {
      const people = {
        choyiny: ["Cho Yin Yong", "Site admin"],
        mahmoud: ["Mahmoud Halat", "Member"],
      };
      const agentId = Object.keys(AGENTS).find((id) =>
        (AGENTS[id].repo || "").startsWith(h + "/"),
      );
      if (agentId) {
        GO.go("agent-" + agentId);
        return;
      }
      const p = people[h] || [h, "Member"];
      const repos = REPOS.filter((r) => r.owner === h);
      root.innerHTML = `${pageHead({ crumbs: [[p[0]]], title: p[0], icon: "person" })}
        <div class="cols"><div class="col"><section class="section"><h2>Repositories</h2>${repos.length ? `<ul class="repolist panel">${repos.map((r) => `<li><div class="rl-main"><a class="rl-name" href="#repo-${r.name.replace("/", "~")}">${icon("repo")}<b>${esc(r.repo)}</b></a><span class="vis">${esc(r.visibility)}</span><p class="muted">${esc(r.description)}</p></div></li>`).join("")}</ul>` : '<p class="muted">No repositories yet.</p>'}</section>
          <section class="section"><h2>Recent commits</h2><ul class="list">${
            D.commits
              .filter((c) => c.author === p[0])
              .slice(0, 6)
              .map(
                (c) =>
                  `<li>${icon("commit")}<a href="#commit-${c.short}">${esc(c.subject)}</a><span class="when">${ago(c.date)}</span></li>`,
              )
              .join("") || '<li class="muted">Nothing recent.</li>'
          }</ul></section></div>
        <aside class="col side"><section class="panel pad profile-card">${person(p[0], 72)}<h2>${esc(p[0])}</h2><p class="mono muted">@${esc(h)}</p><p class="small">${esc(p[1])}</p></section></aside></div>`;
    },
  });

  /* =====================================================================
   * Events
   * ===================================================================== */
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "repo-q") {
      repoQuery = t.value;
      GO.rerender();
      const q = $("#repo-q");
      if (q) {
        q.focus();
        q.setSelectionRange(q.value.length, q.value.length);
      }
    }
    if (t.id === "rs-del-confirm") {
      dangerConfirm = t.value;
      const b = t.form.querySelector("button");
      b.disabled = dangerConfirm !== repoOf().name;
    }
    if (t.id === "nr-name") newRepo.name = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "branch-sel")
      GO.toast(
        `Browsing ${t.value} isn’t included in the mockup. main is shown.`,
        { icon: "branch" },
      );
    if (t.dataset.moderator) {
      moderator[t.dataset.moderator] = t.checked;
      GO.audit(
        "setting",
        `${t.checked ? "Made" : "Removed"} ${t.dataset.moderator === "claude" ? "Claude Code" : "Claude (claude.ai)"} ${t.checked ? "a" : "as a"} moderator`,
        { by: "Mahmoud" },
      );
      GO.toast(
        t.checked
          ? "This app can now approve findings for you"
          : "This app can no longer approve for you",
        { icon: "shield" },
      );
    }
  });
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("button, a");
    if (!t) return;
    if (t.dataset.atab) {
      actionsTab = t.dataset.atab;
      GO.rerender();
      return;
    }
    if (t.dataset.job) {
      runJob = t.dataset.job;
      GO.rerender();
      return;
    }
    if (t.dataset.view) {
      blobMode = t.dataset.view;
      GO.rerender();
      return;
    }
    if (t.id === "clone-open") {
      const m = $("#clone-menu");
      m.hidden = !m.hidden;
      t.setAttribute("aria-expanded", String(!m.hidden));
      return;
    }
    if (t.id === "copy-clone" || t.dataset.copy || t.id === "copy-file") {
      const text =
        t.id === "copy-clone"
          ? $("#clone-url").value
          : t.dataset.copy || ($(".codeview") ? $(".codeview").innerText : "");
      try {
        await navigator.clipboard.writeText(text);
        GO.toast("Copied", { icon: "copy" });
      } catch (err) {
        GO.toast("Copy isn’t available here. Select the text instead.", {
          icon: "alert",
        });
      }
      return;
    }
    if (t.id === "goto-file") {
      const i = $("#gsearch");
      if (i) i.focus();
      return;
    }
    if (t.dataset.revoke) {
      await GO.pending(t, "Revoking…", 500);
      const i = tokens.findIndex((x) => x.name === t.dataset.revoke);
      if (i >= 0) tokens.splice(i, 1);
      GO.audit("setting", `Revoked token “${t.dataset.revoke}”`, {
        by: "Mahmoud",
      });
      GO.rerender();
      GO.toast("Token revoked");
      return;
    }
    if (t.dataset.removeAgent) {
      const id = t.dataset.removeAgent;
      await GO.pending(t, "Removing…", 450);
      GO.state.crew.gitorange = GO.state.crew.gitorange.filter((x) => x !== id);
      GO.audit("setting", `${AGENTS[id].name} removed from GitOrange`, {
        by: "Mahmoud",
      });
      GO.emit("crew");
      GO.toast(`${AGENTS[id].name} no longer reviews GitOrange`, {
        icon: "moon",
      });
      return;
    }
  });
  document.addEventListener("submit", async (e) => {
    const f = e.target,
      done = (btn, label, msg, after) =>
        GO.pending(btn, label, 650).then(() => {
          if (after) after();
          GO.toast(msg);
        });
    if (f.id === "newrepo") {
      e.preventDefault();
      newRepo.owner = $("#nr-owner").value;
      newRepo.name = $("#nr-name").value.trim() || "new-repo";
      await done(
        $("#nr-go"),
        "Creating…",
        `Created ${newRepo.owner}/${newRepo.name}`,
        () => {
          newRepo.created = true;
          GO.audit(
            "setting",
            `Created repository ${newRepo.owner}/${newRepo.name}`,
            { by: "Mahmoud" },
          );
        },
      );
      GO.rerender();
      return;
    }
    if (f.id === "tok-form") {
      e.preventDefault();
      const name = $("#tok-name").value.trim() || "New token";
      await GO.pending($("#tok-go"), "Generating…", 600);
      tokens.unshift({
        name,
        scope: "Repositories: read and write",
        created: "today",
        used: "never",
        exp:
          $("#tok-exp").value === "1 year"
            ? "Oct 8, 2027"
            : $("#tok-exp").value === "30 days"
              ? "Nov 7, 2026"
              : "Jan 6, 2027",
      });
      newToken = "gor_pat_mock_" + Math.random().toString(36).slice(2, 14);
      GO.rerender();
      GO.toast("Token created. Copy it now.");
      return;
    }
    const simple = {
      "rs-general": ["#rs-save", "Saving…", "Settings saved"],
      "rs-invite": ["#rs-invite-go", "Adding…", "Invitation sent"],
      "email-form": ["#email-go", "Sending…", "Verification link sent"],
      "invite-form": ["#invite-go", "Sending…", "Invitation sent"],
      "admin-settings": ["#as-save", "Saving…", "Instance settings saved"],
    };
    if (simple[f.id]) {
      e.preventDefault();
      const [b, l, m] = simple[f.id];
      await done($(b), l, m);
      GO.audit("setting", m, { by: "Mahmoud" });
      return;
    }
    if (f.id === "rs-delete") {
      e.preventDefault();
      GO.toast("Deleting is disabled in the mockup.", { icon: "alert" });
    }
  });
  GO.repoKit = { markdown, agentRepo, ago };
})();
