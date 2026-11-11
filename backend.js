// Budget Tracker: in-browser "backend".
// Everything the old Python server did, run locally. Data never leaves this device:
// it's kept in IndexedDB, and only moves when you export a file yourself.
"use strict";

const Backend = (() => {
  const DB_NAME = "budget-tracker", STORE = "kv", KEY = "state";
  let db = null, idb = null, persistent = false, storageOk = true;

  // ---------- small helpers ----------
  const pad2 = n => String(n).padStart(2, "0");
  const localIso = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayIso = () => localIso();
  const addMonths = (ym, k) => { const [y, m] = ym.split("-").map(Number), d = new Date(y, m - 1 + k, 1); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; };
  const round = (x, dp = 2) => { const f = 10 ** dp; return Math.round((+x + Number.EPSILON) * f) / f; };
  const money2 = x => round(x).toFixed(2);
  const fail = msg => { throw new Error(msg); };
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, "").slice(0, 8);
  const str = (v, n) => String(v ?? "").trim().slice(0, n);
  const clone = o => JSON.parse(JSON.stringify(o));

  function isoDate(v) {
    const s = String(v ?? "").trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) fail(`invalid date '${s}'`);
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) fail(`invalid date '${s}'`);
    return s;
  }
  const ym = v => { const s = String(v ?? ""); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) fail(`invalid month '${s}'`); return s; };
  const weekday = iso => new Date(iso + "T12:00").getDay(); // 0 Sun .. 6 Sat
  function num(v, lo = 0, hi = 1e9, name = "value") {
    const x = typeof v === "number" ? v : parseFloat(String(v).trim());
    if (!isFinite(x)) fail(`${name} must be a number`);
    if (x < lo || x > hi) fail(`${name} must be between ${lo} and ${hi}`);
    return round(x, 4);
  }
  function hhmm(v) {
    const s = String(v ?? "").trim();
    if (s && !/^\d{2}:\d{2}$/.test(s)) fail("times must be HH:MM");
    return s;
  }
  function eachDay(a, b, fn) {
    for (let d = new Date(a + "T12:00"); localIso(d) <= b; d.setDate(d.getDate() + 1)) fn(localIso(d));
  }

  // ---------- CSV ----------
  function parseCSV(text) {
    const rows = []; let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.some(f => f !== ""));
  }
  const csvCell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCSV = rows => rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

  // ---------- defaults (generic: nothing personal lives in this public file) ----------
  const DEFAULT_CATEGORIES = {
    income: ["Salary", "Side Income", "Investments", "Gifts", "Misc"],
    expense: ["Housing", "Utilities", "Groceries", "Dining Out", "Transportation", "Insurance", "Healthcare",
      "Subscriptions", "Entertainment", "Debt Payments", "Savings", "Misc"],
  };
  const DEFAULT_DASHBOARD = [
    { id: "w1", title: "Income vs expenses", measure: "both", groupBy: "month", chart: "bar", split: false, categories: [], size: "full" },
    { id: "w2", title: "Net by month", measure: "net", groupBy: "month", chart: "line", split: false, categories: [], size: "half" },
    { id: "w3", title: "Spending by category", measure: "expense", groupBy: "category", chart: "bar", split: false, categories: [], size: "half" },
    { id: "w4", title: "Spending trend by category", measure: "expense", groupBy: "month", chart: "line", split: true, categories: [], size: "full" },
  ];
  const defaultWork = () => {
    const t = todayIso();
    return {
      settings: { name: "Work", rate: 0, halfRate: 0, payBasis: "hourly", hourly: 0, dayHours: 7,
        dayStart: "08:00", dayEnd: "15:30", dayBreak: 30, start: t, end: addMonths(t.slice(0, 7), 7) + "-28",
        category: "Work", off: {}, half: {} },
      days: {},
    };
  };
  const defaultMoney = () => {
    const m = todayIso().slice(0, 7);
    return {
      accounts: { checking: 0, savings: 0, savingsApy: 0, asOf: todayIso() },
      deposit: { amount: 0 },
      tenant: { rent: 0, moveOut: false, moveOutMonth: addMonths(m, 4), vacancyMonths: 1, newDeposit: 0 },
      mortgage: { balance: 0, rate: 0, payment: 0, escrow: 0, nextDue: addMonths(m, 1), payments: [] },
      plan: { living: null, bufferTarget: 1000, efMonths: 3, workShare: 0, hysaApy: 4.10, growthSplit: 50, horizon: 24, extra: 0, lump: 0 },
      recurring: [
        { id: "rent", name: "Rent from tenant", type: "income", category: "Rental Income", kind: "rent" },
        { id: "mortgage", name: "Mortgage payment", type: "expense", category: "Housing", kind: "mortgage" },
      ],
      logged: {},
    };
  };
  const defaults = () => ({ transactions: [], categories: clone(DEFAULT_CATEGORIES), dashboard: clone(DEFAULT_DASHBOARD), work: defaultWork(), money: defaultMoney() });

  // fill in anything missing (older backups, newer versions)
  function normalize(d) {
    const base = defaults();
    d = d && typeof d === "object" ? d : {};
    d.transactions = Array.isArray(d.transactions) ? d.transactions : [];
    d.categories = sanitizeCats(d.categories || base.categories);
    d.dashboard = Array.isArray(d.dashboard) ? d.dashboard : base.dashboard;
    d.work = normalizeWork(d.work);
    d.money = normalizeMoney(d.money);
    return d;
  }
  function normalizeWork(w) {
    if (!w || typeof w !== "object" || typeof w.settings !== "object") return defaultWork();
    const s = w.settings, def = defaultWork().settings;
    for (const k in def) if (s[k] === undefined) s[k] = def[k];
    if (s.hourly === 0 && s.rate && s.dayHours) s.hourly = round(s.rate / s.dayHours, 4);
    w.days = w.days && typeof w.days === "object" ? w.days : {};
    return w;
  }
  function normalizeMoney(m) {
    const def = defaultMoney();
    if (!m || typeof m !== "object") return def;
    for (const k in def) {
      if (def[k] && typeof def[k] === "object" && !Array.isArray(def[k])) m[k] = { ...def[k], ...(m[k] || {}) };
      else if (m[k] === undefined) m[k] = def[k];
    }
    return m;
  }

  // ---------- storage ----------
  function openIdb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  const idbGet = () => new Promise((res, rej) => { const r = idb.transaction(STORE).objectStore(STORE).get(KEY); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idbPut = v => new Promise((res, rej) => { const t = idb.transaction(STORE, "readwrite"); t.objectStore(STORE).put(v, KEY); t.oncomplete = () => res(); t.onerror = () => rej(t.error); });

  async function init() {
    try { idb = await openIdb(); db = normalize(await idbGet()); }
    catch (e) { storageOk = false; db = defaults(); }
    try { persistent = navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { }
  }
  async function persist() { if (idb) await idbPut(db); }

  // ---------- transactions & categories ----------
  function sanitizeCats(raw) {
    const out = {};
    for (const kind of ["income", "expense"]) {
      const seen = [];
      for (let c of (raw?.[kind] || [])) { c = str(c, 40); if (c && !seen.includes(c)) seen.push(c); }
      if (!seen.includes("Misc")) seen.push("Misc");
      out[kind] = seen;
    }
    return out;
  }
  function addCat(lst, name) { if (!lst.includes(name)) lst.splice(lst[lst.length - 1] === "Misc" ? lst.length - 1 : lst.length, 0, name); }

  function cleanTx(tx, cats, id) {
    const kind = tx.type;
    if (!(kind in cats)) fail("type must be income or expense");
    if (!cats[kind].includes(tx.category)) fail("unknown category");
    const d = isoDate(tx.date), amt = round(parseFloat(tx.amount));
    if (!(amt > 0)) fail("amount must be positive");
    return { id: id || newId(), date: d, type: kind, category: tx.category, description: str(tx.description, 200), amount: money2(amt) };
  }

  // copy entries into another month, keeping the day of month (clamped, e.g. Jan 31 -> Feb 28)
  function copyTx(d, b) {
    const to = ym(b.toMonth), ids = new Set(Array.isArray(b.ids) ? b.ids : []);
    if (!ids.size) fail("Select at least one entry");
    const [y, m] = to.split("-").map(Number), last = new Date(y, m, 0).getDate();
    // entries made by the Work tab or the mortgage checklist stay with those tools
    const linked = new Set([...Object.values(d.work.days).map(x => x.tx), ...d.money.mortgage.payments.map(p => p.tx),
      ...Object.values(d.money.logged).flatMap(o => Object.values(o))].filter(Boolean));
    const keys = new Set(d.transactions.map(rowKey));
    let copied = 0, dupes = 0, skippedLinked = 0;
    for (const t of d.transactions.filter(t => ids.has(t.id))) {
      if (linked.has(t.id)) { skippedLinked++; continue; }
      const day = Math.min(+t.date.slice(8, 10), last);
      const row = { ...t, id: newId(), date: `${to}-${pad2(day)}` };
      if (keys.has(rowKey(row))) { dupes++; continue; }
      keys.add(rowKey(row)); d.transactions.push(row); copied++;
    }
    return { copied, dupes, skippedLinked, toMonth: to };
  }

  function catAction(d, b) {
    const kind = b.type, action = b.action, name = str(b.name, 40), nw = str(b.newName, 40), cats = d.categories;
    if (!(kind in cats)) fail("type must be income or expense");
    const lst = cats[kind];
    if (action === "add") {
      if (!name) fail("name required");
      if (lst.includes(name)) fail("that category already exists");
      addCat(lst, name);
    } else if (action === "rename" || action === "delete") {
      if (!lst.includes(name)) fail("unknown category");
      if (name === "Misc") fail("Misc can't be renamed or deleted");
      let target;
      if (action === "rename") {
        if (!nw) fail("new name required");
        if (lst.includes(nw)) fail("that category already exists");
        lst[lst.indexOf(name)] = nw; target = nw;
      } else { lst.splice(lst.indexOf(name), 1); target = "Misc"; }
      d.transactions.forEach(r => { if (r.type === kind && r.category === name) r.category = target; });
      d.dashboard.forEach(w => { w.categories = (w.categories || []).filter(c => !(c === name && action === "delete")).map(c => c === name ? nw : c); });
      if (kind === "income" && action === "rename" && d.work.settings.category === name) d.work.settings.category = nw;
    } else fail("unknown action");
  }

  // ---------- import / export ----------
  function parseAmount(s) {
    s = String(s).trim().replace(/[$,]/g, "");
    const neg = s.startsWith("(") && s.endsWith(")");
    const v = parseFloat(s.replace(/[()]/g, ""));
    if (!isFinite(v) || !/^[-+]?\d*\.?\d+$/.test(s.replace(/[()]/g, ""))) fail(`invalid amount '${s}'`);
    return neg ? -v : v;
  }
  function parseDate(s) {
    s = String(s ?? "").trim();
    const mk = (y, m, d) => { const dt = new Date(y, m - 1, d); return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? localIso(dt) : null; };
    let m, r = null;
    if ((m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s))) r = mk(+m[1], +m[2], +m[3]);
    else if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) r = mk(+m[3], +m[1], +m[2]);
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s))) r = mk(+m[3] + (+m[3] < 69 ? 2000 : 1900), +m[1], +m[2]);
    if (!r) fail(`unrecognized date '${s}'`);
    return r;
  }
  function normalizeImport(raw, cats, newCats) {
    const r = {};
    for (const [k, v] of Object.entries(raw)) r[String(k).trim().toLowerCase()] = v === null || v === undefined ? "" : String(v).trim();
    if (!r.amount) fail("missing amount");
    let amt = parseAmount(r.amount), kind = (r.type || "").toLowerCase();
    if (kind !== "income" && kind !== "expense") kind = amt < 0 ? "expense" : "income";
    amt = round(Math.abs(amt));
    if (amt === 0) fail("amount is zero");
    const cat = (r.category || "Misc").slice(0, 40);
    if (!cats[kind].includes(cat)) { cats[kind].push(cat); newCats.push(`${cat} (${kind})`); }
    return { id: r.id || newId(), date: parseDate(r.date || ""), type: kind, category: cat,
      description: (r.description || r.memo || r.name || "").slice(0, 200), amount: money2(amt) };
  }
  const rowKey = r => [r.date, r.type, r.category, r.description, r.amount].join("\u0001");

  function doImport(d, fmt, mode, text) {
    if (mode !== "merge" && mode !== "replace") fail("mode must be merge or replace");
    let cats = d.categories, rawRows, dash = null, work = null, money = null;
    text = String(text).replace(/^﻿/, "");
    if (fmt === "json") {
      let data;
      try { data = JSON.parse(text); } catch { fail("That file isn't valid JSON"); }
      if (!data || typeof data !== "object") fail("That file isn't a backup");
      rawRows = Array.isArray(data.transactions) ? data.transactions : [];
      if (data.categories && typeof data.categories === "object") {
        const b = sanitizeCats(data.categories);
        if (mode === "replace") cats = b;
        else for (const k in cats) cats[k].push(...b[k].filter(c => !cats[k].includes(c)));
      }
      if (mode === "replace" && Array.isArray(data.dashboard)) dash = data.dashboard;
      if (mode === "replace" && data.work && typeof data.work.settings === "object") work = data.work;
      if (mode === "replace" && data.money && typeof data.money.mortgage === "object") money = data.money;
    } else {
      const rows = parseCSV(text);
      const headers = (rows[0] || []).map(h => h.trim().toLowerCase());
      if (!headers.includes("date") || !headers.includes("amount")) fail("CSV needs at least 'date' and 'amount' columns");
      rawRows = rows.slice(1).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
    }
    const existing = mode === "replace" ? [] : d.transactions;
    const ids = new Set(existing.map(r => r.id)), keys = new Set(existing.map(rowKey));
    const added = [], errors = [], newCats = []; let skipped = 0;
    rawRows.forEach((raw, i) => {
      const n = i + (fmt === "csv" ? 2 : 1);
      let row;
      try { row = normalizeImport(raw, cats, newCats); }
      catch (e) { errors.push(`${fmt === "csv" ? "Line" : "Item"} ${n}: ${e.message}`); return; }
      if (keys.has(rowKey(row))) { skipped++; return; }
      if (ids.has(row.id)) row.id = newId();
      ids.add(row.id); added.push(row);
    });
    const restoring = work || money;
    if (mode === "replace" && !added.length && !restoring) fail("No valid rows found, so nothing was replaced. " + errors.slice(0, 3).join("; "));
    d.transactions = existing.concat(added);
    d.categories = cats;
    if (dash) d.dashboard = dash;
    if (work) d.work = normalizeWork(work);
    if (money) d.money = normalizeMoney(money);
    return { added: added.length, skipped, newCategories: newCats, errors: errors.slice(0, 20), errorCount: errors.length };
  }

  const txCSV = () => toCSV([["id", "date", "type", "category", "description", "amount"],
    ...db.transactions.map(r => [r.id, r.date, r.type, r.category, r.description, r.amount])]);

  // ---------- work planner ----------
  const NOTE_FIELDS = { school: 80, address: 160, start: 5, end: 5, break: 4, hours: 6, teacher: 80, notes: 1000 };
  function dayKind(s, iso) {
    if (iso < s.start || iso > s.end || s.off[iso]) return null;
    const wd = weekday(iso);
    if (wd === 0 || wd === 6) return null;
    return s.half[iso] ? "half" : "full";
  }
  const dayPay = (s, kind) => +(kind === "half" ? s.halfRate : s.rate);
  function noteHours(n) {
    n = n || {};
    const h = parseFloat(n.hours || 0);
    if (h > 0) return round(h);
    if (!/^\d{2}:\d{2}$/.test(n.start || "") || !/^\d{2}:\d{2}$/.test(n.end || "")) return null;
    const [h1, m1] = n.start.split(":").map(Number), [h2, m2] = n.end.split(":").map(Number);
    const mins = (h2 * 60 + m2) - (h1 * 60 + m1) - (parseInt(n.break || 0, 10) || 0);
    return mins > 0 ? round(mins / 60) : null;
  }
  function computePay(s, kind, note) {
    if (s.payBasis === "hourly") { const h = noteHours(note); if (h) return round(h * +s.hourly); }
    return dayPay(s, kind);
  }
  function txDesc(s, kind, note) {
    let desc = s.name + (kind === "half" ? " (half day)" : "");
    if (note?.school) desc += " · " + note.school;
    return desc.slice(0, 200);
  }
  function syncWorkedPay(d, iso) {
    const s = d.work.settings, day = d.work.days[iso], kind = dayKind(s, iso);
    day.pay = computePay(s, kind, day.note);
    const r = d.transactions.find(t => t.id === day.tx);
    if (r) { r.amount = money2(day.pay); r.description = txDesc(s, kind, day.note); }
  }
  function cleanNote(raw) {
    raw = raw && typeof raw === "object" ? raw : {};
    const n = {};
    for (const [k, len] of Object.entries(NOTE_FIELDS)) n[k] = str(raw[k], len);
    n.start = hhmm(n.start); n.end = hhmm(n.end);
    if (n.break && !/^\d+$/.test(n.break)) fail("break must be whole minutes");
    if (n.hours) {
      const h = parseFloat(n.hours);
      if (!(h > 0 && h <= 24)) fail("hours must be between 0 and 24");
      n.hours = String(h);
    }
    return Object.fromEntries(Object.entries(n).filter(([, v]) => v));
  }
  function workDays(d, changes) {
    if (!changes || typeof changes !== "object" || Object.keys(changes).length > 400) fail("changes must be an object of date -> status");
    const s = d.work.settings, days = d.work.days, today = todayIso();
    for (let [iso, status] of Object.entries(changes)) {
      iso = isoDate(iso);
      if (!["open", "planned", "worked"].includes(status)) fail("status must be open, planned or worked");
      const kind = dayKind(s, iso);
      if (!kind) fail(`${iso} isn't a school day`);
      const cur = days[iso]?.status || "open";
      if (status === cur) continue;
      if (status === "planned" && iso < today) fail(`${iso} has passed; mark it worked instead`);
      if (status === "worked" && iso > today) fail(`${iso} hasn't happened yet`);
      if (cur === "worked") { const tid = days[iso].tx; d.transactions = d.transactions.filter(r => r.id !== tid); }
      const note = days[iso]?.note;
      if (status === "open") delete days[iso];
      else if (status === "planned") days[iso] = { status: "planned", ...(note ? { note } : {}) };
      else {
        const pay = computePay(s, kind, note), entry = { status: "worked", pay, ...(note ? { note } : {}) };
        if (pay > 0) {
          addCat(d.categories.income, s.category);
          const row = { id: newId(), date: iso, type: "income", category: s.category, description: txDesc(s, kind, note), amount: money2(pay) };
          d.transactions.push(row); entry.tx = row.id;
        }
        days[iso] = entry;
      }
    }
  }
  function workNote(d, b) {
    const iso = isoDate(b.date), day = d.work.days[iso];
    if (!day) fail("Plan or log the day before adding details");
    const note = cleanNote(b.note);
    if (Object.keys(note).length) day.note = note; else delete day.note;
    if (day.status === "worked") syncWorkedPay(d, iso);
  }
  function workDay(d, b) {
    cleanNote(b.note); // validate first
    workDays(d, { [b.date]: b.status });
    if (b.status !== "open") workNote(d, { date: b.date, note: b.note || {} });
  }
  function dateMap(m) {
    if (!m || typeof m !== "object" || Object.keys(m).length > 400) fail("bad calendar data");
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [isoDate(k), String(v).slice(0, 40)]));
  }
  function workSettings(d, b) {
    const old = d.work.settings;
    const s = {
      name: (str(b.name, 60) || "Work"),
      rate: round(num(b.rate, 0, 1e6, "full-day pay")), halfRate: round(num(b.halfRate, 0, 1e6, "half-day pay")),
      start: isoDate(b.start), end: isoDate(b.end),
      category: str(b.category, 40) || "Misc",
      payBasis: b.payBasis === "daily" ? "daily" : "hourly",
      hourly: num(b.hourly ?? old.hourly, 0, 1e4, "hourly rate"),
      dayHours: round(num(b.dayHours ?? old.dayHours, 0.25, 24, "standard day hours")),
      dayStart: hhmm(b.dayStart ?? old.dayStart), dayEnd: hhmm(b.dayEnd ?? old.dayEnd),
      dayBreak: parseInt(b.dayBreak ?? old.dayBreak ?? 0, 10) || 0,
      off: dateMap(b.off ?? old.off), half: dateMap(b.half ?? old.half),
    };
    if (s.start > s.end) fail("start must be before end");
    for (const iso of Object.keys(s.half)) if (s.off[iso]) delete s.half[iso];
    for (const [iso, day] of Object.entries(d.work.days)) {
      const kind = dayKind(s, iso);
      if (day.status === "worked" && kind !== dayKind(old, iso)) fail(`${iso} is marked worked. Unmark it before changing that day.`);
      if (!kind) delete d.work.days[iso];
    }
    d.work.settings = s;
    if (["payBasis", "hourly", "rate", "halfRate"].some(k => s[k] !== old[k]))
      for (const [iso, day] of Object.entries(d.work.days)) if (day.status === "worked") syncWorkedPay(d, iso);
  }
  function worklogCSV() {
    const s = db.work.settings, rows = [["date", "status", "day_type", "school", "address", "start", "end", "break_min", "hours", "pay", "effective_hourly", "teacher_class", "notes"]];
    for (const iso of Object.keys(db.work.days).sort()) {
      const day = db.work.days[iso], n = day.note || {}, kind = dayKind(s, iso) || "";
      const pay = day.status === "worked" ? day.pay : kind ? computePay(s, kind, n) : "";
      const h = noteHours(n);
      rows.push([iso, day.status, kind, n.school, n.address, n.start, n.end, n.break, h || "", pay,
        h && pay !== "" ? round(pay / h) : "", n.teacher, n.notes]);
    }
    return toCSV(rows);
  }

  // ---------- money ----------
  const F = {
    accounts: { checking: v => num(v, -1e7, 1e9, "checking"), savings: v => num(v, 0, 1e9, "savings"), savingsApy: v => num(v, 0, 25, "APY"), asOf: isoDate },
    deposit: { amount: v => num(v, 0, 1e6, "deposit") },
    tenant: { rent: v => num(v, 0, 1e6, "rent"), moveOut: v => !!v, moveOutMonth: ym,
      vacancyMonths: v => Math.trunc(num(v, 0, 24, "vacancy")), newDeposit: v => num(v, 0, 1e6, "new deposit") },
    mortgage: { balance: v => num(v, 0, 1e8, "balance"), rate: v => num(v, 0, 30, "rate"), payment: v => num(v, 0, 1e6, "payment"),
      escrow: v => num(v, 0, 1e5, "escrow"), nextDue: ym },
    plan: { living: v => v === null || v === "" ? null : num(v, 0, 1e6, "living costs"), bufferTarget: v => num(v, 0, 1e7, "buffer"),
      efMonths: v => num(v, 0, 24, "months"), workShare: v => num(v, 0, 100, "work share"), hysaApy: v => num(v, 0, 25, "APY"),
      growthSplit: v => num(v, 0, 100, "split"), horizon: v => Math.trunc(num(v, 6, 60, "horizon")),
      extra: v => num(v, 0, 1e6, "extra"), lump: v => num(v, 0, 1e8, "lump sum") },
  };
  function moneyUpdate(d, b) {
    for (const [sec, fields] of Object.entries(F))
      for (const [k, v] of Object.entries(b[sec] || {})) if (fields[k]) d.money[sec][k] = fields[k](v);
  }
  function moneyLog(d, b) {
    const m = d.money, month = ym(b.month), item = m.recurring.find(r => r.id === b.id);
    if (!item) fail("unknown item");
    const done = m.logged[month] ??= {};
    if (done[item.id]) fail("already logged for that month");
    addCat(d.categories[item.type], item.category);
    let amount = item.kind === "rent" ? m.tenant.rent : item.kind === "mortgage" ? round(m.mortgage.payment + m.mortgage.escrow) : +item.amount;
    let desc = item.name, record = null;
    if (item.kind === "mortgage") {
      const mg = m.mortgage;
      if (!(mg.balance > 0)) fail("Enter your mortgage balance first (Money tab → Loan details)");
      let extra = num(b.extra || 0, 0, 1e7, "extra principal");
      const interest = round(mg.balance * mg.rate / 1200), principal = round(Math.min(mg.payment - interest, mg.balance));
      if (principal <= 0) fail("The payment doesn't cover the interest. Check the loan details.");
      extra = round(Math.min(extra, mg.balance - principal));
      record = { month, interest, principal, extra, escrow: mg.escrow, before: mg.balance };
      mg.balance = round(mg.balance - principal - extra);
      mg.nextDue = addMonths(month, 1);
      amount = round(principal + interest + mg.escrow + extra);
      const usd = x => "$" + x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      desc = `Mortgage: principal ${usd(principal + extra)} · interest ${usd(interest)}` + (mg.escrow ? ` · escrow ${usd(mg.escrow)}` : "");
    }
    if (!(amount > 0)) fail(`Set the ${item.kind === "rent" ? "rent amount" : "amount"} first`);
    const t = todayIso();
    const tx = { id: newId(), date: month === t.slice(0, 7) ? t : month + "-01", type: item.type, category: item.category,
      description: desc.slice(0, 200), amount: money2(amount) };
    d.transactions.push(tx);
    done[item.id] = tx.id;
    if (record) { record.tx = tx.id; m.mortgage.payments.push(record); }
  }
  function moneyUnlog(d, b) {
    const m = d.money, month = ym(b.month), txId = m.logged[month]?.[b.id];
    if (!txId) fail("not logged");
    const pays = m.mortgage.payments, i = pays.findIndex(p => p.tx === txId);
    if (i >= 0) {
      if (i !== pays.length - 1) fail("Undo the most recent mortgage payment first");
      m.mortgage.balance = pays[i].before; m.mortgage.nextDue = pays[i].month; pays.pop();
    }
    d.transactions = d.transactions.filter(r => r.id !== txId);
    delete m.logged[month][b.id];
  }
  function moneyRecurring(d, b) {
    const m = d.money;
    if (b.action === "add") {
      const it = b.item || {}, name = str(it.name, 60);
      if (!name || !["income", "expense"].includes(it.type)) fail("name and type required");
      m.recurring.push({ id: newId(), name, type: it.type, category: str(it.category, 40) || "Misc", amount: num(it.amount ?? 0, 0.01, 1e6, "amount") });
    } else if (b.action === "delete") {
      if (b.id === "rent" || b.id === "mortgage") fail("rent and mortgage can't be removed");
      m.recurring = m.recurring.filter(r => r.id !== b.id);
    } else fail("unknown action");
  }

  // ---------- router: same routes the Python server had ----------
  function route(d, method, path, b = {}) {
    const isTx = path.startsWith("/api/tx/");
    const key = `${method} ${isTx ? "/api/tx/:id" : path}`, id = isTx ? decodeURIComponent(path.slice(8)) : null;
    switch (key) {
      case "GET /api/data": return;
      case "POST /api/tx": { const row = cleanTx(b, d.categories); d.transactions.push(row); return { row }; }
      case "PUT /api/tx/:id": {
        const i = d.transactions.findIndex(r => r.id === id);
        if (i < 0) fail("entry not found");
        d.transactions[i] = cleanTx(b, d.categories, id); return;
      }
      case "DELETE /api/tx/:id": d.transactions = d.transactions.filter(r => r.id !== id); return;
      case "POST /api/copy": return { copy: copyTx(d, b) };
      case "POST /api/categories": return catAction(d, b);
      case "PUT /api/dashboard":
        if (!Array.isArray(b.widgets)) fail("widgets must be a list");
        d.dashboard = b.widgets.slice(0, 40); return;
      case "POST /api/import": return { result: doImport(d, b.format, b.mode, b.text ?? "") };
      case "POST /api/work/days": return workDays(d, b.changes);
      case "POST /api/work/note": return workNote(d, b);
      case "POST /api/work/day": return workDay(d, b);
      case "PUT /api/work/settings": return workSettings(d, b);
      case "PUT /api/money": return moneyUpdate(d, b);
      case "POST /api/money/log": return moneyLog(d, b);
      case "POST /api/money/unlog": return moneyUnlog(d, b);
      case "POST /api/money/recurring": return moneyRecurring(d, b);
    }
    fail("not found");
  }

  // each change runs on a copy and is only kept (and saved) if it fully succeeds
  let queue = Promise.resolve();
  function request(method, path, body) {
    const run = async () => {
      const draft = clone(db);
      const extra = route(draft, method, path, body ? clone(body) : {}) || {};
      if (method !== "GET") { db = draft; await persist(); }
      return { ...clone(db), ...extra };
    };
    const p = queue.then(run, run);
    queue = p.catch(() => { });
    return p;
  }

  return {
    init, request,
    exportTxCSV: txCSV,
    exportBackup: () => JSON.stringify(db, null, 2),
    exportWorklogCSV: worklogCSV,
    status: () => ({ storageOk, persistent }),
    isEmpty: () => !db.transactions.length && !db.money.accounts.checking && !db.money.accounts.savings && !db.money.mortgage.balance,
  };
})();
