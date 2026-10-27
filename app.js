// Shared app for the student study sites. Student-specific data lives in config.js,
// quiz banks in tests-*.js (window.TESTS[subjectId]).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, onSnapshot, setDoc, collection, query, where, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const S = window.SITE, TESTS = window.TESTS || {};
const QUIZ_LEN = 30;
const DAYS = ['السبت', 'الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const $ = (id) => document.getElementById(id);
const app = $('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const subj = (id) => S.subjects.find((s) => s.id === id);

// ---- state synced from Firestore ----
let info = null;          // students/{sid}: {note, noteAt, order, start}
let results = {};         // key `${subject}_${lesson}` -> {score, best, at}
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
    const s = subj(id), bank = TESTS[id];
    const lesson = bank && bank.units.flatMap((u) => u.lessons).find((l) => l.id === lid);
    if (!s || !lesson) return go('#/subjects');
    runQuiz(s, lesson);
  },
};
routes.subject.keep = routes.books.keep = routes.read.keep = true;

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
      <div class="qtext">${esc(q.text)}</div>
      <div class="opts">${q.opts.map((o, k) => `<button class="opt" data-k="${k}">${esc(o)}</button>`).join('')}</div>
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
      await setDoc(doc(db, 'results', `${S.sid}_${key}`), {
        sid: S.sid, subject: s.id, lesson: lesson.id, score, total,
        best: Math.max(score, prev && prev.best || 0), at: serverTimestamp(),
      });
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
