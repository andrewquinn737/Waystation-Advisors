// Import dialog body: preview, column mapping, validation summary, duplicate choice, assign-to, chunked import.
// The engine is js/csvImport.js (pure); this file is the screen and the network calls.
import { supabase } from "./supabaseClient.js";
import { escapeHtml } from "./clientForm.js";
import { createNotification } from "./notifications.js";
import { prepareList, describePrepare } from "./copyReview.js";
import {
  analyzeFile, buildDials, validateDials, findFileDuplicates, dupCheckKeys, matchServerDuplicates,
  mappingProblems, stripInternal, FIELD_LABELS,
} from "./csvImport.js";

const CHUNK = 500;
const PARALLEL = 3;
const num = (n) => Number(n).toLocaleString("en-US");
const plural = (n, a, b) => `${num(n)} ${n === 1 ? a : b}`;

async function readFileText(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); } // Excel "CSV (comma delimited)" on Windows/Mac
}

export function createImportWizard(ctx) {
  // ctx: { container, profile, isTeamLead, teamIdsOf, onChange(info) }
  const root = ctx.container;
  let items = [];
  let assignees = [];
  let assigneeId = "";
  let busy = false;
  let seq = 0;

  const emit = () => ctx.onChange && ctx.onChange(summary());

  function summary() {
    const ok = items.filter((i) => i.status === "ok");
    const rows = ok.reduce((n, i) => n + importRows(i).length, 0);
    return { files: items.length, readyFiles: ok.length, rows, loading: items.some((i) => i.status === "loading") || busy,
             problems: ok.some((i) => i.problems.length) };
  }

  // Rows that will actually be inserted for an item, given its duplicate choice.
  function importRows(it) {
    return it.dials.filter((d, idx) => {
      if (it.skip.has(idx)) return false;
      return true;
    });
  }

  function recompute(it) {
    it.dials = buildDials(it.a.rows, it.map, null);
    it.stats = validateDials(it.dials);
    it.fileDups = findFileDuplicates(it.dials);
    it.problems = mappingProblems(it.map);
    applySkips(it);
  }
  function applySkips(it) {
    it.skip = new Map();
    const mode = it.dupMode;
    it.dials.forEach((d, i) => {
      if (mode !== "keep") {
        if (it.fileDups.has(i)) it.skip.set(i, "dup_file");
        else if (mode === "skip_all" && it.serverDups.has(i)) it.skip.set(i, "dup_existing");
      }
      if (!it.skip.has(i) && it.skipNoContact && !d.email && !d.mobile_phone && !d.company_phone) it.skip.set(i, "no_contact");
    });
  }
  async function serverCheck(it) {
    const my = ++it.checkSeq;
    const keys = dupCheckKeys(it.dials);
    it.serverState = "checking"; renderSoft();
    if (!keys.emails.length && !keys.phones.length) { it.serverDups = new Map(); it.serverState = "done"; applySkips(it); render(); emit(); return; }
    try {
      const { data, error } = await supabase.rpc("import_dup_check", { p_emails: keys.emails, p_phones: keys.phones });
      if (my !== it.checkSeq) return;
      if (error) throw error;
      it.serverDups = matchServerDuplicates(it.dials, data || []);
      it.serverState = "done";
    } catch (e) {
      if (my !== it.checkSeq) return;
      it.serverDups = new Map(); it.serverState = "failed";
    }
    applySkips(it); renderSoft(); emit();
  }

  async function setFiles(files) {
    const my = ++seq;
    items = files.map((f) => ({ file: f, name: f.name.replace(/\.csv$/i, "").trim() || "Imported", status: "loading", checkSeq: 0,
      dupMode: "skip_all", skipNoContact: false, serverDups: new Map(), serverState: "idle", fileDups: new Map(), skip: new Map(),
      dials: [], stats: null, problems: [], open: false, showMap: false }));
    render(); emit();
    for (const it of items) {
      try {
        const text = await readFileText(it.file);
        if (my !== seq) return;
        it.a = analyzeFile(text, it.file.name);
        it.map = { ...it.a.map };
        if (it.a.rows.length < 2) { it.status = "error"; it.error = "This file has no data rows (only a header or nothing at all)."; }
        else if (it.a.headers.length < 2 && it.a.rows.length > 1 && !/[,;\t]/.test(text.slice(0, 500))) { it.status = "error"; it.error = "This does not look like a CSV (no columns found)."; }
        else { it.status = "ok"; recompute(it); it.open = items.length === 1; }
      } catch (e) {
        it.status = "error"; it.error = "Could not read this file: " + (e.message || e);
      }
    }
    if (items.length > 1) { const f = items.find((i) => i.status === "ok"); if (f) f.open = true; }
    render(); emit();
    for (const it of items) if (it.status === "ok") await serverCheck(it);
  }

  function clear() { seq++; items = []; busy = false; root.innerHTML = ""; emit(); }

  // ---- assignees ----
  async function loadAssignees() {
    if (assignees.length) return;
    let q = supabase.from("profiles").select("id, full_name, role").order("full_name", { ascending: true });
    if (ctx.isTeamLead) q = q.or(`role.eq.admin,and(role.in.(intern,independent_lead),team_id.in.(${ctx.teamIdsOf(ctx.profile).join(",")})),id.eq.${ctx.profile.id}`);
    const { data } = await q;
    assignees = (data || []).filter((p) => p.id !== ctx.profile.id);
    render();
  }
  const roleLabel = (r) => ({ admin: "admin", team_lead: "team lead", intern: "intern", independent_lead: "lead" }[r] || r || "");
  const assigneeName = () => assignees.find((p) => p.id === assigneeId)?.full_name || "";

  // ---- render ----
  function chip(text, tone) { return `<span class="iw-chip ${tone || ""}">${escapeHtml(text)}</span>`; }

  function itemHTML(it, idx) {
    if (it.status === "loading") return `<div class="iw-item"><div class="iw-head"><b>${escapeHtml(it.file.name)}</b> <span class="iw-muted">Reading file...</span></div></div>`;
    if (it.status === "error") return `<div class="iw-item iw-bad"><div class="iw-head"><b>${escapeHtml(it.file.name)}</b></div><div class="iw-err">${escapeHtml(it.error)}</div></div>`;
    const s = it.stats;
    const rows = importRows(it).length;
    const skipped = it.skip.size;
    const cnt = (k) => [...it.skip.values()].filter((v) => v === k).length;
    const chips = [
      chip(`${num(rows)} to import`, "ok"),
      chip(`${num(s.with_personal_email)} with a personal email`, ""),
      chip(`${num(s.backup)} without (call list)`, ""),
      s.with_mobile ? chip(`${num(s.with_mobile)} mobile`, "") : "",
      s.no_phone ? chip(`${num(s.no_phone)} no phone`, s.no_phone > s.total * 0.3 ? "warn" : "") : "",
      s.copy_columns && s.email_missing_copy ? chip(`${num(s.email_missing_copy)} email rows missing copy (held)`, "warn") : "",
      !s.copy_columns && s.with_personal_email ? chip("no email copy in this file (add it on the review screen)", "") : "",
      s.copy_columns && s.email_has_copy ? chip(`${num(s.email_has_copy)} with copy`, "") : "",
      s.bad_email ? chip(`${num(s.bad_email)} invalid emails`, "warn") : "",
      s.role_email ? chip(`${num(s.role_email)} generic emails (info@, sales@)`, "") : "",
      s.bad_phone ? chip(`${num(s.bad_phone)} odd phone numbers`, "warn") : "",
      skipped ? chip(`${num(skipped)} skipped`, "warn") : "",
    ].join("");
    const dupFile = it.fileDups.size, dupDb = it.serverDups.size;
    let dupHTML = "";
    if (dupFile || dupDb || it.serverState === "checking" || it.serverState === "failed") {
      const first = [...it.serverDups.entries()].slice(0, 3).map(([i, h]) => `${escapeHtml(it.dials[i].company_name || it.dials[i].full_name || it.dials[i].email || "row " + it.dials[i].__row)} is already in "${escapeHtml(h.list_name)}"${h.owner_name ? ` (${escapeHtml(h.owner_name)})` : ""}`);
      dupHTML = `<div class="iw-dups"><div class="iw-dup-line">${
        [dupFile ? `<b>${plural(dupFile, "row repeats", "rows repeat")}</b> an earlier row in this file` : "",
         dupDb ? `<b>${plural(dupDb, "lead is", "leads are")}</b> already in the system` : "",
         it.serverState === "checking" ? `<span class="iw-muted">Checking existing leads...</span>` : "",
         it.serverState === "failed" ? `<span class="iw-muted">Could not check existing leads; only repeats inside the file are skipped.</span>` : ""].filter(Boolean).join(" · ")
      }</div>${first.length ? `<div class="iw-muted iw-small">${first.join("; ")}${dupDb > 3 ? "; ..." : ""}</div>` : ""}
        <div class="iw-radios" role="radiogroup" aria-label="Duplicates">
          ${[["skip_all", "Skip duplicates", "Repeats in the file and leads already in the system"],
             ["skip_file", "Skip repeats in this file only", "Still import leads that exist elsewhere"],
             ["keep", "Import everything", "Keep every row, duplicates included"]]
            .map(([v, t, sub]) => `<label class="iw-radio"><input type="radio" name="dup${idx}" value="${v}" data-act="dupmode" data-i="${idx}" ${it.dupMode === v ? "checked" : ""}><span><b>${t}</b><small>${sub}</small></span></label>`).join("")}
        </div></div>`;
    }
    const noContact = s.no_contact
      ? `<label class="iw-check"><input type="checkbox" data-act="nocontact" data-i="${idx}" ${it.skipNoContact ? "checked" : ""}> Skip the ${plural(s.no_contact, "row", "rows")} with no email and no phone <span class="iw-muted">(nothing to call or email)</span></label>` : "";
    const probs = it.problems.map((p) => `<div class="iw-err">${escapeHtml(p)}</div>`).join("");
    const cols = it.a.headers.map((h, ci) => {
      const cur = it.map[ci] || "";
      const how = it.a.how[ci] && it.map[ci] === it.a.map[ci] ? it.a.how[ci] : "";
      const ex = it.a.dataRows.slice(0, 40).map((r) => String(r[ci] || "").trim()).filter(Boolean).slice(0, 2).join(" · ");
      return `<div class="iw-col ${cur ? "" : "iw-col-off"}"><div class="iw-col-h"><b>${escapeHtml(h || "(no header)")}</b><span class="iw-muted iw-ex">${escapeHtml(ex.slice(0, 70))}</span></div>
        <select data-act="map" data-i="${idx}" data-c="${ci}" aria-label="Column ${escapeHtml(h)}"><option value="">Ignore this column</option>${
          Object.entries(FIELD_LABELS).map(([f, l]) => `<option value="${f}" ${cur === f ? "selected" : ""}>${escapeHtml(l)}</option>`).join("")}</select>
        ${how === "typo" ? `<span class="iw-tag">matched despite spelling</span>` : how === "contents" ? `<span class="iw-tag">guessed from the values</span>` : ""}</div>`;
    }).join("");
    const mappedFields = Object.entries(it.map).filter(([, f]) => f).map(([, f]) => f);
    const previewCols = [...new Set(["full_name", "company_name", "email", "mobile_phone", "company_phone", "city", "state"].filter((f) => mappedFields.includes(f) || (f === "full_name" && mappedFields.includes("first_name"))))];
    const prev = it.dials.slice(0, 5).map((d) => `<tr>${previewCols.map((f) => `<td>${escapeHtml(d[f] || "")}</td>`).join("")}</tr>`).join("");
    return `<div class="iw-item ${it.open ? "iw-open" : ""}">
      <button type="button" class="iw-head iw-toggle" data-act="toggle" data-i="${idx}" aria-expanded="${it.open}"><span class="iw-caret">${it.open ? "▾" : "▸"}</span> <b>${escapeHtml(it.name)}</b> <span class="iw-muted">${plural(s.total, "row", "rows")}${skipped ? `, ${num(rows)} to import` : ""}</span></button>
      ${it.open ? `<div class="iw-body">
        <label class="iw-lbl">Tab name <input type="text" class="iw-name" data-act="name" data-i="${idx}" value="${escapeHtml(it.name)}" maxlength="120"></label>
        ${ctx.listNames && ctx.listNames().has(it.name.trim().toLowerCase()) ? `<div class="iw-warn">A tab called "${escapeHtml(it.name)}" already exists. The new one will be added next to it.</div>` : ""}
        <div class="iw-chips">${chips}</div>
        ${probs}${dupHTML}${noContact}
        <div class="iw-sub">Preview</div>
        <div class="iw-tablewrap"><table class="iw-table"><thead><tr>${previewCols.map((f) => `<th>${escapeHtml(FIELD_LABELS[f] || f)}</th>`).join("")}</tr></thead><tbody>${prev || ""}</tbody></table></div>
        <button type="button" class="iw-link" data-act="togglemap" data-i="${idx}">${it.showMap ? "Hide columns" : `Columns (${mappedFields.length} of ${it.a.headers.length} matched). Fix a column`}</button>
        ${it.showMap ? `<div class="iw-cols">${cols}</div>` : ""}
      </div>` : ""}
    </div>`;
  }

  function assignHTML() {
    if (!items.some((i) => i.status === "ok")) return "";
    const opts = [`<option value="">Me (${escapeHtml(ctx.profile.full_name || "you")})</option>`]
      .concat(assignees.map((p) => `<option value="${p.id}" ${p.id === assigneeId ? "selected" : ""}>${escapeHtml(p.full_name)}${p.role ? ` (${roleLabel(p.role)})` : ""}</option>`)).join("");
    return `<div class="iw-assign"><label for="iwAssign">Assign to</label><select id="iwAssign" data-act="assign">${opts}</select>
      <div class="iw-muted iw-small">${assigneeId ? `${escapeHtml(assigneeName())} gets the list right after the import and is notified.` : "The list stays with you. You can still transfer it later."}</div></div>`;
  }

  // Async updates must not wipe a tab name the person is typing.
  function renderSoft() { if (document.activeElement?.classList?.contains("iw-name") && root.contains(document.activeElement)) return; render(); }
  function render() {
    if (!items.length) { root.innerHTML = ""; return; }
    root.innerHTML = `<div class="iw">${items.map(itemHTML).join("")}${assignHTML()}<div id="iwProgress" class="iw-progress hidden"></div></div>`;
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || busy) return;
    const it = items[Number(t.dataset.i)];
    if (t.dataset.act === "toggle") { it.open = !it.open; render(); }
    else if (t.dataset.act === "togglemap") { it.showMap = !it.showMap; render(); }
  });
  root.addEventListener("change", (e) => {
    const t = e.target.closest("[data-act]");
    if (!t || busy) return;
    const it = items[Number(t.dataset.i)];
    switch (t.dataset.act) {
      case "map": {
        const ci = Number(t.dataset.c), f = t.value;
        // one column per field: moving a field to a new column clears it from the old one
        if (f) for (const k of Object.keys(it.map)) if (it.map[k] === f && Number(k) !== ci) delete it.map[k];
        if (f) it.map[ci] = f; else delete it.map[ci];
        recompute(it); render(); emit(); serverCheck(it); break;
      }
      case "dupmode": it.dupMode = t.value; applySkips(it); render(); emit(); break;
      case "nocontact": it.skipNoContact = t.checked; applySkips(it); render(); emit(); break;
      case "name": it.name = t.value; break;
      case "assign": assigneeId = t.value; render(); break;
    }
  });
  root.addEventListener("input", (e) => { if (e.target.dataset?.act === "name") items[Number(e.target.dataset.i)].name = e.target.value; });

  function progress(text) {
    const el = root.querySelector("#iwProgress");
    if (!el) return;
    el.classList.remove("hidden");
    el.textContent = text;
  }

  // ---- run ----
  // opts: { type, mandate, buyerId, sortOrderStart, existingNames:Set }
  async function run(opts) {
    busy = true; render(); emit();
    const results = [];
    let sortOrder = opts.sortOrderStart || 0;
    const me = ctx.profile.id;
    const target = assigneeId && assigneeId !== me ? assigneeId : null;
    const tAll = performance.now();
    for (const it of items) {
      if (it.status !== "ok") continue;
      const res = { name: it.name.trim() || "Imported", file: it.file.name, ms: {} };
      results.push(res);
      const rows = importRows(it);
      if (!rows.length) { res.error = "nothing to import (every row was skipped)"; continue; }
      let listId = null;
      try {
        const t0 = performance.now();
        const { data: newList, error: listErr } = await supabase.from("dial_lists").insert({
          name: res.name, dial_type: opts.type, status: "current", sort_order: sortOrder,
          buyer_id: opts.type === "seller" ? opts.buyerId || null : null, ...(opts.mandate ? { mandate: opts.mandate } : {}),
        }).select().single();
        if (listErr) throw listErr;
        listId = newList.id; sortOrder++; res.id = listId;
        const payload = rows.map((d) => ({ ...stripInternal(d), list_id: listId }));
        let done = 0;
        const chunks = [];
        for (let i = 0; i < payload.length; i += CHUNK) chunks.push(payload.slice(i, i + CHUNK));
        let next = 0;
        const worker = async () => {
          while (next < chunks.length) {
            const c = chunks[next++];
            let err = null;
            for (let attempt = 0; attempt < 3; attempt++) {
              const { error } = await supabase.from("dials").insert(c);
              if (!error) { err = null; break; }
              err = error; await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
            }
            if (err) throw err;
            done += c.length;
            progress(`${res.name}: ${num(done)} of ${num(payload.length)} saved...`);
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker));
        res.inserted = payload.length;
        res.ms.insert = Math.round(performance.now() - t0);
        res.skipped = { dup_file: [...it.skip.values()].filter((v) => v === "dup_file").length, dup_existing: [...it.skip.values()].filter((v) => v === "dup_existing").length, no_contact: [...it.skip.values()].filter((v) => v === "no_contact").length };
      } catch (e) {
        res.error = e.message || String(e);
        // A half-imported list is worse than none: remove it so the retry starts clean.
        if (listId) { try { await supabase.from("dial_lists").delete().eq("id", listId); res.error += " (nothing was kept; try again)"; } catch { /* leave it */ } res.id = null; }
        continue;
      }
      // Assign to the chosen person. Same server call as Transfer, so transfers keep working the same way.
      if (target) {
        try {
          const t1 = performance.now();
          progress(`${res.name}: sending to ${assigneeName()}...`);
          const { error } = await supabase.rpc("transfer_dial_list", { p_list_id: listId, p_new_owner: target });
          if (error) throw error;
          createNotification(target, `${ctx.profile.full_name} sent you a list of people to contact.`, "dial_transfer");
          res.assignedTo = assigneeName(); res.ms.assign = Math.round(performance.now() - t1);
        } catch (e) { res.assignError = e.message || String(e); }
      }
      res.ms.callable = Math.round(performance.now() - tAll); // rows are in and the list is with its owner: callable now
      if (opts.mandate) {
        const t2 = performance.now();
        progress(`${res.name}: setting up sequences...`);
        try { res.seq = await prepareList(listId); } catch (e) { res.seqError = e.message || String(e); }
        res.ms.prepare = Math.round(performance.now() - t2);
      }
      res.ms.total = Math.round(performance.now() - tAll);
    }
    busy = false;
    window.__lastImportTimings = results.map((r) => ({ name: r.name, inserted: r.inserted, ...r.ms }));
    return { results, assignedTo: target ? assigneeName() : "", lastOwnId: [...results].reverse().find((r) => r.id && !r.assignedTo)?.id || null,
             lastId: [...results].reverse().find((r) => r.id)?.id || null };
  }

  const secs = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  function renderResult(out) {
    const box = document.createElement("div");
    box.id = "importDialsResult";
    box.className = "cr-import-result iw-result";
    box.innerHTML = out.results.map((r) => {
      if (r.error) return `<div class="f"><b>${escapeHtml(r.name)}</b><br><span class="bad">Not imported: ${escapeHtml(r.error)}</span></div>`;
      const sk = r.skipped, skipTxt = [sk.dup_file && `${num(sk.dup_file)} repeated`, sk.dup_existing && `${num(sk.dup_existing)} already in the system`, sk.no_contact && `${num(sk.no_contact)} with no contact info`].filter(Boolean).join(", ");
      const lines = [
        `<b>${escapeHtml(r.name)}</b>`,
        `${plural(r.inserted, "lead", "leads")} added${skipTxt ? ` (skipped ${skipTxt})` : ""}${r.assignedTo ? `, sent to ${escapeHtml(r.assignedTo)}` : ""}. Ready to call ${secs(r.ms.callable)} after you pressed Import.`,
        r.assignError ? `<span class="bad">Could not assign: ${escapeHtml(r.assignError)}. The list is in your account; use Transfer.</span>` : "",
        r.seq ? escapeHtml(describePrepare(r.seq)) : "",
        r.seqError ? `<span class="bad">Sequence setup failed: ${escapeHtml(r.seqError)}. Use "Run sequence setup" in the list menu.</span>` : "",
      ].filter(Boolean);
      return `<div class="f">${lines.join("<br>")}</div>`;
    }).join("");
    return box;
  }

  return { setFiles, clear, run, renderResult, loadAssignees, summary, isBusy: () => busy,
    setAssignee: (id) => { assigneeId = id || ""; render(); },
    // for tests
    _items: () => items };
}
