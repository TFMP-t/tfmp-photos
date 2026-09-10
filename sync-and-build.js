/**
 * سكريبت واحد بيعمل 3 حاجات ورا بعض:
 * 0) يسجل دخول لوحده على نظام TFMP بيوزر واسورد، ويجيب توكن جلسة جديد فريش
 *    (مبقاش محتاج حد يجيب كوكي يدوي ويحدثه كل شهر)
 * 1) يسحب أي وورك أوردر جديد (زي server.js بالظبط) — بكل الحقول المتاحة في التقرير
 * 2) يبني الموقع الثابت جوه فولدر docs/ عشان GitHub Pages يعرضه
 *
 * ده بيشتغل لوحده من غير أي تدخل، عن طريق GitHub Actions مرة كل يوم
 * مش محتاج أي سيرفر شغال، ومجاني 100%
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const LOGIN_URL = 'https://tfmp.meem-edgenta.tech/api/v1/auth/login';
const REAL_LIST_URL = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';
const REAL_REPORT_BASE = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';

// اليوزر والباسورد بييجوا من GitHub Secrets مش مكتوبين هنا، عشان الأمان.
// خليهم فاضيين هنا في الكود دايمًا، وحطهم في GitHub Secrets بس:
//   TFMP_USERNAME  → مثلا mh.othman
//   TFMP_PASSWORD  → الباسورد الجديد (بعد ما اتغيّر)
const TFMP_USERNAME = process.env.TFMP_USERNAME || '';
const TFMP_PASSWORD = process.env.TFMP_PASSWORD || '';

// هيتحط فيه توكن الجلسة بعد تسجيل الدخول التلقائي
let AUTH_HEADER = '';

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

// بينادي API تسجيل الدخول بنفسه، ويجيب توكن جلسة جديد كل مرة السكريبت يشتغل
async function loginAndGetToken() {
  if (!TFMP_USERNAME || !TFMP_PASSWORD) {
    throw new Error('لازم تحط TFMP_USERNAME و TFMP_PASSWORD في GitHub Secrets');
  }
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ user_name: TFMP_USERNAME, password: TFMP_PASSWORD })
  });
  if (!res.ok) throw new Error(`فشل تسجيل الدخول: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('تسجيل الدخول نجح لكن مفيش access_token في الرد');
  AUTH_HEADER = `Bearer ${data.access_token}`;
  console.log('✔ تسجيل دخول ناجح، توكن جديد جاهز');
}

async function apiGet(url) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Authorization': AUTH_HEADER,
      'Cookie': `tfmp_session=${AUTH_HEADER.replace('Bearer ', '')}`
    }
  });
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

  // بيانات المدرسة الأساسية — بتتحدث دايمًا لو الحقل فاضي في السجل القديم
  if (!schools[code]) {
    schools[code] = {
      name: wo.school_name || item.primary_school_name,
      site: wo.site || item.site || '',
      neighbourhood: wo.neighbourhood || '',
      ministry_id: item.primary_ministry_id || wo.primary_ministry_id || wo.ministry_id || '',
      geo: {
        latitude: wo.school_geo_latitude || null,
        longitude: wo.school_geo_longitude || null
      },
      workOrders: {}
    };
  } else {
    const s = schools[code];
    if (!s.ministry_id) s.ministry_id = item.primary_ministry_id || wo.primary_ministry_id || wo.ministry_id || '';
    if (!s.site) s.site = wo.site || item.site || '';
    if (!s.neighbourhood) s.neighbourhood = wo.neighbourhood || '';
    if (!s.geo || (!s.geo.latitude && wo.school_geo_latitude)) {
      s.geo = { latitude: wo.school_geo_latitude || null, longitude: wo.school_geo_longitude || null };
    }
  }

  // تفاصيل كل قسم/مجال بالكامل، مش بس الملاحظة النصية
  const sectionsMap = {};
  Object.values(report.sections || {}).flat().forEach(s => {
    sectionsMap[s.service_area_code] = {
      section: s.section,
      name_en: s.service_area_en,
      name_ar: (report.area_ar && report.area_ar[s.service_area_en]) || '',
      inspection_focus: s.inspection_focus || [],
      findings: s.findings || '',
      finding_ar: (report.option_ar && s.findings && report.option_ar[s.findings]) || '',
      root_cause: s.root_cause || '',
      root_cause_ar: (report.option_ar && s.root_cause && report.option_ar[s.root_cause]) || '',
      overall_remarks: s.overall_remarks || '',
      availability: s.availability || ''
    };
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
    inspection_cycle: wo.inspection_cycle || null,
    start_date: wo.start_date || null,
    completion_date: wo.completion_date,
    total_work_time_min: wo.total_work_time_min || null,
    inspector_username: wo.assigned_user_name || '',
    inspector_fullname: wo.assigned_fullname || '',
    risk_score: wo.risk_score || null,
    overall_rating: (report.overall_rating && report.overall_rating.overall_rating) || null,
    overall_rating_remarks: (report.overall_rating && report.overall_rating.remarks) || null,
    performance_ratings: (report.overall_rating && report.overall_rating.performance_ratings) || null,
    photos_by_area: localPhotosByArea,
    // sections بيحتوي كل التفاصيل؛ findingsMap اتسابت لتوافق النسخة القديمة من الموقع
    sections: sectionsMap,
    findingsMap: Object.fromEntries(
      Object.entries(sectionsMap).map(([k, v]) => [k, { en: v.name_en, finding: v.finding_ar || v.findings }])
    )
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
      // بس نوع "IN" (تفتيش دوري) — مش CA (إصلاح) ولا SA أو أي نوع تاني
      if (item.work_order_template !== 'IN') continue;
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
  :root{--ink:#1c2321;--paper:#f6f4ee;--panel:#fff;--line:#dcd7c9;--steel:#3d5a5c;--steel-dark:#2a4142;--muted:#7a7568;--accent:#a85c32}
  *{box-sizing:border-box}
  body{margin:0;font-family:Tahoma,'Segoe UI',sans-serif;background:var(--paper);color:var(--ink)}
  header{background:var(--steel-dark);color:#f0efe8;padding:24px 32px;border-bottom:4px solid var(--accent)}
  header h1{margin:0;font-size:1.4rem}
  .filter-row{max-width:1100px;margin:20px auto 0;padding:0 24px;display:flex;gap:10px;flex-wrap:wrap}
  .filter-row input{flex:1;min-width:220px;padding:10px 14px;border:1px solid var(--line);border-radius:6px;font-size:1rem}
  .result-count{max-width:1100px;margin:8px auto 0;padding:0 24px;font-size:.85rem;color:var(--muted)}
  main{max-width:1100px;margin:20px auto 60px;padding:0 24px}
  .school-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:16px;overflow:hidden}
  .school-head{padding:14px 18px;background:#eef0e9;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px}
  .school-head-left{display:flex;flex-direction:column;gap:2px}
  .school-code{font-size:.78rem;color:var(--muted)}
  .school-meta{font-size:.75rem;color:var(--muted)}
  .school-body{padding:16px 18px;display:none}
  .school-body.open{display:block}
  .wo-block{margin-bottom:18px;padding-bottom:14px;border-bottom:1px dashed var(--line)}
  .wo-block:last-child{border-bottom:none;margin-bottom:0}
  .wo-title{font-size:.8rem;color:var(--muted);margin-bottom:2px}
  .wo-meta{font-size:.75rem;color:var(--muted);margin-bottom:8px}
  .area-block{margin-bottom:14px}
  .area-name{font-size:.85rem;font-weight:bold;margin-bottom:2px}
  .area-finding{font-size:.8rem;color:var(--accent);margin-bottom:4px;background:#fbeee4;padding:4px 8px;border-radius:5px;display:inline-block}
  .area-remarks{font-size:.78rem;color:var(--ink);margin-bottom:6px;white-space:pre-line}
  .thumbs{display:flex;flex-wrap:wrap;gap:8px}
  .thumb{width:90px;height:90px;border-radius:6px;overflow:hidden;border:1px solid var(--line);cursor:pointer;position:relative}
  .thumb img{width:100%;height:100%;object-fit:cover}
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.9);display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:20px}
  .lightbox.open{display:flex}
  .lightbox img{max-width:90vw;max-height:75vh}
  .lightbox-caption{color:#f0efe8;text-align:center;max-width:600px;font-size:.95rem}
  .no-results{text-align:center;color:var(--muted);padding:40px 0}
</style>
</head>
<body>

<header><h1>سجل صور تفتيش المدارس</h1></header>
<div class="filter-row">
  <input id="search" placeholder="بحث باسم المدرسة أو الرقم الوزاري أو الموقع أو الحي...">
</div>
<div class="result-count" id="resultCount"></div>
<main id="main"></main>
<div class="lightbox" id="lightbox">
  <img id="lightboxImg" src="">
  <div class="lightbox-caption" id="lightboxCaption"></div>
</div>

<script>
let schools = {};
fetch('schools-data.json').then(r=>r.json()).then(data=>{ schools = data; render(''); });

function render(filter){
  const main = document.getElementById('main');
  const resultCount = document.getElementById('resultCount');
  main.innerHTML = '';
  const q = filter.trim().toLowerCase();
  const entries = Object.entries(schools).filter(([code, school])=>{
    if(!q) return true;
    return school.name.toLowerCase().includes(q)
      || String(code).toLowerCase().includes(q)
      || String(school.ministry_id || '').toLowerCase().includes(q)
      || String(school.site || '').toLowerCase().includes(q)
      || String(school.neighbourhood || '').toLowerCase().includes(q);
  });

  resultCount.textContent = q ? (entries.length + ' نتيجة') : '';

  if(entries.length === 0){
    main.innerHTML = '<div class="no-results">مفيش نتايج مطابقة</div>';
    return;
  }

  entries.forEach(([code, school])=>{
    const card = document.createElement('div');
    card.className = 'school-card';

    const head = document.createElement('div');
    head.className = 'school-head';
    head.innerHTML =
      '<div class="school-head-left">' +
        '<strong>' + school.name + '</strong>' +
        '<span class="school-code">الرقم الوزاري: ' + (school.ministry_id || '—') + ' — كود الموقع: ' + code + '</span>' +
        '<span class="school-meta">' + (school.site || '') + (school.neighbourhood ? ' — ' + school.neighbourhood : '') + '</span>' +
      '</div>' +
      '<span>' + Object.keys(school.workOrders).length + ' أمر شغل</span>';

    const body = document.createElement('div');
    body.className = 'school-body';

    Object.entries(school.workOrders).forEach(([wo, data])=>{
      const woBlock = document.createElement('div');
      woBlock.className = 'wo-block';

      const woTitle = document.createElement('div');
      woTitle.className = 'wo-title';
      woTitle.textContent = 'أمر شغل: ' + wo + (data.assignment_month ? ' — ' + data.assignment_month : '');
      woBlock.appendChild(woTitle);

      const woMeta = document.createElement('div');
      woMeta.className = 'wo-meta';
      const metaParts = [];
      if (data.inspector_fullname) metaParts.push('المفتش: ' + data.inspector_fullname);
      if (data.completion_date) metaParts.push('تاريخ الإنجاز: ' + data.completion_date.slice(0,10));
      if (data.overall_rating) metaParts.push('التقييم العام: ' + data.overall_rating);
      woMeta.textContent = metaParts.join(' — ');
      woBlock.appendChild(woMeta);

      Object.entries(data.photos_by_area || {}).forEach(([area, photos])=>{
        const areaBlock = document.createElement('div');
        areaBlock.className = 'area-block';

        const info = (data.sections && data.sections[area]) || data.findingsMap[area] || {};
        const label = document.createElement('div');
        label.className = 'area-name';
        label.textContent = info.name_ar || info.name_en || info.en || area;
        areaBlock.appendChild(label);

        const findingText = info.finding_ar || info.findings || info.finding;
        if(findingText){
          const finding = document.createElement('div');
          finding.className = 'area-finding';
          finding.textContent = '📝 ' + findingText;
          areaBlock.appendChild(finding);
        }
        if(info.overall_remarks){
          const remarks = document.createElement('div');
          remarks.className = 'area-remarks';
          remarks.textContent = info.overall_remarks;
          areaBlock.appendChild(remarks);
        }

        const thumbs = document.createElement('div');
        thumbs.className = 'thumbs';
        photos.forEach(p=>{
          const t = document.createElement('div');
          t.className = 'thumb';
          t.innerHTML = '<img src="' + p.url + '">';
          t.onclick = ()=>{
            document.getElementById('lightboxImg').src = p.url;
            document.getElementById('lightboxCaption').textContent = (info.name_ar || info.name_en || area) + (findingText ? ' — ' + findingText : '');
            document.getElementById('lightbox').classList.add('open');
          };
          thumbs.appendChild(t);
        });
        areaBlock.appendChild(thumbs);
        woBlock.appendChild(areaBlock);
      });

      body.appendChild(woBlock);
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
  console.log('↻ بيسجل دخول تلقائي...');
  await loginAndGetToken();
  console.log('↻ بيسحب أي وورك أوردر جديد...');
  await runSync('current');
  console.log('↻ ببني الموقع...');
  buildDocs();
  console.log('✔ خلص. عدد المدارس:', Object.keys(schools).length);
}

main();
