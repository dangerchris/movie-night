const IMG = "https://image.tmdb.org/t/p/";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let state = null;      // /api/state
let session = null;    // /api/me
const movieCache = new Map(); // id -> details (from state or /api/movie)
const overriding = new Set();  // night dates where an admin has switched on override controls

// ---------- api ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isError ? 5000 : 2500);
}

async function act(fn, okMsg) {
  try {
    const next = await fn();
    if (next && next.upcoming) setState(next);
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

// ---------- formatting ----------

function fmtDate(iso, opts) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString(undefined, { timeZone: "UTC", ...opts });
}
function fmtTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(undefined, { timeZone: "UTC", hour: "numeric", minute: "2-digit" });
}
function fmtRuntime(min) {
  if (!min) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${m ? m + "m" : ""}`.trim() : `${m}m`;
}
const isMe = (p) => p && state?.me && p.email === state.me.email;
const personHtml = (p) => p ? `<span class="${isMe(p) ? "you" : ""}">${esc(p.name)}${isMe(p) ? " (you)" : ""}</span>` : `<span class="muted">nobody</span>`;

function posterHtml(m, { size = "w342", cls = "", ribbon = "" } = {}) {
  const img = m.posterPath
    ? `<img src="${IMG}${size}${esc(m.posterPath)}" alt="${esc(m.title)} poster" loading="lazy">`
    : `<span class="no-img">${esc(m.title)}</span>`;
  return `<button type="button" class="poster ${cls}" data-movie="${m.id}" aria-label="${esc(m.title)}">${img}${ribbon ? `<span class="ribbon">${esc(ribbon)}</span>` : ""}</button>`;
}

// ---------- rendering ----------

function setState(s) {
  state = s;
  for (const n of [...s.upcoming, ...s.past]) for (const m of n.proposals) movieCache.set(m.id, m);
  render();
}

function render() {
  const s = state;
  document.title = s.settings.title;
  $("#title").textContent = s.settings.title;
  renderUserbar();

  const [next, ...rest] = s.upcoming;
  const main = $("#main");
  main.innerHTML = `
    <section>${next ? nightHtml(next, true) : `<p class="muted">No upcoming nights.</p>`}</section>
    ${rest.length ? `<section><h2 class="section-title">Coming up</h2>${rest.map((n) => nightHtml(n, false)).join("")}</section>` : ""}
    ${s.past.length ? `<section><h2 class="section-title">Past nights</h2><div class="past-list">${s.past.map(pastHtml).join("")}</div></section>` : ""}
  `;
}

function statusHtml(n) {
  const picked = n.proposals.find((m) => m.id === n.selectedId);
  if (picked) return `Watching <strong>${esc(picked.title)}</strong>${n.selectedBy ? `, picked by ${personHtml(n.selectedBy)}` : ""}.`;
  if (n.proposals.length === 3)
    return isMe(n.chooser) ? `<strong>You're picking.</strong> Choose one of these three.` : `Waiting for ${personHtml(n.chooser)} to pick one of these.`;
  return isMe(n.proposer) ? `<strong>You're proposing.</strong> Choose 3 movies for ${personHtml(n.chooser)} to pick from.` : `Waiting for ${personHtml(n.proposer)} to propose 3 movies.`;
}

// Stable per-person colour for avatars.
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatarHtml(p) {
  if (!p) return `<span class="avatar empty">?</span>`;
  return `<span class="avatar" style="--h:${hue(p.email)}">${esc(p.name.trim().charAt(0).toUpperCase())}</span>`;
}

function turnHtml(role, p, phase, doneText, activeText, pendingText) {
  const mine = isMe(p);
  const stateText = phase === "done" ? doneText : phase === "active" ? (mine ? "Your turn" : activeText) : pendingText;
  return `<div class="turn ${phase} ${mine ? "mine" : ""}">
    ${avatarHtml(p)}
    <div class="turn-text">
      <div class="turn-role">${role}</div>
      <div class="turn-name">${p ? esc(p.name) : "Nobody"}${mine ? ` <span class="you-tag">you</span>` : ""}</div>
      <div class="turn-state">${phase === "done" ? "✓ " : ""}${esc(stateText)}</div>
    </div>
  </div>`;
}

function turnsHtml(n) {
  const proposed = n.proposals.length === 3;
  const picked = n.selectedId !== null;
  const past = n.isPast;
  const pPhase = proposed ? "done" : past ? "missed" : "active";
  const cPhase = picked ? "done" : proposed && !past ? "active" : past ? "missed" : "pending";
  return `<div class="turns">
    ${turnHtml("Proposes 3", n.proposer, pPhase, "Proposed", "Choosing movies", "Didn't propose")}
    <span class="turn-arrow" aria-hidden="true">→</span>
    ${turnHtml("Picks 1", n.chooser, cPhase, "Picked", "Picking now", cPhase === "missed" ? "No pick" : "Up next")}
  </div>`;
}

function nightHtml(n, isNext) {
  const picked = n.selectedId !== null;
  const override = n.canOverride && overriding.has(n.date);
  const canChoose = n.canChoose || (override && n.proposals.length === 3);
  const canPropose = n.canPropose || override;
  const slots = [0, 1, 2].map((i) => {
    const m = n.proposals[i];
    if (!m) return `<div class="poster-wrap"><div class="slot-empty">?</div></div>`;
    const isPick = m.id === n.selectedId;
    const cls = picked ? (isPick ? "picked" : "dimmed") : "";
    const pickBtn = canChoose && !isPick
      ? `<button class="btn small ${picked ? "ghost" : "primary"}" data-action="pick" data-date="${n.date}" data-id="${m.id}">${picked ? "Switch to this" : "Pick this"}</button>`
      : canChoose && isPick
        ? `<button class="btn small ghost" data-action="unpick" data-date="${n.date}">Undo pick</button>` : "";
    return `<div class="poster-wrap">
      ${posterHtml(m, { cls, ribbon: isPick ? "Picked" : "" })}
      <div class="poster-title">${esc(m.title)} <span class="yr">${esc(m.year ?? "")}</span></div>
      ${pickBtn}
    </div>`;
  }).join("");

  const badge = n.isToday ? `<span class="badge">Tonight</span>` : isNext ? `<span class="badge">Next up</span>` : "";
  const actions = [];
  if (canPropose) actions.push(`<button class="btn ${n.proposals.length ? "" : "primary"}" data-action="propose" data-date="${n.date}">${n.proposals.length ? "Change proposals" : "Propose movies"}</button>`);
  if (n.canOverride) {
    actions.push(`<button class="btn ghost small" data-action="override" data-date="${n.date}" aria-pressed="${override}">${override ? "Done overriding" : "Admin override"}</button>`);
    if (override) actions.push(`<button class="btn ghost small" data-action="roles" data-date="${n.date}">Edit roles${n.rolesOverridden ? " (overridden)" : ""}</button>`);
  }

  return `<article class="night ${isNext ? "next" : ""} ${override ? "overriding" : ""}" data-date="${n.date}">
    <div class="night-head">
      <div class="night-date">
        <span class="day">${esc(fmtDate(n.date, { weekday: "short", month: "short", day: "numeric" }))}</span>
        <span class="time">${esc(fmtTime(n.time))}</span>
        ${badge}${picked ? `<span class="badge picked">Picked</span>` : ""}
      </div>
    </div>
    ${turnsHtml(n)}
    <p class="status">${statusHtml(n)}</p>
    <div class="posters">${slots}</div>
    ${actions.length ? `<div class="night-actions">${actions.join("")}</div>` : ""}
  </article>`;
}

function pastHtml(n) {
  const m = n.proposals.find((p) => p.id === n.selectedId);
  const date = fmtDate(n.date, { month: "short", day: "numeric", year: "numeric" });
  if (!m) return `<div class="past-item"><div class="slot-empty">-</div><div class="meta"><b>No pick</b>${esc(date)}</div></div>`;
  return `<div class="past-item">${posterHtml(m, { size: "w185" })}<div class="meta"><b>${esc(m.title)}</b>${esc(date)} · ${esc(n.chooser?.name ?? "")}</div></div>`;
}

function renderUserbar() {
  const bar = $("#userbar");
  const me = session?.me;
  if (!me) { bar.innerHTML = ""; return; }
  bar.innerHTML = `
    <button class="user-chip" data-action="rename" title="Change your display name">${esc(me.name)}</button>
    ${session.mode === "picker" ? `<button class="btn ghost small" data-action="switch-user">Switch user</button>` : ""}
    ${me.isAdmin ? `<button class="btn ghost small" data-action="settings">Settings</button>` : ""}
  `;
}

// ---------- gate screens ----------

function renderGate() {
  const main = $("#main");
  $("#title").textContent = session?.title ?? "Movie Night";
  renderUserbar();
  if (session.mode === "denied") {
    main.innerHTML = `<div class="gate"><h2>Can't sign you in</h2><p class="muted">${esc(session.reason)}</p></div>`;
  } else if (session.mode === "access" && !session.me) {
    main.innerHTML = `<div class="gate"><h2>Not on the list yet</h2>
      <p>You're signed in as <b>${esc(session.email)}</b>, but you aren't a movie night participant.</p>
      <p class="muted">Ask an admin to add this email in Settings.</p></div>`;
  } else if (session.needsSetup) {
    main.innerHTML = `<form class="gate" id="setup-form"><h2>Set up movie night</h2>
      <p class="muted">Create the first participant. You'll be the admin and can add everyone else.</p>
      <label class="field">Your name <input name="name" required maxlength="40"></label>
      <label class="field">Your Google account email <input name="email" type="email" required></label>
      <p class="muted small">Use the address you'll sign in with through the public URL.</p>
      <button class="btn primary">Create</button></form>`;
    $("#setup-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      if (await act(() => api("POST", "/api/setup", { name: f.get("name"), email: f.get("email") }))) boot();
    });
  } else {
    main.innerHTML = `<div class="gate"><h2>Who's watching?</h2>
      <div class="picker-list">${session.choices.map((p) => `<button class="btn" data-action="pick-user" data-email="${esc(p.email)}">${esc(p.name)}</button>`).join("")}</div></div>`;
  }
}

// ---------- movie popover ----------

const pop = $("#movie-pop");
let popFor = null;      // element the card is showing for
let showTimer = null;
let hideTimer = null;

/** What the viewer can do with this movie from the card, based on where the poster is. */
function popAction(el, m) {
  if (el.closest("#propose-dialog")) {
    const added = draft.some((d) => d.id === m.id);
    if (added) return `<span class="muted small">In your choices</span>`;
    return draft.length < 3 ? `<button class="btn primary small" data-action="draft-add" data-id="${m.id}">Add to choices</button>` : "";
  }
  const date = el.closest(".night")?.dataset.date;
  const n = date && state.upcoming.find((x) => x.date === date);
  if (!n) return "";
  const override = n.canOverride && overriding.has(n.date);
  if (!(n.canChoose || (override && n.proposals.length === 3))) return "";
  if (n.selectedId === m.id) return `<span class="badge picked">Picked</span>`;
  return `<button class="btn primary small" data-action="pick" data-date="${n.date}" data-id="${m.id}">${n.selectedId ? "Switch to this" : "Pick this"}</button>`;
}

function popHtml(m, action) {
  const meta = [
    m.certification ? `<span class="cert">${esc(m.certification)}</span>` : "",
    m.rating ? `<span class="stars">★ ${m.rating.toFixed(1)}</span><span>(${m.voteCount.toLocaleString()})</span>` : "",
    m.runtime ? `<span>${fmtRuntime(m.runtime)}</span>` : "",
    m.genres?.length ? `<span>${esc(m.genres.slice(0, 3).join(", "))}</span>` : "",
  ].filter(Boolean).join(`<span class="dot">·</span>`);
  const cast = (m.cast ?? []).slice(0, 5).map((c) => esc(c.name)).join(", ");
  const streaming = m.streaming == null ? ""
    : m.streaming.length
      ? `<dt>Streaming</dt><dd>${esc(m.streaming.slice(0, 4).join(", "))}</dd>`
      : `<dt>Streaming</dt><dd class="muted">Not on subscription services in ${esc(m.region)}</dd>`;
  return `
    ${m.backdropPath ? `<div class="pop-backdrop" style="background-image:url('${IMG}w780${esc(m.backdropPath)}')"></div>` : ""}
    <div class="pop-content">
      <h3>${esc(m.title)} <span class="yr">${esc(m.year ?? "")}</span></h3>
      ${m.originalTitle ? `<div class="muted small">${esc(m.originalTitle)}</div>` : ""}
      <div class="pop-meta">${meta}</div>
      ${m.tagline ? `<p class="tagline">${esc(m.tagline)}</p>` : ""}
      ${m.overview ? `<p class="overview">${esc(m.overview)}</p>` : ""}
      <dl class="credits">
        ${m.directors?.length ? `<dt>Director</dt><dd>${esc(m.directors.join(", "))}</dd>` : ""}
        ${cast ? `<dt>Starring</dt><dd>${cast}</dd>` : ""}
        ${streaming}
      </dl>
      <div class="pop-foot">
        <div class="pop-links">
          ${m.trailerKey ? `<a href="https://www.youtube.com/watch?v=${esc(m.trailerKey)}" target="_blank" rel="noopener">▶ Trailer</a>` : ""}
          <a href="https://www.themoviedb.org/movie/${m.id}" target="_blank" rel="noopener">TMDB</a>
          ${m.imdbId ? `<a href="https://www.imdb.com/title/${esc(m.imdbId)}/" target="_blank" rel="noopener">IMDb</a>` : ""}
        </div>
        ${action}
      </div>
    </div>`;
}

async function showPop(el) {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  const id = Number(el.dataset.movie);
  popFor = el;
  let m = movieCache.get(id);
  if (!m || !("streaming" in m) || m.streaming === null) {
    // Search results and older cache entries lack full details; show what we have while loading.
    if (m) renderPop(el, m);
    try { m = await api("GET", `/api/movie/${id}`); movieCache.set(id, m); } catch { if (!m) return; }
    if (popFor !== el) return;
  }
  renderPop(el, m);
}

function renderPop(el, m) {
  pop.innerHTML = popHtml(m, popAction(el, m));
  // Modal dialogs live in the top layer; the card must be inside one to show above it.
  const host = el.closest("dialog") ?? document.body;
  if (pop.parentElement !== host) host.appendChild(pop);
  pop.hidden = false;
  placePop(el);
}

function placePop(el) {
  const r = el.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight, gap = 12, pad = 12;
  let left = r.right + gap;
  if (left + w > innerWidth - pad) left = r.left - gap - w;
  let top = r.top + Math.min(0, (r.height - h) / 2);
  if (left < pad) { // no room on either side: go below/above
    left = Math.min(Math.max(pad, r.left + r.width / 2 - w / 2), innerWidth - w - pad);
    top = r.bottom + gap + h < innerHeight ? r.bottom + gap : r.top - gap - h;
  }
  top = Math.min(Math.max(pad, top), innerHeight - h - pad);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function hidePop() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  popFor = null;
  pop.hidden = true;
}

function scheduleShow(el) {
  clearTimeout(hideTimer);
  if (el === popFor) return;
  clearTimeout(showTimer);
  // Moving between posters while a card is open switches immediately.
  showTimer = setTimeout(() => showPop(el), pop.hidden ? 160 : 0);
}

function scheduleHide() {
  clearTimeout(showTimer);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hidePop, 200); // grace period to move the mouse onto the card
}

const posterOf = (node) => node?.closest?.("[data-movie]") ?? null;

document.addEventListener("pointerover", (e) => {
  if (e.pointerType !== "mouse") return;
  const el = posterOf(e.target);
  if (el) scheduleShow(el);
  else if (pop.contains(e.target)) clearTimeout(hideTimer);
});
document.addEventListener("pointerout", (e) => {
  if (e.pointerType !== "mouse") return;
  const from = posterOf(e.target) ?? (pop.contains(e.target) ? pop : null);
  if (!from) return;
  const to = e.relatedTarget;
  if (to && (from.contains(to) || pop.contains(to) || (popFor && popFor.contains(to)))) return;
  scheduleHide();
});
// Keyboard: focusing a poster (or a search result) shows its card.
document.addEventListener("focusin", (e) => {
  const el = posterOf(e.target) ?? e.target.querySelector?.("[data-movie]");
  if (el) showPop(el);
  else if (!pop.contains(e.target)) hidePop();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { hidePop(); e.stopPropagation(); } }, true);
// Hide on page/list scroll, but not when scrolling inside the card itself.
addEventListener("scroll", (e) => { if (!pop.contains(e.target)) hidePop(); }, { passive: true, capture: true });
addEventListener("resize", hidePop);

// ---------- proposing ----------

const proposeDlg = $("#propose-dialog");
let draft = [];      // movie objects (search results or details)
let draftDate = null;
let searchSeq = 0;

function openPropose(date) {
  const n = state.upcoming.find((x) => x.date === date) ?? state.past.find((x) => x.date === date);
  draftDate = date;
  draft = n.proposals.map((m) => ({ ...m }));
  $("#propose-date").textContent = fmtDate(date, { weekday: "short", month: "short", day: "numeric" });
  $("#search-input").value = "";
  $("#search-results").innerHTML = `<p class="muted small">Search for a movie, then click it to add it to a slot.</p>`;
  renderDraft();
  proposeDlg.showModal();
  $("#search-input").focus();
}

function renderDraft() {
  $("#draft-slots").innerHTML = [0, 1, 2].map((i) => {
    const m = draft[i];
    if (!m) return `<div class="draft-slot empty">Choice ${i + 1}</div>`;
    const img = m.posterPath ? `<img src="${IMG}w92${esc(m.posterPath)}" alt="">` : `<span class="thumb"></span>`;
    return `<div class="draft-slot">${img}<div class="info"><b>${esc(m.title)}</b><span class="muted">${esc(m.year ?? "")}</span></div>
      <button type="button" class="icon-btn" data-action="draft-remove" data-index="${i}" aria-label="Remove">&times;</button></div>`;
  }).join("");
  const n = draft.length;
  $("#propose-save").disabled = n !== 3;
  $("#propose-hint").textContent = n === 3 ? "All set." : `${3 - n} more to go.`;
  for (const b of document.querySelectorAll("#search-results .result")) b.disabled = n >= 3 || draft.some((m) => m.id === Number(b.dataset.id));
}

async function runSearch() {
  const qv = $("#search-input").value.trim();
  const box = $("#search-results");
  if (qv.length < 2) return;
  const seq = ++searchSeq;
  box.innerHTML = `<p class="muted small">Searching…</p>`;
  try {
    const { results } = await api("GET", `/api/search?q=${encodeURIComponent(qv)}`);
    if (seq !== searchSeq) return;
    box.innerHTML = results.length ? results.map((m) => `
      <button type="button" class="result" data-action="draft-add" data-id="${m.id}">
        ${posterHtml(m, { size: "w185" }).replace("<button", "<span").replace(/<\/button>$/, "</span>")}
        <span class="poster-title">${esc(m.title)} <span class="yr">${esc(m.year ?? "")}</span></span>
      </button>`).join("") : `<p class="muted small">No matches.</p>`;
    box._results = new Map(results.map((m) => [m.id, m]));
    renderDraft();
  } catch (e) {
    if (seq === searchSeq) box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
  }
}

let searchTimer;
$("#search-input").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
$("#search-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(searchTimer); runSearch(); } });
$("#propose-save").addEventListener("click", async () => {
  const ok = await act(() => api("PUT", `/api/nights/${draftDate}/proposals`, { tmdbIds: draft.map((m) => m.id) }), "Choices saved");
  if (ok) proposeDlg.close();
});
proposeDlg.addEventListener("close", hidePop);

// ---------- roles ----------

const rolesDlg = $("#roles-dialog");
let rolesDate = null;
function openRoles(date) {
  const n = state.upcoming.find((x) => x.date === date) ?? state.past.find((x) => x.date === date);
  rolesDate = date;
  $("#roles-date").textContent = fmtDate(date, { weekday: "short", month: "short", day: "numeric" });
  const opts = (sel) => `<option value="">Follow rotation</option>` + state.participants.filter((p) => p.active)
    .map((p) => `<option value="${esc(p.email)}" ${sel === p.email ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  const f = $("#roles-form");
  f.proposer.innerHTML = opts(n.rolesOverridden ? n.proposer?.email : "");
  f.chooser.innerHTML = opts(n.rolesOverridden ? n.chooser?.email : "");
  rolesDlg.showModal();
}
$("#roles-save").addEventListener("click", async () => {
  const f = $("#roles-form");
  if (await act(() => api("PUT", `/api/nights/${rolesDate}/roles`, { proposer: f.proposer.value || null, chooser: f.chooser.value || null }), "Roles updated")) rolesDlg.close();
});

// ---------- settings ----------

const settingsDlg = $("#settings-dialog");
function openSettings() {
  const f = $("#settings-form");
  const s = state.settings;
  f.title.value = s.title;
  f.nightWeekday.value = String(s.nightWeekday);
  f.nightTime.value = s.nightTime;
  f.timezone.value = s.timezone;
  f.region.value = s.region;
  if (!$("#tz-list").children.length && Intl.supportedValuesOf)
    $("#tz-list").innerHTML = Intl.supportedValuesOf("timeZone").map((z) => `<option value="${z}">`).join("");
  renderParticipants();
  settingsDlg.showModal();
}

function renderParticipants() {
  const active = state.participants.filter((p) => p.active);
  const inactive = state.participants.filter((p) => !p.active);
  const row = (p, i) => `<li class="${p.active ? "" : "inactive"}">
    <span class="pos">${p.active ? i + 1 : ""}</span>
    <span class="who">${esc(p.name)}${p.isAdmin ? ` <span class="badge">admin</span>` : ""}<small>${esc(p.email)}</small></span>
    <span class="ctrl">
      ${p.active ? `
        <button class="btn small ghost" data-action="p-up" data-email="${esc(p.email)}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button class="btn small ghost" data-action="p-down" data-email="${esc(p.email)}" ${i === active.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
        <button class="btn small ghost" data-action="p-rename" data-email="${esc(p.email)}">Rename</button>
        ${p.email !== state.me.email ? `<button class="btn small ghost" data-action="p-email" data-email="${esc(p.email)}">Change email</button>` : ""}
        <button class="btn small ghost" data-action="p-admin" data-email="${esc(p.email)}">${p.isAdmin ? "Revoke admin" : "Make admin"}</button>
        <button class="btn small ghost" data-action="p-remove" data-email="${esc(p.email)}">Remove</button>`
      : `<button class="btn small" data-action="p-restore" data-email="${esc(p.email)}">Restore</button>`}
    </span></li>`;
  $("#participant-list").innerHTML = active.map(row).join("") + inactive.map((p) => row(p, -1)).join("");
}

$("#settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  await act(() => api("PUT", "/api/settings", {
    title: f.title.value, nightWeekday: Number(f.nightWeekday.value), nightTime: f.nightTime.value,
    timezone: f.timezone.value, region: f.region.value,
  }), "Settings saved");
});
$("#add-participant").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (await act(() => api("POST", "/api/participants", { name: f.name.value, email: f.email.value }), "Participant added")) {
    f.reset();
    renderParticipants();
  }
});

async function reorder(email, delta) {
  const order = state.participants.filter((p) => p.active).map((p) => p.email);
  const i = order.indexOf(email), j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  await act(() => api("PUT", "/api/participants/order", { emails: order }));
  renderParticipants();
}
const patchP = (email, body, msg) => act(() => api("PATCH", `/api/participants/${encodeURIComponent(email)}`, body), msg).then(renderParticipants);

// ---------- event delegation ----------

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-action]");
  // Tapping a poster toggles its card (touch has no hover); clicks outside the card close it.
  const posterEl = e.target.closest(".posters [data-movie], .past-item [data-movie]");
  if (posterEl && !t) {
    if (e.pointerType === "mouse") showPop(posterEl);
    else posterEl === popFor && !pop.hidden ? hidePop() : showPop(posterEl);
    return;
  }
  if (!e.target.closest("#movie-pop") && !e.target.closest(".result")) hidePop();
  if (!t) return;
  const { action, date, id, email } = t.dataset;
  switch (action) {
    case "propose": return openPropose(date);
    case "roles": return openRoles(date);
    case "override": overriding.has(date) ? overriding.delete(date) : overriding.add(date); return render();
    case "settings": return openSettings();
    case "pick": hidePop(); return act(() => api("PUT", `/api/nights/${date}/selection`, { tmdbId: Number(id) }), "Picked!");
    case "unpick": return act(() => api("PUT", `/api/nights/${date}/selection`, { tmdbId: null }), "Pick cleared");
    case "draft-add": {
      const m = $("#search-results")._results?.get(Number(id));
      if (m && draft.length < 3 && !draft.some((d) => d.id === m.id)) { draft.push(m); renderDraft(); }
      if (t.closest("#movie-pop")) hidePop();
      return;
    }
    case "draft-remove": draft.splice(Number(t.dataset.index), 1); return renderDraft();
    case "rename": {
      const name = prompt("Your display name", state.me.name);
      if (name && name.trim()) await act(() => api("PATCH", `/api/participants/${encodeURIComponent(state.me.email)}`, { name: name.trim() }), "Name updated");
      session.me = state.me;
      return renderUserbar();
    }
    case "switch-user": await api("DELETE", "/api/picker"); return boot();
    case "pick-user": await act(() => api("POST", "/api/picker", { email })); return boot();
    case "p-up": return reorder(email, -1);
    case "p-down": return reorder(email, 1);
    case "p-email": {
      const p = state.participants.find((x) => x.email === email);
      const next = prompt(`New Google account email for ${p.name}. Their nights, proposals and picks move with them.`, p.email);
      if (next && next.trim() && next.trim().toLowerCase() !== p.email) await patchP(email, { email: next.trim() }, "Email updated");
      return;
    }
    case "p-rename": {
      const p = state.participants.find((x) => x.email === email);
      const name = prompt(`Display name for ${p.email}`, p.name);
      if (name && name.trim()) await patchP(email, { name: name.trim() }, "Renamed");
      return;
    }
    case "p-admin": {
      const p = state.participants.find((x) => x.email === email);
      return patchP(email, { isAdmin: !p.isAdmin });
    }
    case "p-remove": if (confirm("Remove this participant from the rotation? Past nights keep their name.")) await patchP(email, { active: false }, "Removed"); return;
    case "p-restore": return patchP(email, { active: true }, "Restored");
  }
});

// ---------- boot ----------

async function boot() {
  hidePop();
  try {
    session = await api("GET", "/api/me");
  } catch (e) {
    $("#main").innerHTML = `<div class="gate"><h2>Can't reach the server</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  if (!session.me) return renderGate();
  try {
    setState(await api("GET", "/api/state"));
  } catch (e) {
    $("#main").innerHTML = `<div class="gate"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
}

// Keep the page fresh when people come back to it.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session?.me && !document.querySelector("dialog[open]"))
    api("GET", "/api/state").then(setState).catch(() => {});
});

boot();
