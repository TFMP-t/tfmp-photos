/**
 * نص برمجي واحد ينفّذ ثلاث مهام متتالية:
 * 0) يسجّل الدخول تلقائيًا إلى نظام TFMP باستخدام اسم مستخدم وكلمة مرور، ويحصل على
 *    رمز جلسة (token) جديد في كل تشغيل (لم يعد هناك حاجة لجلب ملف تعريف ارتباط يدويًا وتحديثه شهريًا)
 * 1) يسحب أي أمر شغل جديد (بنفس طريقة server.js تمامًا) — بجميع الحقول المتاحة في التقرير
 * 2) يبني الموقع الثابت داخل مجلد docs/ ليتمكن GitHub Pages من عرضه
 *
 * يعمل هذا النص البرمجي تلقائيًا دون أي تدخل بشري، عبر GitHub Actions مرة كل يوم،
 * ولا يحتاج إلى أي خادم يعمل باستمرار، وهو مجاني بنسبة 100%
 */
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const sharp = require('sharp');

// نتتبّع أسماء الصور الجديدة فقط (التي تم تنزيلها منذ آخر رفع تدريجي)، حتى يقوم
// أمر "git add" بإضافتها بالاسم بدلًا من فحص مجلد docs/photos بالكامل في كل مرة.
// هذا المجلد يكبر يومًا بعد يوم، فإذا استمررنا في إضافته بالكامل كل دقيقة، فإن
// زمن العملية سيتزايد تدريجيًا إلى أن يُبطئ التشغيل بأكمله (وهذا سبب شائع لمشكلات
// مثل "lost communication with the server" بعد ساعات من التشغيل الصامت).
let newPhotoRelPaths = [];

const LOGIN_URL = 'https://tfmp.meem-edgenta.tech/api/v1/auth/login';
const REAL_LIST_URL = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';
const REAL_REPORT_BASE = 'https://tfmp.meem-edgenta.tech/api/v1/admin/work-orders';

// اسم المستخدم وكلمة المرور يأتيان من GitHub Secrets ولا يُكتبان هنا حفاظًا على الأمان.
// اترك هذين المتغيّرين فارغَين دائمًا في الكود، وضع القيم في GitHub Secrets فقط:
//   TFMP_USERNAME  → على سبيل المثال mh.othman
//   TFMP_PASSWORD  → كلمة المرور الجديدة (بعد تغييرها)
const TFMP_USERNAME = process.env.TFMP_USERNAME || '';
const TFMP_PASSWORD = process.env.TFMP_PASSWORD || '';

// يُحفظ فيه رمز الجلسة بعد تسجيل الدخول التلقائي
let AUTH_HEADER = '';

const DELAY_MS = 250;
const CONCURRENCY = 3;
// إذا قلّت المساحة الفارغة على القرص في الـ runner عن هذا الحد، يتوقف النص البرمجي
// فورًا عن سحب أي بيانات جديدة، ويحفظ ويرفع كل ما تم سحبه حتى تلك اللحظة، بدلًا من
// الاستمرار حتى تتوقف بيئة التشغيل فجأة بسبب امتلاء القرص (وهذا سبب شائع لرسالة
// "lost communication with the server" عند ظهورها)
const MIN_FREE_DISK_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 جيجابايت هامش أمان

function hasEnoughDiskSpace() {
  try {
    const stats = fs.statfsSync(__dirname);
    const freeBytes = stats.bavail * stats.bsize;
    return freeBytes > MIN_FREE_DISK_BYTES;
  } catch (e) {
    // إذا تعذّر التحقق لأي سبب، لا نوقف السحب لمجرد الشك
    return true;
  }
}

const DATA_DIR = path.join(__dirname, 'data');
const DOCS_DIR = path.join(__dirname, 'docs');
// أصبحت الصور تُحفظ الآن مباشرة داخل docs/photos بدلًا من حفظها في مجلد منفصل
// ثم نسخها مرة أخرى داخل docs/ — بهذا نخزّن نسخة واحدة فقط بدلًا من نسختين،
// وهذا يقلّل تقريبًا مساحة القرص المستخدمة على الـ runner إلى النصف
const PHOTOS_DIR = path.join(DOCS_DIR, 'photos');
const PROCESSED_FILE = path.join(DATA_DIR, 'processed.json');
const SCHOOLS_FILE = path.join(DATA_DIR, 'schools.json');
const PROGRESS_FILE = path.join(DOCS_DIR, 'progress.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
fs.mkdirSync(DOCS_DIR, { recursive: true });
// يجب كتابة هذا الملف منذ اللحظة الأولى، حتى لا تحاول GitHub Pages معالجة الموقع
// بواسطة محرك Jekyll أثناء عملية السحب (قبل بناء ملف index.html الكامل في النهاية)
fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');

// قائمة "آخر المدارس التي تم سحبها"، تُحدَّث وتُرفع أولًا بأول أثناء السحب
let progressLog = loadJsonSafe(PROGRESS_FILE, []);

function loadJsonSafe(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return fallback;
}

function writeProgressPage() {
  fs.writeFileSync(path.join(DOCS_DIR, 'progress.html'), `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>متابعة السحب لحظة بلحظة</title>
<style>
  body{font-family:Tahoma,'Segoe UI',sans-serif;background:#f6f4ee;color:#1c2321;margin:0;padding:20px}
  h1{font-size:1.3rem}
  #count{color:#7a7568;margin-bottom:14px}
  .row{background:#fff;border:1px solid #dcd7c9;border-radius:6px;padding:10px 14px;margin-bottom:6px;display:flex;justify-content:space-between}
  .row .time{color:#7a7568;font-size:.8rem}
</style>
</head>
<body>
<h1>سجل السحب — آخر المدارس التي تم سحبها</h1>
<div id="count">يتحدَّث تلقائيًا كل 10 ثوانٍ...</div>
<div id="list"></div>
<script>
async function load(){
  try{
    const res = await fetch('progress.json?t=' + Date.now());
    const data = await res.json();
    document.getElementById('count').textContent = 'عدد أوامر الشغل التي تم سحبها حتى الآن: ' + data.length;
    const list = document.getElementById('list');
    list.innerHTML = '';
    data.slice().reverse().slice(0, 200).forEach(item=>{
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = '<span>' + item.name + ' — ' + item.wo + '</span><span class="time">' + item.time + '</span>';
      list.appendChild(row);
    });
  }catch(e){}
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`);
}

// يرفع أولًا بأول (كل دقيقة تقريبًا) أي صور جديدة تم تنزيلها بالإضافة إلى ملفات المتابعة والبيانات.
// وهذا هو أهم تعديل: فبدلًا من تجميع آلاف الصور ورفعها دفعة واحدة في نهاية التشغيل
// (وهو ما كان يتسبب في استغراق عملية الرفع نصف ساعة إلى ساعة، وقد يؤدي إلى توقف الـ runner
// بسبب نفاد الذاكرة أو المساحة)، يقوم النص البرمجي الآن كل دقيقة بعملية commit+push
// للصور الجديدة فقط التي تم تنزيلها منذ آخر مرة. وبذلك إذا حدث أي عطل في منتصف التشغيل،
// تبقى الصور التي تم سحبها فعليًا محفوظة على GitHub بالفعل.
function pushProgress() {
  try {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
    writeProgressPage();
    if (!fs.existsSync(path.join(DOCS_DIR, '.nojekyll'))) {
      fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
    }
    // نحفظ أيضًا نسخة محدَّثة من البيانات حتى لا تُفقد البيانات المسحوبة في حال حدوث عطل
    saveJson(PROCESSED_FILE, processed);
    saveJson(SCHOOLS_FILE, schools);

    // الملفات الصغيرة الثابتة (التي لا يكبر حجمها مع الوقت) تُضاف بالاسم كما هي
    const fixedFiles = [
      'docs/progress.json', 'docs/progress.html', 'docs/.nojekyll',
      'data/processed.json', 'data/schools.json'
    ];
    execFileSync('git', ['add', '--', ...fixedFiles], { cwd: __dirname });

    // الصور الجديدة فقط تُضاف بالاسم (وليس مجلد docs/photos بالكامل) —
    // وهذا ما يمنع تكرار فحص آلاف الصور القديمة كل دقيقة. تُقسَّم إلى
    // دفعات صغيرة احتياطًا في حال تراكم عدد كبير جدًا خلال الدقيقة نفسها.
    const photosToAdd = newPhotoRelPaths.map(p => path.join('docs', p));
    const CHUNK = 300;
    for (let i = 0; i < photosToAdd.length; i += CHUNK) {
      const chunk = photosToAdd.slice(i, i + CHUNK);
      execFileSync('git', ['add', '--', ...chunk], { cwd: __dirname });
    }

    // إذا لم يوجد أي تغيير فعلي (مثلًا لا صور جديدة بعد)، لا يُنشأ commit فارغ —
    // لكن يُحاول الرفع (push) دائمًا حتى لو لم يوجد شيء جديد الآن، لأنه قد يكون
    // هناك commit سابق تم إنشاؤه لكن فشل رفعه في المرة الماضية (مثلاً بسبب انقطاع
    // شبكة مؤقت)؛ فلو اكتفينا بالخروج هنا مباشرة، سيظل ذلك الـ commit عالقًا محليًا
    // بلا رفع إلى الأبد (لأن git diff --staged يكون فارغًا وهو بالفعل مُثبَّت في commit سابق)
    let hasChanges = true;
    try {
      execSync('git diff --staged --quiet', { cwd: __dirname });
      hasChanges = false;
    } catch (e) {
      hasChanges = true;
    }
    if (hasChanges) {
      execSync('git commit -m "تحديث تلقائي: صور وبيانات جديدة" -q', { cwd: __dirname, stdio: 'ignore' });
    }

    // محاولة الرفع حتى 3 مرات في حال حدوث عطل شبكة أو تعارض مؤقت. لا ضرر من
    // تنفيذ "git push" حتى لو لم يوجد شيء جديد فعلًا — فهو عندها لا يفعل شيئًا وينجح فورًا
    let pushed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        execSync('git push -q', { cwd: __dirname, stdio: 'ignore' });
        pushed = true;
        break;
      } catch (pushErr) {
        if (attempt === 3) {
          // لا نرمي الخطأ هنا؛ نكتفي بتسجيله، حتى لا تتوقف عملية السحب نفسها
          // بسبب فشل مؤقت في الرفع — ستُعاد المحاولة في الدفعة القادمة أو في نهاية التشغيل
          console.error('⚠ فشلت كل محاولات الرفع (ستُعاد المحاولة لاحقًا):', pushErr.message);
          break;
        }
        try {
          execSync('git pull --rebase -q', { cwd: __dirname, stdio: 'ignore' });
        } catch (pullErr) {
          // فشل الـ pull/rebase لا يجب أن يوقف عملية السحب أيضًا؛ يُعاد المحاولة في الدورة القادمة
          console.error('⚠ فشل git pull --rebase أثناء محاولة الرفع:', pullErr.message);
        }
      }
    }
    // تُفرَّغ القائمة فقط بعد التأكد من أن هذه الصور قد تم فعليًا عمل commit+push لها بنجاح،
    // حتى إذا فشل الرفع، تحاول الدفعة التالية إضافتها مجددًا بدلًا من أن تُفقد
    if (pushed) newPhotoRelPaths = [];
  } catch (e) {
    // لا يوقف هذا عملية السحب — إذا فشل الرفع التدريجي مرة، سيُعاد المحاولة في الدفعة التالية
    // أو في النهاية ضمن خطوة "حفظ ورفع النتيجة" في ملف الـ workflow
    console.error('⚠ فشل الرفع التدريجي (ستُعاد المحاولة في الدفعة التالية):', e.message);
  }
}

function loadJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { console.error('فشل في قراءة', file, e.message); }
  return fallback;
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let processed = loadJson(PROCESSED_FILE, {});
let schools = loadJson(SCHOOLS_FILE, {});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// يستدعي واجهة برمجة تسجيل الدخول بنفسه، ويحصل على رمز جلسة جديد في كل مرة يعمل فيها النص البرمجي
async function loginAndGetToken() {
  if (!TFMP_USERNAME || !TFMP_PASSWORD) {
    throw new Error('يجب ضبط TFMP_USERNAME و TFMP_PASSWORD في GitHub Secrets');
  }
  const res = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ user_name: TFMP_USERNAME, password: TFMP_PASSWORD })
  });
  if (!res.ok) throw new Error(`فشل تسجيل الدخول: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error('نجح تسجيل الدخول لكن لم يرد access_token في الاستجابة');
  AUTH_HEADER = `Bearer ${data.access_token}`;
  console.log('✔ تم تسجيل الدخول بنجاح، الرمز الجديد جاهز');
}

async function apiGet(url, attempt = 1, loginRetries = 0) {
  let res;
  try {
    res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'Authorization': AUTH_HEADER,
        'Cookie': `tfmp_session=${AUTH_HEADER.replace('Bearer ', '')}`
      }
    });
  } catch (networkErr) {
    // عطل شبكة مؤقت (لا توجد استجابة من الخادم إطلاقًا) — تُعاد المحاولة
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return apiGet(url, attempt + 1, loginRetries);
    }
    throw networkErr;
  }
  // إذا انتهت صلاحية التصريح أثناء السحب (عملية سحب طويلة)، يُسجَّل الدخول تلقائيًا من جديد ويُستكمل العمل.
  // يُحدَّد عدد محاولات إعادة تسجيل الدخول المتتالية حتى لا يدخل البرنامج في حلقة لا نهائية
  // إذا ظل الخادم يرفض الطلب لسبب آخر غير انتهاء صلاحية الرمز (مثل مشكلة صلاحيات دائمة)
  if (res.status === 401 || res.status === 403) {
    if (loginRetries >= 3) {
      throw new Error(`استمر الخادم في رفض التصريح (HTTP ${res.status}) حتى بعد إعادة تسجيل الدخول عدة مرات عند ${url}`);
    }
    console.log('↻ انتهت صلاحية التصريح، جارٍ تسجيل الدخول من جديد...');
    await loginAndGetToken();
    return apiGet(url, attempt, loginRetries + 1);
  }
  // أعطال مؤقتة من الخادم (ازدحام أو صيانة لحظية)
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) {
      await sleep(2000 * attempt);
      return apiGet(url, attempt + 1);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} عند الوصول إلى ${url}`);
  return res.json();
}

// الحد الأقصى لعرض الصورة بعد الضغط — كافٍ تمامًا للعرض في المتصفح
// (الصور الأصلية من الهاتف المحمول عادة ما تكون أكبر بكثير من اللازم للعرض على الشاشة)
const MAX_IMAGE_WIDTH = 1600;
const JPEG_QUALITY = 78;

async function downloadFile(url, savePath, attempt = 1) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`فشل تنزيل الصورة: ${res.status}`);
    const buffer = await res.buffer();
    // تُضغط الصورة وتُصغَّر أبعادها قبل الحفظ — وهذا يقلّل الحجم بنسبة كبيرة جدًا
    // (غالبًا 70-90%) دون أن تتأثر الجودة بشكل ملحوظ عند العرض في المتصفح، وهو ما
    // يجعل عملية git push بعد ذلك أسرع بكثير ويمنع تضخّم مساحة القرص والمستودع.
    // تُحفظ جميع الملفات بامتداد ‎.jpg‎ موحّد، فإذا فشل الضغط (أي تعذّر تحويل
    // الملف إلى JPEG فعلي) يُعتبر التنزيل فاشلًا بدلًا من حفظ ملف باسم ‎.jpg‎
    // بمحتوى ليس JPEG فعليًا (وهو ما قد يسبب مشكلات في العرض في بعض المتصفحات)
    const compressed = await sharp(buffer)
      .rotate() // يحافظ على الاتجاه الصحيح وفق بيانات EXIF قبل حذفها
      .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, compressed);
  } catch (err) {
    // إذا كانت المشكلة عطل شبكة مؤقتًا أو خللًا عابرًا في الضغط، تُعاد المحاولة حتى 3 مرات
    if (attempt < 3) {
      await sleep(1000 * attempt);
      return downloadFile(url, savePath, attempt + 1);
    }
    throw err;
  }
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

  // البيانات الأساسية للمدرسة — تُحدَّث دائمًا إذا كان الحقل فارغًا في السجل القديم
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

  // تفاصيل كل قسم/مجال بالكامل، وليست الملاحظة النصية فقط
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
      // أصبحت جميع الصور تُحفظ بصيغة JPEG بعد الضغط، لذا يوحَّد الامتداد إلى ‎.jpg‎
      // بغض النظر عن امتداد الملف الأصلي (png/jpeg/webp/إلخ)
      const baseName = p.filename.replace(/\.[a-zA-Z0-9]+$/, '');
      const localRelPath = `${code}/${woNumber}_${baseName}.jpg`;
      const localFullPath = path.join(PHOTOS_DIR, localRelPath);
      if (!fs.existsSync(localFullPath)) {
        await downloadFile(p.signed_url, localFullPath);
        // يُسجَّل المسار النسبي للصورة (من داخل docs/) لإضافتها بالاسم فقط
        // في الرفع التدريجي التالي، بدلًا من فحص مجلد الصور بالكامل
        newPhotoRelPaths.push(path.join('photos', localRelPath));
        await sleep(DELAY_MS);
      }
      localPhotosByArea[areaCode].push({
        filename: p.filename,
        // مسار نسبي (بدون شرطة مائلة في البداية) حتى يعمل الموقع بشكل صحيح
        // سواء استُضيف على جذر النطاق أو داخل مسار فرعي لصفحات GitHub Pages
        url: `photos/${localRelPath}`,
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
  let lastPushTime = 0;

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
      // النوع "IN" (تفتيش دوري) فقط — وليس CA (إصلاح) ولا SA ولا أي نوع آخر
      if (item.work_order_template !== 'IN') continue;
      if (processed[item.work_order_number]) continue;
      toProcess.push(item);
    }

    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      // نتأكد من وجود مساحة كافية على القرص قبل كل دفعة صور جديدة
      if (!hasEnoughDiskSpace()) {
        console.error('⚠ مساحة القرص أوشكت على النفاد - يتوقف السحب عن أي بيانات جديدة، ويُحفظ ويُرفع ما تم سحبه حتى الآن');
        stop = true;
        break;
      }
      const batch = toProcess.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (item) => {
        try {
          await processWorkOrder(item);
          console.log(`✔ ${item.work_order_number}`);
          progressLog.push({
            name: item.primary_school_name || item.location_name || item.work_order_number,
            wo: item.work_order_number,
            time: new Date().toLocaleString('ar-EG')
          });
        } catch (err) {
          console.error(`❌ فشل ${item.work_order_number}:`, err.message);
        }
      }));
      saveJson(PROCESSED_FILE, processed);
      saveJson(SCHOOLS_FILE, schools);
      // تُرفع صفحة المتابعة على GitHub ليس بعد كل دفعة، بل كل 60 ثانية فقط —
      // لأنه إذا حدثت آلاف العمليات من هذا النوع متتاليةً بسرعة، فقد تعتبرها
      // GitHub نشاطًا غير طبيعي وتوقف الرفع مؤقتًا (حماية من تجاوز حدّ الطلبات)
      const now = Date.now();
      if (now - lastPushTime > 60000) {
        pushProgress();
        lastPushTime = now;
      }
      await sleep(DELAY_MS);
    }

    if (stop) break;
    if (items.length < limit) break;
    page++;
    await sleep(DELAY_MS);
  }
  // رفعة أخيرة تضمن رفع آخر دفعة (التي قد تكون مرّ عليها أقل من 60 ثانية منذ سابقتها)
  pushProgress();
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Fira+Code:wght@500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#f7f7f5; --surface:#ffffff; --surface-2:#f0f0ec; --line:#e2e1da; --line-soft:#ebeae3;
  --fg:#1c1d1f; --muted:#5b5c63; --faint:#84858c; --accent:#2f6fed; --good:#1f9d63; --bad:#d3413a;
  --shadow:0 1px 2px rgba(20,20,30,.05), 0 8px 24px rgba(20,20,30,.06); --radius:14px; --ease:cubic-bezier(.4,0,.2,1);
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--fg);font-family:"IBM Plex Sans Arabic","Segoe UI",system-ui,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.mono{font-family:"Fira Code",ui-monospace,monospace;font-feature-settings:"tnum"}
header{position:sticky;top:0;z-index:30;background:rgba(247,247,245,.86);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid var(--line)}
.head-inner{max-width:1400px;margin:0 auto;padding:16px 22px}
.title-row{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
h1{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}
.subtitle{color:var(--faint);font-size:13px}
.kpis{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.kpi{background:var(--surface);border:1px solid var(--line-soft);border-radius:10px;padding:10px 14px;min-width:110px}
.kpi .val{font-size:20px;font-weight:600;line-height:1.1}
.kpi .lbl{color:var(--muted);font-size:11px;margin-top:3px;text-transform:uppercase;letter-spacing:.04em}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.field{position:relative;display:flex;align-items:center}
.field svg{position:absolute;right:10px;width:15px;height:15px;color:var(--faint);pointer-events:none}
select,.search input{background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:9px;
  padding:9px 32px 9px 12px;font-size:13px;font-family:inherit;appearance:none;cursor:pointer;transition:border-color .15s var(--ease)}
select:hover,.search input:hover{border-color:var(--faint)}
select:focus,.search input:focus{outline:none;border-color:var(--accent)}
.search{flex:1;min-width:240px}
.search input{width:100%;cursor:text}
main{max-width:1400px;margin:20px auto 60px;padding:0 24px}
.result-count{color:var(--muted);font-size:12.5px;margin-bottom:14px}
.school-card{background:var(--surface);border:1px solid var(--line-soft);border-radius:var(--radius);margin-bottom:14px;overflow:hidden;box-shadow:var(--shadow)}
.school-head{padding:14px 18px;background:var(--surface-2);cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:10px;transition:background .15s var(--ease)}
.school-head:hover{background:#e6e5de}
.school-head-left{display:flex;flex-direction:column;gap:3px;min-width:0}
.school-name{font-weight:600;font-size:15px}
.school-code{font-size:.76rem;color:var(--faint)}
.school-code .mono{color:var(--accent)}
.school-meta{font-size:.75rem;color:var(--muted)}
.school-head-right{display:flex;align-items:center;gap:10px;flex-shrink:0}
.pill{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:4px 11px;font-size:.72rem;color:var(--muted);white-space:nowrap}
.chev{transition:transform .2s var(--ease);color:var(--faint)}
.school-card.open .chev{transform:rotate(180deg)}
.school-body{padding:0 18px;max-height:0;overflow:hidden;transition:max-height .25s var(--ease)}
.school-card.open .school-body{max-height:none;padding:4px 18px 18px}
.wo-block{margin-bottom:18px;padding-bottom:16px;border-bottom:1px dashed var(--line)}
.wo-block:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0}
.wo-title{font-size:.78rem;color:var(--muted);margin-bottom:2px}
.wo-title .mono{color:var(--fg)}
.wo-meta{font-size:.73rem;color:var(--faint);margin-bottom:10px}
.area-block{margin-bottom:14px;padding:12px;background:var(--bg);border:1px solid var(--line-soft);border-radius:10px}
.area-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.area-name{font-size:.85rem;font-weight:600}
.area-tag{font-size:.68rem;padding:2px 8px;border-radius:20px;border:1px solid currentColor;opacity:.9}
.area-finding{font-size:.8rem;color:var(--fg);margin-bottom:6px;background:#fdf3e3;border:1px solid #f0dcb4;padding:6px 10px;border-radius:6px}
.area-remarks{font-size:.78rem;color:var(--muted);margin-bottom:8px;white-space:pre-line}
.thumbs{display:flex;flex-wrap:wrap;gap:8px}
.thumb{width:88px;height:88px;border-radius:8px;overflow:hidden;border:1px solid var(--line);cursor:pointer;position:relative;background:var(--surface-2)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .2s var(--ease)}
.thumb:hover img{transform:scale(1.06)}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:20px;z-index:50}
.lightbox.open{display:flex}
.lightbox img{max-width:92vw;max-height:78vh;border-radius:6px}
.lightbox-caption{color:#f0efe8;text-align:center;max-width:640px;font-size:.9rem;line-height:1.5}
.lightbox-close{position:absolute;top:18px;left:18px;color:#fff;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);border-radius:8px;width:36px;height:36px;cursor:pointer;font-size:18px}
.no-results{text-align:center;color:var(--muted);padding:60px 0;font-size:14px}
.updated-note{color:var(--faint);font-size:11.5px;margin-top:10px}
@media (max-width:640px){ .head-inner,main{padding-left:14px;padding-right:14px} .kpi{min-width:88px;padding:8px 10px} .kpi .val{font-size:16px} }
</style>
</head>
<body>

<header>
  <div class="head-inner">
    <div class="title-row">
      <h1>سجل صور تفتيش المدارس</h1>
      <span class="subtitle">Inspection Photo Log</span>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="filters">
      <div class="field search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="search" placeholder="ابحث باسم المدرسة، أو الرقم الوزاري، أو الموقع، أو الحي...">
      </div>
      <div class="field"><select id="areaFilter"><option value="">كل التصنيفات</option></select></div>
      <div class="field"><select id="regionFilter"><option value="">كل المناطق</option></select></div>
    </div>
    <div class="updated-note" id="updatedNote"></div>
  </div>
</header>

<main>
  <div class="result-count" id="resultCount"></div>
  <div id="listRoot"></div>
</main>

<div class="lightbox" id="lightbox">
  <button class="lightbox-close" id="lightboxClose">✕</button>
  <img id="lightboxImg" src="">
  <div class="lightbox-caption" id="lightboxCaption"></div>
</div>

<script>
let schools = {};
const AREA_COLORS = ['#2f6fed','#8b4fe0','#c9761a','#0d9488','#c23670','#3f9d33','#b7900a'];
const areaColorMap = {};
function colorFor(areaKey){
  if(!areaColorMap[areaKey]) areaColorMap[areaKey] = AREA_COLORS[Object.keys(areaColorMap).length % AREA_COLORS.length];
  return areaColorMap[areaKey];
}

function fmtDate(iso){
  if(!iso) return '';
  try{ return new Date(iso).toLocaleDateString('ar-SA',{year:'numeric',month:'short',day:'numeric'}); }catch(e){ return String(iso).slice(0,10); }
}

Promise.all([
  fetch('schools-data.json').then(r=>r.json()),
  fetch('progress.json?t=' + Date.now()).then(r=>r.ok?r.json():[]).catch(()=>[])
]).then(([data, progress])=>{
  schools = data;
  buildFilters();
  renderKpis();
  const last = progress && progress.length ? progress[progress.length-1] : null;
  document.getElementById('updatedNote').textContent = last ? ('آخر تحديث: ' + last.time) : '';
  render();
});

function buildFilters(){
  const areas = new Set(), regions = new Set();
  Object.values(schools).forEach(s=>{
    Object.values(s.workOrders||{}).forEach(wo=>{
      Object.entries(wo.sections||{}).forEach(([code, info])=>{
        areas.add((info.name_ar || info.name_en || code));
      });
    });
    if(s.site) regions.add(s.site);
  });
  const areaSel = document.getElementById('areaFilter');
  [...areas].sort().forEach(a=>{
    const o = document.createElement('option'); o.value = a; o.textContent = a; areaSel.appendChild(o);
  });
  const regionSel = document.getElementById('regionFilter');
  [...regions].sort().forEach(r=>{
    const o = document.createElement('option'); o.value = r; o.textContent = r; regionSel.appendChild(o);
  });
  areaSel.addEventListener('change', render);
  regionSel.addEventListener('change', render);
}

function renderKpis(){
  let woCount=0, photoCount=0, areaSet=new Set();
  Object.values(schools).forEach(s=>{
    Object.values(s.workOrders||{}).forEach(wo=>{
      woCount++;
      Object.values(wo.photos_by_area||{}).forEach(list=>{ photoCount += list.length; });
      Object.keys(wo.sections||{}).forEach(k=>areaSet.add(k));
    });
  });
  const kpis = [
    ['مدرسة', Object.keys(schools).length],
    ['أمر شغل', woCount],
    ['صورة', photoCount],
    ['تصنيف ملاحظة', areaSet.size]
  ];
  document.getElementById('kpis').innerHTML = kpis.map(([lbl,val])=>
    '<div class="kpi"><div class="val mono">' + val.toLocaleString('ar-EG') + '</div><div class="lbl">' + lbl + '</div></div>'
  ).join('');
}

function render(){
  const root = document.getElementById('listRoot');
  const resultCount = document.getElementById('resultCount');
  const q = document.getElementById('search').value.trim().toLowerCase();
  const areaFilter = document.getElementById('areaFilter').value;
  const regionFilter = document.getElementById('regionFilter').value;
  root.innerHTML = '';

  const entries = Object.entries(schools).filter(([code, school])=>{
    if(regionFilter && school.site !== regionFilter) return false;
    if(q){
      const hit = school.name.toLowerCase().includes(q)
        || String(code).toLowerCase().includes(q)
        || String(school.ministry_id||'').toLowerCase().includes(q)
        || String(school.site||'').toLowerCase().includes(q)
        || String(school.neighbourhood||'').toLowerCase().includes(q);
      if(!hit) return false;
    }
    if(areaFilter){
      const hasArea = Object.values(school.workOrders||{}).some(wo =>
        Object.values(wo.sections||{}).some(info => (info.name_ar||info.name_en) === areaFilter)
      );
      if(!hasArea) return false;
    }
    return true;
  });

  resultCount.textContent = (q||areaFilter||regionFilter) ? (entries.length.toLocaleString('ar-EG') + ' نتيجة من ' + Object.keys(schools).length.toLocaleString('ar-EG')) : (Object.keys(schools).length.toLocaleString('ar-EG') + ' مدرسة');

  if(entries.length === 0){
    root.innerHTML = '<div class="no-results">لا توجد نتائج مطابقة لبحثك</div>';
    return;
  }

  entries.forEach(([code, school])=>{
    const card = document.createElement('div');
    card.className = 'school-card';

    let woCount = Object.keys(school.workOrders||{}).length;
    let photoCount = 0;
    Object.values(school.workOrders||{}).forEach(wo=>Object.values(wo.photos_by_area||{}).forEach(l=>photoCount+=l.length));

    const head = document.createElement('div');
    head.className = 'school-head';
    head.innerHTML =
      '<div class="school-head-left">' +
        '<div class="school-name">' + school.name + '</div>' +
        '<div class="school-code">الرقم الوزاري: <span class="mono">' + (school.ministry_id || '—') + '</span> · كود الموقع: <span class="mono">' + code + '</span></div>' +
        '<div class="school-meta">' + [school.site, school.neighbourhood].filter(Boolean).join(' — ') + '</div>' +
      '</div>' +
      '<div class="school-head-right">' +
        '<span class="pill">' + woCount + ' أمر شغل</span>' +
        '<span class="pill">' + photoCount + ' صورة</span>' +
        '<svg class="chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>' +
      '</div>';
    head.addEventListener('click', ()=> card.classList.toggle('open'));

    const body = document.createElement('div');
    body.className = 'school-body';

    Object.entries(school.workOrders||{}).forEach(([wo, data])=>{
      const woBlock = document.createElement('div');
      woBlock.className = 'wo-block';

      const woTitle = document.createElement('div');
      woTitle.className = 'wo-title';
      woTitle.innerHTML = 'أمر شغل: <span class="mono">' + wo + '</span>' + (data.assignment_month ? ' — ' + data.assignment_month : '');
      woBlock.appendChild(woTitle);

      const woMeta = document.createElement('div');
      woMeta.className = 'wo-meta';
      const metaParts = [];
      if (data.inspector_fullname) metaParts.push('المفتش: ' + data.inspector_fullname);
      if (data.completion_date) metaParts.push('تاريخ الإنجاز: ' + fmtDate(data.completion_date));
      if (data.overall_rating) metaParts.push('التقييم العام: ' + data.overall_rating);
      woMeta.textContent = metaParts.join(' — ');
      woBlock.appendChild(woMeta);

      Object.entries(data.photos_by_area || {}).forEach(([area, photos])=>{
        const info = (data.sections && data.sections[area]) || (data.findingsMap && data.findingsMap[area]) || {};
        const areaLabel = info.name_ar || info.name_en || info.en || area;
        if(areaFilter && areaLabel !== areaFilter) return;

        const areaBlock = document.createElement('div');
        areaBlock.className = 'area-block';
        const color = colorFor(area);

        const headRow = document.createElement('div');
        headRow.className = 'area-head';
        headRow.innerHTML =
          '<span class="area-name">' + areaLabel + '</span>' +
          '<span class="area-tag" style="color:' + color + '">' + photos.length + ' صورة</span>';
        areaBlock.appendChild(headRow);

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
          const img = document.createElement('img');
          img.loading = 'lazy';
          img.src = p.url;
          t.appendChild(img);
          t.addEventListener('click', ()=>{
            document.getElementById('lightboxImg').src = p.url;
            document.getElementById('lightboxCaption').textContent = (areaLabel) + (findingText ? ' — ' + findingText : '') + (p.captured_at ? ' — ' + fmtDate(p.captured_at) : '');
            document.getElementById('lightbox').classList.add('open');
          });
          thumbs.appendChild(t);
        });
        areaBlock.appendChild(thumbs);
        woBlock.appendChild(areaBlock);
      });

      body.appendChild(woBlock);
    });

    card.appendChild(head);
    card.appendChild(body);
    root.appendChild(card);
  });
}

document.getElementById('search').addEventListener('input', render);
document.getElementById('lightbox').addEventListener('click', e=>{
  if(e.target.id === 'lightbox' || e.target.id === 'lightboxClose') document.getElementById('lightbox').classList.remove('open');
});
document.addEventListener('keydown', e=>{
  if(e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
});
</script>
</body>
</html>`;
}

function buildDocs() {
  // ⚠️ مهم جدًا: لا يُحذف مجلد docs بالكامل هنا — يجب أن تبقى فيه صور المدارس
  // التي تم رفعها في التشغيلات السابقة.
  // ملحوظة: أصبحت الصور تُحفظ مباشرة داخل docs/photos منذ لحظة التنزيل (في downloadFile)
  // لذا لم نعد بحاجة لنسخها مرة أخرى هنا كما كان سابقًا — وهو ما كان يضاعف مساحة القرص المستخدمة دون داعٍ
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(path.join(DOCS_DIR, 'schools-data.json'), JSON.stringify(schools, null, 2));
  fs.writeFileSync(path.join(DOCS_DIR, 'index.html'), buildStaticViewer());
  // تحتاج GitHub Pages إلى هذا الملف حتى تعرض المجلد الذي يحمل اسمًا مثل مجلد الصور دون مشكلات
  fs.writeFileSync(path.join(DOCS_DIR, '.nojekyll'), '');
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progressLog, null, 2));
  writeProgressPage();
}

async function main() {
  try {
    execSync('git config user.name "tfmp-bot"', { cwd: __dirname });
    execSync('git config user.email "actions@github.com"', { cwd: __dirname });
  } catch (e) {}

  try {
    console.log('↻ جارٍ تسجيل الدخول تلقائيًا...');
    await loginAndGetToken();
    console.log('↻ جارٍ سحب أي أمر شغل جديد...');
    await runSync('current');
  } catch (err) {
    // إذا حدثت مشكلة كبيرة أوقفت السحب بالكامل، لا يتوقف البرنامج بشكل مفاجئ —
    // بل يُبنى الموقع بأي بيانات تم سحبها حتى الآن، حتى لا يضيع العمل المُنجز
    console.error('⚠ توقف السحب بسبب مشكلة:', err.message);
    console.error('↻ سيُبنى الموقع بأي بيانات تم سحبها حتى الآن');
  }

  console.log('↻ جارٍ بناء الموقع...');
  buildDocs();
  console.log('✔ اكتمل العمل. عدد المدارس:', Object.keys(schools).length);
}

main();
