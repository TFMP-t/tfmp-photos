/**
 * سكريبت واحد بيعمل حاجتين ورا بعض:
 * 1) يسحب أي وورك أوردر جديد (زي server.js بالظبط)
 * 2) يبني الموقع الثابت جوه فولدر docs/ عشان GitHub Pages يعرضه
 *
 * ده بيشتغل لوحده من غير أي تدخل، عن طريق GitHub Actions كل 6 ساعات
 * مش محتاج أي سيرفر شغال، ومجاني 100%
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const REAL_LIST_URL = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';
const REAL_REPORT_BASE = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';

// الكوكي بييجي من GitHub Secrets مش مكتوب هنا، عشان الأمان
const SESSION_COOKIE = process.env.TFMP_SESSION_COOKIE;

const DELAY_MS = 150;
const CONCURRENCY = 4;

const DATA_DIR = path.join(__dirname, 'data');
const PHOTOS_DIR = path.join(__dirname, 'photos');
const DOCS_DIR = path.join(__dirname, 'docs');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');
const SCHOOLS_FILE = path.join(DATA_DIR, 'schools.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('فشل قراءة', file, e.message); }
  return fallback;
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let processed = loadJson(PROCESSED_FILE, {});
let schools = loadJson(SCHOOLS_FILE, {});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json', 'Cookie': SESSION_COOKIE } });
  if (!res.ok) throw new Error(`HTTP ${res.status} على ${url}`);
  return res.json();
}

async function downloadFile(url, savePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`فشل تنزيل صورة: ${res.status}`);
  const buffer = await res.buffer();
  fs.mkdirSync(path.dirname(savePath), { recursive: true });
  fs.writeFileSync(savePath, buffer);
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function processWorkOrder(item) {
  const woNumber = item.work_order_number;
  const code = item.location_code || item.primary_school_name;

  const report = await apiGet(`${REAL_REPORT_BASE}/${woNumber}/inspection-report`);
  const wo = report.work_order;

  if (!schools[code]) {
    schools[code] = { name: wo.school_name || item.primary_school_name, site: wo.site || item.site || '', workOrders: {} };
  }

  const findingsMap = {};
  Object.values(report.sections || {}).flat().forEach(s => {
    findingsMap[s.service_area_code] = { en: s.service_area_en, finding: s.findings };
  });

  const localPhotosByArea = {};
  for (const [areaCode, photos] of Object.entries(report.photos_by_area || {})) {
    localPhotosByArea[areaCode] = [];
    for (const p of photos) {
      const localRelPath = `${code}/${woNumber}_${p.filename}`;
      const localFullPath = path.join(PHOTOS_DIR, localRelPath);
      if (!fs.existsSync(localFullPath)) {
        await downloadFile(p.signed_url, localFullPath);
        await sleep(DELAY_MS);
      }
      localPhotosByArea[areaCode].push({
        filename: p.filename,
        url: `/photos/${localRelPath}`,
        captured_at: p.captured_at
      });
    }
  }

  schools[code].workOrders[woNumber] = {
    status: wo.status,
    assignment_month: item.assignment_month,
    completion_date: wo.completion_date,
    photos_by_area: localPhotosByArea,
    findingsMap
  };

  processed[woNumber] = true;
}

async function runSync(scope) {
  const targetMonth = scope === 'current' ? currentMonth() : null;
  let page = 1;
  const limit = 100;

  while (true) {
    const url = `${REAL_LIST_URL}?page=${page}&limit=${limit}&order_by=assignment_month&order_dir=desc`;
    const listRes = await apiGet(url);
    const items = listRes.data || [];
    if (items.length === 0) break;

    let stop = false;
    const toProcess = [];

    for (const item of items) {
      if (targetMonth && item.assignment_month && item.assignment_month < targetMonth) {
        stop = true;
        break;
      }
      if (targetMonth && item.assignment_month !== targetMonth) continue;
      if (item.status !== 'COMPLETED') continue;
      if (processed[item.work_order_number]) continue;
      toProcess.push(item);
    }

    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const batch = toProcess.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (item) => {
        try {
          await processWorkOrder(item);
          console.log(`✔ ${item.work_order_number}`);
        } catch (err) {
          console.error(`❌ فشل ${item.work_order_number}:`, err.message);
        }
      }));
      saveJson(PROCESSED_FILE, processed);
      saveJson(SCHOOLS_FILE, schools);
      await sleep(DELAY_MS);
    }

    if (stop) break;
    if (items.length < limit) break;
    page++;
    await sleep(DELAY_MS);
  }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function buildStaticViewer() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>سجل صور تفتيش المدارس</title>
<style>
  :root{--ink:#1c2321;--paper:#f6f4ee;--panel:#fff;--line:#dcd7c9;--steel:#3d5a5c;--steel-dark:#2a4142;--muted:#7a7568}
  *{box-sizing:border-box}
  body{margin:0;font-family:Tahoma,'Segoe UI',sans-serif;background:var(--paper);color:var(--ink)}
  header{background:var(--steel-dark);color:#f0efe8;padding:24px 32px;border-bottom:4px solid #a85c32}
  header h1{margin:0;font-size:1.4rem}
  .filter-row{max-width:1100px;margin:20px auto 0;padding:0 24px}
  .filter-row input{width:100%;padding:10px 14px;border:1px solid var(--line);border-radius:6px}
  main{max-width:1100px;margin:20px auto 60px;padding:0 24px}
  .school-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:16px;overflow:hidden}
  .school-head{padding:14px 18px;background:#eef0e9;cursor:pointer;display:flex;justify-content:space-between}
  .school-body{padding:16px 18px;display:none}
  .school-body.open{display:block}
  .thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
  .thumb{width:80px;height:80px;border-radius:6px;overflow:hidden;border:1px solid var(--line);cursor:pointer}
  .thumb img{width:100%;height:100%;object-fit:cover}
  .area-name{font-size:.8rem;color:var(--muted);margin-bottom:4px}
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center}
  .lightbox.open{display:flex}
  .lightbox img{max-width:90vw;max-height:85vh}
</style>
</head>
<body>

<header><h1>سجل صور تفتيش المدارس</h1></header>
<div class="filter-row"><input id="search" placeholder="بحث باسم مدرسة..."></div>
<main id="main"></main>
<div class="lightbox" id="lightbox"><img id="lightboxImg" src=""></div>

<script>
let schools = {};
fetch('schools-data.json').then(r=>r.json()).then(data=>{ schools = data; render(''); });

function render(filter){
  const main = document.getElementById('main');
  main.innerHTML = '';
  Object.entries(schools).forEach(([code, school])=>{
    if(filter && !school.name.toLowerCase().includes(filter.toLowerCase())) return;
    const card = document.createElement('div');
    card.className = 'school-card';
    const head = document.createElement('div');
    head.className = 'school-head';
    head.innerHTML = '<strong>' + school.name + '</strong><span>' + Object.keys(school.workOrders).length + ' أمر شغل</span>';
    const body = document.createElement('div');
    body.className = 'school-body';
    Object.entries(school.workOrders).forEach(([wo, data])=>{
      Object.entries(data.photos_by_area || {}).forEach(([area, photos])=>{
        const g = document.createElement('div');
        const label = document.createElement('div');
        label.className = 'area-name';
        label.textContent = (data.findingsMap[area]?.en || area) + (data.findingsMap[area]?.finding ? ' — ' + data.findingsMap[area].finding : '');
        g.appendChild(label);
        const thumbs = document.createElement('div');
        thumbs.className = 'thumbs';
        photos.forEach(p=>{
          const t = document.createElement('div');
          t.className = 'thumb';
          t.innerHTML = '<img src="' + p.url + '">';
          t.onclick = ()=>{ document.getElementById('lightboxImg').src = p.url; document.getElementById('lightbox').classList.add('open'); };
          thumbs.appendChild(t);
        });
        g.appendChild(thumbs);
        body.appendChild(g);
      });
    });
    head.onclick = ()=> body.classList.toggle('open');
    card.appendChild(head);
    card.appendChild(body);
    main.appendChild(card);
  });
}
document.getElementById('search').addEventListener('input', e=> render(e.target.value));
document.getElementById('lightbox').addEventListener('click', e=> e.target.closest('.lightbox').classList.remove('open'));
</script>
</body>
</html>`;
}

function buildDocs() {
  fs.rmSync(DOCS_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  if (fs.existsSync(PHOTOS_DIR)) copyDir(PHOTOS_DIR, path.join(DOCS_DIR, 'photos'));
  fs.writeFileSync(path.join(DOCS_DIR, 'schools-data.json'), JSON.stringify(schools, null, 2));
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), buildStaticViewer());
  // GitHub Pages محتاج الملف ده عشان يعرف يعرض فولدر اسمه زي مجلد الصور من غير مشاكل
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
}

async function main() {
  if (!SESSION_COOKIE) {
    console.error('❌ لازم تحط TFMP_SESSION_COOKIE في GitHub Secrets');
    process.exit(1);
  }
  console.log('↻ بيسحب أي وورك أوردر جديد...');
  await runSync('current');
  console.log('↻ ببني الموقع...');
  buildDocs();
  console.log('✔ خلص. عدد المدارس:', Object.keys(schools).length);
}

main();
