// Shared app for the student study sites. Student-specific data lives in config.js,
// quiz banks in tests-*.js (window.TESTS[subjectId]).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js';
import { getFirestore, doc, onSnapshot, setDoc, collection, query, where, serverTimestamp, arrayUnion, increment } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-firestore.js';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js';

const S = window.SITE;
const TESTS = window.TESTS = window.TESTS || {};
const bankLoads = {};
function loadBank(id) { // tests-<subject>.js is fetched on first visit; a missing file just means no tests yet
  return bankLoads[id] ||= new Promise((ok) => {
    if (TESTS[id]) return ok(TESTS[id]);
    const sc = document.createElement('script');
    sc.src = `tests-${id}.js?h=${Math.floor(Date.now() / 36e5)}`; // hourly cache-bust so new questions show up
    sc.onload = sc.onerror = () => ok(TESTS[id]);
    document.head.appendChild(sc);
  });
}
const QUIZ_LEN = 30;
const DAYS = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subj = (id) => S.subjects.find((s) => s.id === id);

// ---- state synced from Firestore ----
let info = null;          // students/{sid}: {note, noteAt, order, start, grades[]}
let results = {};         // key `${subject}_${lesson}` -> {score, best, at, attempts, history[], missed[]}
let isMama = false;
let infoLoaded = false;

const fb = initializeApp(S.firebase);
const auth = getAuth(fb);
const db = getFirestore(fb);
const infoRef = doc(db, 'students', S.sid);

onSnapshot(infoRef, (snap) => { info = snap.exists() ? snap.data() : {}; infoLoaded = true; rerender(); },
  () => { infoLoaded = true; info = info || {}; rerender(); });
onSnapshot(query(collection(db, 'results'), where('sid', '==', S.sid)), (qs) => {
  results = {};
  qs.forEach((d) => { const r = d.data(); results[`${r.subject}_${r.lesson}`] = r; });
  rerender();
}, () => {});
onAuthStateChanged(auth, (u) => {
  isMama = !!u;
  $('mamaBtn').textContent = isMama ? '🔓 خروج ماما' : '🔒 ماما';
  $('mamaBtn').classList.toggle('on', isMama);
  rerender();
});

// ---- helpers ----
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2400);
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString('ar-u-nu-latn', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function shuffle(a, rnd = Math.random) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function seeded(str) { // small deterministic PRNG so each student gets a stable default order
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
function badge(r) {
  if (!r) return '<span class="badge">لم يُختبر</span>';
  const cls = r.score >= 24 ? 'g' : r.score >= 15 ? 'a' : 'r';
  return `<span class="badge ${cls}">${r.score}/${QUIZ_LEN}</span>`;
}

// ---- schedule ----
function scheduleOrder() {
  const ids = S.subjects.map((s) => s.id);
  const saved = (info && info.order || []).filter((id) => ids.includes(id));
  if (saved.length === ids.length) return saved;
  return shuffle(ids, seeded(S.sid));
}
function lastSaturday(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 1) % 7)); return x; }
function todaySlot(weeks) {
  const now = new Date();
  if (now.getDay() === 5) return null; // Friday
  const start = lastSaturday(info && info.start ? info.start.toDate() : new Date(2026, 9, 24));
  const w = Math.floor((lastSaturday(now) - start) / (7 * 864e5));
  return { week: ((w % weeks) + weeks) % weeks, day: (now.getDay() + 1) % 7 };
}

// ---- pages ----
const routes = {
  home() {
    const n = info && info.note;
    app.innerHTML = `
      <section class="note">
        <div class="head">🔔 تنبيه من ماما</div>
        ${isMama ? `
          <textarea id="noteTxt" placeholder="اكتبي ملاحظة لـ ${esc(S.name)}…">${esc(n || '')}</textarea>
          <div class="acts"><button class="btn red" id="saveNote">حفظ التنبيه</button>
          <button class="btn ghost" id="clearNote">مسح</button></div>`
        : `<div class="txt ${n ? '' : 'empty'}">${infoLoaded ? esc(n || 'لا يوجد تنبيه حالياً') : 'جاري التحميل…'}</div>`}
        ${info && info.noteAt ? `<div class="when">🕒 آخر تعديل: ${fmtDate(info.noteAt)}</div>` : ''}
      </section>
      <div class="big">
        <a class="bigbtn" href="#/schedule"><span class="ic">🗓️</span><b>جدول الدراسة</b><small>مادة لكل يوم</small></a>
        <a class="bigbtn" href="#/subjects"><span class="ic">📚</span><b>المواد</b><small>الكتب والاختبارات</small></a>
        <a class="bigbtn" href="#/report"><span class="ic">📊</span><b>التقرير</b><small>نقاط القوة والضعف</small></a>
        <a class="bigbtn" href="#/grades"><span class="ic">📝</span><b>علامات المدرسة</b><small>${isMama ? 'أضيفي علامة' : 'علاماتي'}</small></a>
        <a class="bigbtn wide" href="#/ai"><span class="ic">🤖</span><b>المساعد الذكي</b><small>اسأله عن أي شيء في دروسك</small></a>
      </div>`;
    if (isMama) {
      $('saveNote').onclick = () => saveNote($('noteTxt').value.trim());
      $('clearNote').onclick = () => { $('noteTxt').value = ''; saveNote(''); };
    }
  },

  schedule() {
    const order = scheduleOrder();
    const weeks = Math.max(1, Math.ceil(order.length / DAYS.length));
    const slot = todaySlot(weeks);
    const todaySubj = slot && slot.day < 6 ? subj(order[slot.week * 6 + slot.day]) : null;
    let html = `<h2 class="page">🗓️ جدول الدراسة</h2>`;
    html += slot === null
      ? `<div class="today"><span class="ic">🌴</span><div><b>اليوم الجمعة — عطلة</b><div class="muted">استمتع بيومك!</div></div></div>`
      : `<div class="today"><span class="ic">${todaySubj ? todaySubj.icon : '🔁'}</span><div><div class="muted">مادة اليوم</div><b>${todaySubj ? esc(todaySubj.name) : 'مراجعة عامة'}</b></div></div>`;
    for (let w = 0; w < weeks; w++) {
      html += `<div class="week">${weeks > 1 ? `<h3>الأسبوع ${w === 0 ? 'الأول' : w === 1 ? 'الثاني' : w + 1}</h3>` : ''}<table class="sched">`;
      DAYS.forEach((d, i) => {
        const s = subj(order[w * 6 + i]);
        const now = slot && slot.week === w && slot.day === i;
        html += `<tr class="${now ? 'now' : ''}"><td>${d}</td><td>${s ? `<span class="dot" style="--c:${s.color}"></span>${s.icon} ${esc(s.name)}` : '🔁 مراجعة عامة'}</td></tr>`;
      });
      html += `<tr class="fri"><td>الجمعة</td><td>🌴 عطلة</td></tr></table></div>`;
    }
    if (isMama) html += `<div class="center"><button class="btn" id="reshuffle">🔀 ترتيب عشوائي جديد</button></div>`;
    app.innerHTML = html;
    if (isMama) $('reshuffle').onclick = async () => {
      try { await setDoc(infoRef, { order: shuffle(S.subjects.map((s) => s.id)), start: serverTimestamp() }, { merge: true }); toast('تم ترتيب الجدول من جديد'); }
      catch { toast('ما زبط الحفظ، جربي مرة ثانية'); }
    };
  },

  subjects() {
    app.innerHTML = `<h2 class="page">📚 المواد</h2><div class="grid">${S.subjects.map((s) =>
      `<a class="subj" style="--c:${s.color}" href="#/subject/${s.id}"><span class="ic">${s.icon}</span><b>${esc(s.name)}</b></a>`).join('')}</div>`;
  },

  subject(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ ${esc(s.name)}</div>
      <h2 class="page">${s.icon} ${esc(s.name)}</h2>
      <div class="big">
        <a class="bigbtn" href="#/books/${s.id}"><span class="ic">📕</span><b>الكتاب</b><small>PDF</small></a>
        <a class="bigbtn" href="#/tests/${s.id}"><span class="ic">📝</span><b>اختبارات</b><small>${QUIZ_LEN} سؤال لكل درس</small></a>
      </div>`;
  },

  books(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    const books = s.books || [];
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/subject/${s.id}">${esc(s.name)}</a> ‹ الكتاب</div>
      <h2 class="page">📕 كتاب ${esc(s.name)}</h2>
      ${books.length ? books.map((b, i) => `<a class="lesson" href="#/read/${s.id}/${i}"><span class="t">📄 ${esc(b.title)}</span><span class="badge">فتح</span></a>`).join('')
        : '<div class="card center muted">الكتاب رح ينضاف قريباً</div>'}`;
  },

  read(id, idx) {
    const s = subj(id), b = s && (s.books || [])[+idx];
    if (!b) return go('#/subjects');
    app.innerHTML = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/books/${s.id}">كتاب ${esc(s.name)}</a> ‹ ${esc(b.title)}</div>
      <div class="readbar"><b>📕 ${esc(s.name)} — ${esc(b.title)}</b><span id="pgInfo" class="muted">جاري تحميل الكتاب…</span>
        <a class="btn ghost" href="${esc(b.file)}" target="_blank" rel="noopener">⬇️ تنزيل</a></div>
      <div id="pages" class="pages"></div>`;
    openBook(b.file);
  },

  tests(id) {
    const s = subj(id); if (!s) return go('#/subjects');
    if (!(id in TESTS)) { app.innerHTML = '<div class="card center muted">جاري التحميل…</div>'; loadBank(id).then(() => { TESTS[id] ||= null; rerender(); }); return; }
    const bank = TESTS[id];
    let html = `<div class="crumb"><a href="#/subjects">المواد</a> ‹ <a href="#/subject/${s.id}">${esc(s.name)}</a> ‹ اختبارات</div>
      <h2 class="page">📝 اختبارات ${esc(s.name)}</h2>`;
    if (!bank || !bank.units.length) html += '<div class="card center muted">الاختبارات رح تنضاف قريباً</div>';
    else bank.units.forEach((u) => {
      html += `<section class="unit"><h3>${esc(u.title)}</h3>${u.lessons.map((l) =>
        `<a class="lesson" href="#/quiz/${s.id}/${l.id}"><span class="t">اختبار ${esc(l.title)}</span>${badge(results[`${s.id}_${l.id}`])}</a>`).join('')}</section>`;
    });
    app.innerHTML = html;
  },

  quiz(id, lid) {
    if (!(id in TESTS)) { loadBank(id).then(() => { TESTS[id] ||= null; render(); }); return; }
    const s = subj(id), bank = TESTS[id];
    const lesson = bank && bank.units.flatMap((u) => u.lessons).find((l) => l.id === lid);
    if (!s || !lesson) return go('#/subjects');
    runQuiz(s, lesson);
  },

  report(id) {
    if (id) return subjectReport(id);
    const st = S.subjects.map((s) => ({ s, ...subjectStats(s.id) }));
    const tested = st.filter((x) => x.n);
    const ranked = tested.slice().sort((a, b) => b.avg - a.avg);
    let html = `<h2 class="page">📊 تقرير ${esc(S.name)}</h2>`;
    if (!tested.length && !grades().length) html += '<div class="card center muted">لسا ما في اختبارات. لما يحل الاختبارات بيظهر التقرير هون.</div>';
    else {
      html += `<div class="statrow">
        <div class="stat"><b>${tested.reduce((a, x) => a + x.attempts, 0)}</b><small>محاولة اختبار</small></div>
        <div class="stat"><b>${tested.reduce((a, x) => a + x.n, 0)}</b><small>درس مختبَر</small></div>
        <div class="stat"><b>${tested.length ? Math.round(tested.reduce((a, x) => a + x.avg, 0) / tested.length) : 0}%</b><small>المعدل العام</small></div></div>`;
      if (ranked.length) html += `<div class="sw">
        <div class="card"><h3>💪 نقاط القوة</h3>${ranked.filter((x) => x.avg >= 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.avg}%</b></div>`).join('') || '<div class="muted">بعد شوية اختبارات بتبين</div>'}</div>
        <div class="card"><h3>📌 بحاجة لتقوية</h3>${ranked.slice().reverse().filter((x) => x.avg < 75).slice(0, 3).map((x) => `<div>${x.s.icon} ${esc(x.s.name)} <b>${x.avg}%</b></div>`).join('') || '<div class="muted">ممتاز، ما في مواد ضعيفة 👏</div>'}</div></div>`;
    }
    html += `<h3 style="margin-top:18px">حسب المادة</h3><div class="grid">${st.map((x) => `
      <a class="subj rep" style="--c:${x.s.color}" href="#/report/${x.s.id}"><span class="ic">${x.s.icon}</span><b>${esc(x.s.name)}</b>
        ${x.n ? `<div class="meter"><i style="width:${x.avg}%;background:${lvl(x.avg).c}"></i></div><small>${x.avg}% • ${x.n} درس • ${x.attempts} محاولة</small>` : '<small class="muted">لم يُختبر</small>'}
        ${x.g.length ? `<small>📝 علامات المدرسة: ${x.gAvg}%</small>` : ''}</a>`).join('')}</div>`;
    app.innerHTML = html;
  },

  grades() {
    const gs = grades().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    let html = `<h2 class="page">📝 علامات المدرسة</h2>`;
    if (isMama) html += `<div class="card gform"><h3>➕ إضافة علامة</h3>
      <label>المادة<select id="gSub">${S.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label>اسم الامتحان<input id="gTitle" placeholder="مثلاً: امتحان شهر أول"></label>
      <div class="two"><label>العلامة<input id="gScore" type="number" min="0" step="0.5"></label>
      <label>من<input id="gOut" type="number" min="1" value="20"></label></div>
      <label>التاريخ<input id="gDate" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
      <button class="btn green" id="gAdd">حفظ العلامة</button></div>`;
    else html += '<div class="muted" style="margin-bottom:10px">ماما بتضيف علامات امتحانات المدرسة من زر 🔒 ماما.</div>';
    html += gs.length ? `<table class="gt"><tr><th>المادة</th><th>الامتحان</th><th>العلامة</th><th>التاريخ</th>${isMama ? '<th></th>' : ''}</tr>${gs.map((g) => {
      const s = subj(g.subject), p = Math.round(g.score / g.outOf * 100);
      return `<tr><td>${s ? s.icon + ' ' + esc(s.name) : ''}</td><td>${esc(g.title)}</td><td><span class="badge" style="background:${lvl(p).bg};color:${lvl(p).c}">${g.score}/${g.outOf}</span></td><td>${esc(g.date || '')}</td>${isMama ? `<td><button class="x" data-id="${g.id}">🗑</button></td>` : ''}</tr>`; }).join('')}</table>`
      : '<div class="card center muted">لا توجد علامات بعد</div>';
    app.innerHTML = html;
    if (!isMama) return;
    $('gAdd').onclick = async () => {
      const g = { id: Date.now().toString(36), subject: $('gSub').value, title: $('gTitle').value.trim() || 'امتحان', score: +$('gScore').value, outOf: +$('gOut').value, date: $('gDate').value };
      if (!(g.outOf > 0) || $('gScore').value === '' || g.score < 0 || g.score > g.outOf) return toast('تأكدي من العلامة');
      try { await setDoc(infoRef, { grades: arrayUnion(g) }, { merge: true }); toast('تم حفظ العلامة ✅'); } catch { toast('ما زبط الحفظ'); }
    };
    app.querySelectorAll('.x').forEach((b) => b.onclick = async () => {
      if (!confirm('حذف هذه العلامة؟')) return;
      try { await setDoc(infoRef, { grades: grades().filter((g) => g.id !== b.dataset.id) }, { merge: true }); toast('تم الحذف'); } catch { toast('ما زبط الحذف'); }
    });
  },

  ai() {
    app.innerHTML = `<h2 class="page">🤖 المساعد الذكي</h2>
      <div class="muted" style="margin-bottom:8px">اسأل عن أي درس أو سؤال، أو اطلب خطة مراجعة لنقاط ضعفك.</div>
      <div class="chat" id="chat">${chatLog.map(bubble).join('') || `<div class="msg bot">أهلاً ${esc(S.name)} 👋 أنا مساعدك في الدراسة. شو بتحب نتعلم اليوم؟</div>`}</div>
      <div class="chips">${['اعملّي خطة مراجعة لنقاط ضعفي', 'اشرحلي درساً من كتاب العربي بطريقة سهلة', 'اسألني 5 أسئلة في الرياضيات', 'كيف أنظّم وقت دراستي؟'].map((t) => `<button class="chip">${t}</button>`).join('')}</div>
      <form class="ask" id="askF"><input id="askQ" placeholder="اكتب سؤالك…" autocomplete="off"><button class="btn">إرسال</button></form>`;
    const box = $('chat'); box.scrollTop = box.scrollHeight;
    app.querySelectorAll('.chip').forEach((c) => c.onclick = () => askAI(c.textContent));
    $('askF').onsubmit = (e) => { e.preventDefault(); const q = $('askQ').value.trim(); if (q) { $('askQ').value = ''; askAI(q); } };
  },
};
routes.subject.keep = routes.books.keep = routes.read.keep = routes.ai.keep = true;

// ---- report helpers ----
const grades = () => (info && info.grades) || [];
const lvl = (p) => p >= 85 ? { c: '#15803d', bg: '#dcfce7', t: 'ممتاز' } : p >= 70 ? { c: '#2563eb', bg: '#dbeafe', t: 'جيد جداً' } : p >= 50 ? { c: '#b45309', bg: '#fef3c7', t: 'بحاجة لتحسين' } : { c: '#b91c1c', bg: '#fee2e2', t: 'ضعيف' };
const pct = (r) => Math.round(r.score / (r.total || QUIZ_LEN) * 100);
function lessonAvg(r) { const h = r.history && r.history.length ? r.history : [r]; return Math.round(h.reduce((a, x) => a + x.score / (x.total || QUIZ_LEN), 0) / h.length * 100); }
function subjectStats(id) {
  const rs = Object.values(results).filter((r) => r.subject === id);
  const g = grades().filter((x) => x.subject === id);
  return {
    rs, n: rs.length, attempts: rs.reduce((a, r) => a + (r.attempts || (r.history || [1]).length), 0),
    avg: rs.length ? Math.round(rs.reduce((a, r) => a + lessonAvg(r), 0) / rs.length) : 0,
    g, gAvg: g.length ? Math.round(g.reduce((a, x) => a + x.score / x.outOf, 0) / g.length * 100) : 0,
  };
}
function subjectReport(id) {
  const s = subj(id); if (!s) return go('#/report');
  const x = subjectStats(id);
  const rows = x.rs.map((r) => ({ r, avg: lessonAvg(r), last: pct(r) })).sort((a, b) => a.avg - b.avg);
  let html = `<div class="crumb"><a href="#/report">التقرير</a> ‹ ${esc(s.name)}</div><h2 class="page">${s.icon} تقرير ${esc(s.name)}</h2>`;
  html += `<div class="statrow"><div class="stat"><b>${x.avg}%</b><small>معدل الاختبارات</small></div>
    <div class="stat"><b>${x.n}</b><small>درس مختبَر</small></div><div class="stat"><b>${x.attempts}</b><small>محاولة</small></div>
    ${x.g.length ? `<div class="stat"><b>${x.gAvg}%</b><small>علامات المدرسة</small></div>` : ''}</div>`;
  if (!rows.length) html += '<div class="card center muted">لم يُختبر في هذه المادة بعد</div>';
  else {
    const weak = rows.filter((w) => w.avg < 70).slice(0, 3), strong = rows.slice().reverse().filter((w) => w.avg >= 85).slice(0, 3);
    html += `<div class="sw"><div class="card"><h3>💪 دروس قوي فيها</h3>${strong.map((w) => `<div>${esc(w.r.title || w.r.lesson)} <b>${w.avg}%</b></div>`).join('') || '<div class="muted">—</div>'}</div>
      <div class="card"><h3>📌 دروس بحاجة لمراجعة</h3>${weak.map((w) => `<div><a href="#/quiz/${id}/${w.r.lesson}">${esc(w.r.title || w.r.lesson)}</a> <b>${w.avg}%</b></div>`).join('') || '<div class="muted">لا يوجد 👏</div>'}</div></div>
      <h3 style="margin-top:16px">كل الدروس (الأضعف أولاً)</h3>
      <table class="gt"><tr><th>الدرس</th><th>المعدل</th><th>آخر محاولة</th><th>أفضل</th><th>المحاولات</th></tr>${rows.map((w) => `
        <tr><td>${esc(w.r.title || w.r.lesson)}</td><td><span class="badge" style="background:${lvl(w.avg).bg};color:${lvl(w.avg).c}">${w.avg}%</span></td>
        <td>${w.r.score}/${w.r.total || QUIZ_LEN}</td><td>${w.r.best ?? w.r.score}</td><td>${w.r.attempts || (w.r.history || [1]).length}</td></tr>`).join('')}</table>`;
    const missed = rows.slice(0, 3).flatMap((w) => (w.r.missed || []).slice(0, 4));
    if (missed.length) html += `<div class="card" style="margin-top:14px"><h3>❓ أسئلة أخطأ فيها مؤخراً</h3>${missed.map((q) => `<div class="mq">• ${esc(q)}</div>`).join('')}</div>`;
  }
  if (x.g.length) html += `<h3 style="margin-top:16px">📝 علامات المدرسة</h3><table class="gt">${x.g.map((g) => `<tr><td>${esc(g.title)}</td><td>${g.score}/${g.outOf}</td><td>${esc(g.date || '')}</td></tr>`).join('')}</table>`;
  app.innerHTML = html;
}

// ---- smart assistant (Gemini via Firebase AI Logic) ----
const chatLog = [];
let aiChat = null;
const AI_MODELS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'];
const bubble = (m) => `<div class="msg ${m.who}">${m.who === 'bot' ? fmtAI(m.text) : esc(m.text)}</div>`;
function fmtAI(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/^[*-] /gm, '• ').replace(/\n/g, '<br>'); }
function studentSummary() {
  const st = S.subjects.map((s) => ({ s, ...subjectStats(s.id) })).filter((x) => x.n || x.g.length);
  if (!st.length) return 'لم يحل الطالب أي اختبار بعد.';
  return st.map((x) => {
    const weak = x.rs.map((r) => ({ t: r.title || r.lesson, a: lessonAvg(r) })).sort((a, b) => a.a - b.a).slice(0, 3).filter((w) => w.a < 70);
    return `- ${x.s.name}: معدل الاختبارات ${x.avg}%${x.g.length ? `، علامات المدرسة ${x.gAvg}%` : ''}${weak.length ? `، دروس ضعيفة: ${weak.map((w) => `${w.t} (${w.a}%)`).join('، ')}` : ''}`;
  }).join('\n');
}
async function newChat() { // returns a factory: model name -> chat session
  const ai = getAI(fb, { backend: new GoogleAIBackend() });
  const sys = `أنت «المساعد الذكي»، معلّم خصوصي لطيف وصبور للطالب ${S.name} في ${S.grade} (المنهاج الفلسطيني).
المواد: ${S.subjects.map((s) => s.name).join('، ')}.
أداء الطالب الحالي من موقعه:
${studentSummary()}
تعليمات:
- تكلّم بالعربية الفصحى المبسطة (ويمكن لمسة من اللهجة الفلسطينية)، بأسلوب يناسب عمر الطالب${/الثالث/.test(S.grade) ? ' (طفل عمره نحو 8 سنوات: جمل قصيرة جداً وأمثلة من حياته)' : ''}.
- اشرح خطوة بخطوة واسأل الطالب ليفكّر، ولا تعطِ حلّ الواجب كاملاً دون شرح.
- عند طلب خطة مراجعة ركّز على الدروس الضعيفة أعلاه.
- في الإنجليزي اشرح بالعربية مع أمثلة إنجليزية.
- إجاباتك قصيرة وواضحة، وابتعد عن أي موضوع غير مناسب للأطفال، وأعد الطالب بلطف إلى الدراسة.`;
  return (m) => getGenerativeModel(ai, { model: m, systemInstruction: sys }).startChat({
    history: chatLog.filter((x) => x.ok).map((x) => ({ role: x.who === 'me' ? 'user' : 'model', parts: [{ text: x.text }] })),
  });
}
let aiModel = 0; // index into AI_MODELS; advances if a model name is unavailable
async function askAI(q) {
  chatLog.push({ who: 'me', text: q });
  const pending = { who: 'bot', text: '…' }; chatLog.push(pending);
  if (parse().name === 'ai') routes.ai();
  try {
    let r;
    for (;;) {
      try {
        aiChat ||= (await newChat())(AI_MODELS[aiModel]);
        r = await aiChat.sendMessage(q); break;
      } catch (e) {
        aiChat = null;
        if (/not found|404|not supported/i.test(String(e && e.message)) && aiModel < AI_MODELS.length - 1) { aiModel++; continue; }
        throw e;
      }
    }
    pending.text = r.response.text(); pending.ok = true; chatLog[chatLog.length - 2].ok = true;
  } catch (e) {
    aiChat = null;
    pending.text = /not.?enabled|has not been used|PERMISSION|api-not-enabled|403/i.test(String(e && e.message))
      ? 'المساعد الذكي لسا مش مفعّل. ماما لازم تفعّل «AI Logic» من Firebase مرة وحدة.'
      : 'صار خطأ بالاتصال، جرّب مرة ثانية بعد شوي.';
    console.warn('AI error', e);
  }
  if (parse().name === 'ai') routes.ai();
}

// ---- in-site book reader (pdf.js, pages rendered as they scroll into view) ----
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let pdfjsReady;
function loadPdfjs() {
  return pdfjsReady ||= new Promise((ok, fail) => {
    const sc = document.createElement('script');
    sc.src = PDFJS + 'pdf.min.js';
    sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.js'; ok(window.pdfjsLib); };
    sc.onerror = fail;
    document.head.appendChild(sc);
  });
}
async function openBook(file) {
  const box = $('pages'), info = $('pgInfo');
  try {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ url: file, cMapUrl: PDFJS + 'cmaps/', cMapPacked: true, standardFontDataUrl: PDFJS + 'standard_fonts/' }).promise;
    if (!box.isConnected) return;
    info.textContent = `${pdf.numPages} صفحة`;
    const first = await pdf.getPage(1), vp1 = first.getViewport({ scale: 1 });
    const io = new IntersectionObserver((ents) => ents.forEach((e) => {
      if (!e.isIntersecting || e.target.dataset.done) return;
      e.target.dataset.done = 1; io.unobserve(e.target); drawPage(pdf, +e.target.dataset.n, e.target);
    }), { rootMargin: '800px 0px' });
    for (let n = 1; n <= pdf.numPages; n++) {
      const d = document.createElement('div');
      d.className = 'page'; d.dataset.n = n;
      d.style.aspectRatio = `${vp1.width} / ${vp1.height}`;
      d.innerHTML = `<span class="pn">${n}</span>`;
      box.appendChild(d); io.observe(d);
    }
  } catch (e) {
    info.textContent = 'ما قدرنا نعرض الكتاب هون — اضغط تنزيل لفتحه';
  }
}
async function drawPage(pdf, n, el) {
  const page = await pdf.getPage(n);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale: (el.clientWidth / page.getViewport({ scale: 1 }).width) * dpr });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  el.style.aspectRatio = `${vp.width} / ${vp.height}`;
  el.prepend(c);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}

// ---- quiz engine ----
const MATHY = /^[\d\s+−×÷=().,/^²³√-]+$/; // bare arithmetic reads left-to-right even on an RTL page
const LATIN = /^[\s"'(«]*[A-Za-z]/;
const dirAttr = (t) => LATIN.test(t) ? ' dir="ltr" style="text-align:left"' : MATHY.test(t) ? ' dir="ltr" style="text-align:right"' : '';
function runQuiz(s, lesson) {
  const qs = shuffle(lesson.q).slice(0, QUIZ_LEN).map(([text, opts]) => {
    const order = shuffle(opts.map((o, i) => i));
    return { text, opts: order.map((i) => opts[i]), correct: order.indexOf(0) };
  });
  let i = 0, score = 0;
  const wrong = [];
  const back = `<div class="crumb"><a href="#/tests/${s.id}">اختبارات ${esc(s.name)}</a> ‹ ${esc(lesson.title)}</div>`;

  function show() {
    const q = qs[i];
    app.innerHTML = `${back}<div class="card">
      <div class="qnum"><span>السؤال ${i + 1} من ${qs.length}</span><span>✅ ${score}</span></div>
      <div class="qbar"><i style="width:${(i / qs.length) * 100}%"></i></div>
      <div class="qtext"${dirAttr(q.text)}>${esc(q.text)}</div>
      <div class="opts">${q.opts.map((o, k) => `<button class="opt" data-k="${k}"${dirAttr(o)}>${esc(o)}</button>`).join('')}</div>
      <div class="qnext" id="qnext"></div></div>`;
    app.querySelectorAll('.opt').forEach((b) => b.onclick = () => pick(+b.dataset.k));
  }
  function pick(k) {
    const q = qs[i], btns = app.querySelectorAll('.opt');
    btns.forEach((b) => b.disabled = true);
    btns[q.correct].classList.add('ok');
    if (k === q.correct) score++;
    else { btns[k].classList.add('bad'); wrong.push({ q: q.text, a: q.opts[k], c: q.opts[q.correct] }); }
    const last = i === qs.length - 1;
    $('qnext').innerHTML = `<button class="btn" id="nx">${last ? 'النتيجة 🎉' : 'التالي ←'}</button>`;
    $('nx').onclick = () => { if (last) finish(); else { i++; show(); } };
  }
  async function finish() {
    const total = qs.length;
    const msg = score >= total * .9 ? 'ممتاز! 🌟' : score >= total * .75 ? 'أحسنت! 👏' : score >= total * .5 ? 'جيد، راجع الأخطاء 💪' : 'بحاجة لمراجعة الدرس 📖';
    app.innerHTML = `${back}<div class="card center">
      <div class="muted">نتيجتك في ${esc(lesson.title)}</div>
      <div class="score">${score}<small> / ${total}</small></div>
      <h3>${msg}</h3>
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:10px">
        <a class="btn" href="#/quiz/${s.id}/${lesson.id}?r=${Date.now()}">🔁 أعد الاختبار</a>
        <a class="btn ghost" href="#/tests/${s.id}">رجوع للدروس</a></div>
      ${wrong.length ? `<div class="review"><h3>راجع الأخطاء (${wrong.length})</h3>${wrong.map((w) =>
        `<div class="it"><div>${esc(w.q)}</div><div class="w">إجابتك: ${esc(w.a)}</div><div class="c">الصحيح: ${esc(w.c)}</div></div>`).join('')}</div>` : ''}
    </div>`;
    const key = `${s.id}_${lesson.id}`, prev = results[key];
    try {
      // history keeps every attempt for the report; missed keeps the last attempt's wrong questions
      await setDoc(doc(db, 'results', `${S.sid}_${key}`), {
        sid: S.sid, subject: s.id, lesson: lesson.id, title: lesson.title, score, total,
        best: Math.max(score, prev && prev.best || 0), at: serverTimestamp(),
        attempts: increment(1), history: arrayUnion({ score, total, t: Date.now() }),
        missed: wrong.map((w) => w.q).slice(0, 30),
      }, { merge: true });
    } catch { toast('ما انحفظت النتيجة (مشكلة اتصال)'); }
  }
  show();
}

// ---- mama ----
async function saveNote(text) {
  try { await setDoc(infoRef, { note: text, noteAt: serverTimestamp() }, { merge: true }); toast('تم حفظ التنبيه ✅'); }
  catch { toast('ما زبط الحفظ، جربي مرة ثانية'); }
}
function openLogin() {
  const m = $('modal');
  $('modalBox').innerHTML = `<h3>🔒 دخول ماما</h3><div class="muted">اكتبي كلمة المرور للتعديل</div>
    <input type="password" id="pw" autocomplete="current-password" placeholder="كلمة المرور">
    <div class="err" id="pwErr"></div>
    <div style="display:flex;gap:8px"><button class="btn" id="pwGo">دخول</button><button class="btn ghost" id="pwX">إلغاء</button></div>`;
  m.classList.add('show');
  const go = async () => {
    $('pwErr').textContent = '';
    try { await signInWithEmailAndPassword(auth, S.mamaEmail, $('pw').value); m.classList.remove('show'); toast('أهلاً ماما 💙'); }
    catch { $('pwErr').textContent = 'كلمة المرور غير صحيحة'; }
  };
  $('pwGo').onclick = go;
  $('pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
  $('pwX').onclick = () => m.classList.remove('show');
  setTimeout(() => $('pw').focus(), 50);
}
$('mamaBtn').onclick = () => isMama ? signOut(auth).then(() => toast('تم الخروج')) : openLogin();
$('modal').onclick = (e) => { if (e.target.id === 'modal') e.target.classList.remove('show'); };

// ---- router ----
function go(h) { location.hash = h; }
function parse() {
  const [path] = (location.hash.slice(1) || '/').split('?');
  const [name, ...args] = path.split('/').filter(Boolean);
  return { name: routes[name] ? name : 'home', args };
}
function render() { const r = parse(); routes[r.name](...r.args); window.scrollTo(0, 0); }
function rerender() { // live data changed: refresh only pages that show it, never mid-quiz or while typing
  const r = parse();
  if (r.name === 'quiz' || routes[r.name].keep) return;
  if (r.name === 'home' && document.activeElement && document.activeElement.id === 'noteTxt') return;
  routes[r.name](...r.args);
}

document.title = `${S.name} — ${S.grade}`;
$('sname').textContent = S.name;
$('sgrade').textContent = S.grade;
addEventListener('hashchange', render);
render();
