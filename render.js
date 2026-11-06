// render.js — Render game offline theo từng frame (thời gian ảo) + bắt mốc caption.
//
// Ý tưởng: game chạy bằng requestAnimationFrame + THREE.Clock (dùng performance.now).
// Driver chặn 2 thứ đó ngay từ lúc trang chưa load xong:
//   - performance.now() luôn trả về thời gian ẢO do driver điều khiển.
//   - requestAnimationFrame() không tự chạy nữa mà xếp callback vào hàng đợi.
// Mỗi bước driver tăng thời gian ảo đúng 1/FPS giây, gọi 1 lượt callback, rồi chụp
// TOÀN TRANG bằng page.screenshot (không chụp riêng canvas nữa). Nhờ vậy video
// 2K vẫn mượt dù máy chủ không có GPU và không chạy kịp thời gian thực: khung
// hình nào cũng được vẽ đủ rồi mới chụp — và quan trọng hơn, các phần tử DOM
// của game cũng lọt vào video: khung chữ lời dẫn/thoại (#kbCaption) và cả
// popup báo giấy (#npOverlay) mà trước đây chụp canvas thì mất hẳn.
// Định dạng ảnh chụp theo IMG_FORMAT (png nét nhất, jpeg nhanh nhẹ hơn).
//
// Caption (lời dẫn + thoại) được bắt bằng cách bọc 2 hàm hiện chữ của game:
//   kbSay(text) và kbSayDialogue(name, text). Mỗi lần game hiện câu nào là driver
//   ghi lại đúng mốc thời gian ảo lúc đó, để bước ráp giọng đặt file tiếng vào
//   đúng chỗ, không lệch dù đoạn đánh nhau/bay có dài ngắn khác nhau.
// Ngoài ra driver còn trang trí khung chữ ngay trong trang trước khi chụp:
//   hiệu ứng mờ + trồi lên mỗi câu mới, và mỗi nhân vật một màu riêng
//   (lời dẫn giữ màu vàng, thoại tô màu theo tên người nói) để người xem
//   phân biệt được ai đang nói chỉ bằng màu sắc.
//
// Tiếng động (SFX, v1.1.4): game chỉ phát tiếng trong trình duyệt headless
//   lúc render nên tiếng mp3 bị mất hẳn nếu không thu lại. Driver bọc thêm
//   5 hàm âm thanh của game (playSound, startSfxLoop, stopSfxLoop,
//   startSfxAmbientLoop, stopSfxAmbientLoop), ghi mỗi lần phát thành 1 sự
//   kiện vào window.__sfxEvents kèm URL tuyệt đối của file mp3, rồi đóng
//   dấu thời gian ảo (emitted/FPS) lúc drain — sai số trong 1 frame.
//   Cuối render ghi ra sfx.json (cạnh captions.json) để voice.js tải các
//   file mp3 đó về và trộn lại vào video đúng mốc thời gian.
//
// Biến môi trường:
//   GAME_URL     (bắt buộc) URL tới play.php, vd https://lop2b.click/mine/play.php
//   SCRIPT_PATH  (mặc định ./binance_godzilla_v15_voice_pitch.json)
//   WIDTH        (mặc định 2560)
//   HEIGHT       (mặc định 1440)
//   FPS          (mặc định 30)
//   MAX_FRAMES   (mặc định 0 = chạy tới khi kịch bản kết thúc; đặt 300 để chạy thử ~10s)
//   OUT_VIDEO    (mặc định ./video_silent.mp4) — video CHƯA có tiếng
//   OUT_CAPTIONS (mặc định ./captions.json) — mốc thời gian từng câu thoại
//   OUT_SFX      (mặc định ./sfx.json) — mốc thời gian + URL từng tiếng động (SFX)
//   IMG_FORMAT   png | jpeg (mặc định png; jpeg nhẹ và nhanh hơn, chất lượng vẫn tốt)
//   JPEG_QUALITY (mặc định 0.92, chỉ dùng khi IMG_FORMAT=jpeg)
//   SHOT_TIMEOUT (mặc định 120000) thời gian chờ tối đa cho 1 lần chụp frame, ms
//   SHOT_RETRIES (mặc định 3) số lần thử chụp lại 1 frame khi bị timeout/rỗng
//   LOAD_WAIT_MS (mặc định 300000) chờ màn hình chờ/bắt đầu tối đa 5 phút ngoài đời thì báo lỗi
//   HEARTBEAT_MS (mặc định 30000) cứ bao lâu ghi 1 dòng nhịp tim khi đang chờ/chụp chậm
//   CINEMATIC (mặc định 0) 0 = tắt cinematic khi render (nhanh hơn ~13 lần đo được), 1 = giữ cinematic
//   SHOT_RETRIES (mặc định 3) số lần thử chụp lại 1 frame khi bị timeout/rỗng
//
// Chạy:  node render.js
// Yêu cầu: npm install playwright  +  npx playwright install chromium

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');

const GAME_URL = process.env.GAME_URL;
const CINEMATIC = (process.env.CINEMATIC || '0').trim(); // 0 = tắt cinematic khi render (đo được nhanh hơn ~13 lần), 1 = giữ cinematic
// Ghép ?cinematic= vào URL game (không đổi play.php trên host — trang live vẫn mở cinematic ON như cũ).
let GAME_URL_FULL = GAME_URL;
try { const u = new URL(GAME_URL); u.searchParams.set('cinematic', CINEMATIC); GAME_URL_FULL = u.toString(); } catch (e) { GAME_URL_FULL = GAME_URL + (GAME_URL.includes('?') ? '&' : '?') + 'cinematic=' + CINEMATIC; }
const SCRIPT_PATH = process.env.SCRIPT_PATH || './binance_godzilla_v15_voice_pitch.json';
const WIDTH = parseInt(process.env.WIDTH || '2560', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '1440', 10);
const FPS = parseInt(process.env.FPS || '30', 10);
const MAX_FRAMES = parseInt(process.env.MAX_FRAMES || '0', 10);
const OUT_VIDEO = process.env.OUT_VIDEO || './video_silent.mp4';
const OUT_CAPTIONS = process.env.OUT_CAPTIONS || './captions.json';
const OUT_SFX = process.env.OUT_SFX || './sfx.json';
const IMG_FORMAT = (process.env.IMG_FORMAT || 'png').toLowerCase();
const JPEG_QUALITY = parseFloat(process.env.JPEG_QUALITY || '0.92');
const SHOT_TIMEOUT = parseInt(process.env.SHOT_TIMEOUT || '120000', 10);
const SHOT_RETRIES = parseInt(process.env.SHOT_RETRIES || '3', 10);
const LOAD_WAIT_MS = parseInt(process.env.LOAD_WAIT_MS || '300000', 10); // chờ màn hình chờ/bắt đầu tối đa 5 phút ngoài đời thì báo lỗi (mỗi frame ảo có thể tốn vài giây ngoài đời trên máy không có GPU nên không thể chỉ đếm frame ảo)
const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10); // nhịp tim theo thời gian ngoài đời (đếm frame không đủ dày khi mỗi frame ảo tốn vài giây)
const MAX_SKIP_FRAMES = 1800; // quá 60s (ở 30fps) mà màn hình chờ vẫn chưa tắt thì báo lỗi

if (!GAME_URL) { console.error('Thiếu GAME_URL'); process.exit(2); }
if (!fs.existsSync(SCRIPT_PATH)) { console.error('Không thấy file kịch bản:', SCRIPT_PATH); process.exit(2); }

// Đoạn mã chèn vào trang TRƯỚC KHI game load: chặn đồng hồ + vòng lặp vẽ.
const INIT_SCRIPT = `
(() => {
  window.__FPS = ${FPS};
  window.__vt = 0;            // thời gian ảo, tính bằng mili giây
  window.__rafQueue = [];     // hàng đợi callback requestAnimationFrame
  window.__captions = [];     // caption ghi được trong bước hiện tại
  window.__sfxEvents = [];    // sự kiện SFX ghi được trong bước hiện tại (v1.1.4)
  window.__rafError = null;
  try {
    Object.defineProperty(window.Performance.prototype, 'now', {
      value: function () { return window.__vt; }, configurable: true
    });
  } catch (e) {}
  try { performance.now = function () { return window.__vt; }; } catch (e) {}
  window.requestAnimationFrame = function (cb) {
    window.__rafQueue.push(cb);
    return window.__rafQueue.length;
  };
  window.cancelAnimationFrame = function () {};
  // Một bước render: tăng thời gian ảo đúng 1 frame, chạy 1 lượt vòng lặp vẽ.
  // Ảnh KHÔNG chụp trong này nữa (toDataURL chỉ lấy được canvas, mất chữ
  // và báo giấy) — driver ở Node sẽ chụp toàn trang bằng page.screenshot
  // sau mỗi bước. Hàm này chỉ trả về trạng thái để driver quyết định tiếp.
  window.__step = function () {
    window.__vt += 1000 / window.__FPS;
    const q = window.__rafQueue;
    window.__rafQueue = [];
    for (const cb of q) {
      try { cb(window.__vt); } catch (e) { window.__rafError = String((e && e.stack) || e); }
    }
    const loadingEl = document.getElementById('kbLoading');
    const loading = !!loadingEl && getComputedStyle(loadingEl).display !== 'none';
    const caps = window.__captions;
    window.__captions = [];
    const sfx = window.__sfxEvents;
    window.__sfxEvents = [];
    return {
      running: document.body.classList.contains('kb-running'),
      loading,
      caps,
      sfx,
      rafError: window.__rafError
    };
  };
})();
`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const script = JSON.parse(fs.readFileSync(SCRIPT_PATH, 'utf-8'));
  console.log(`Kịch bản: ${script.name || SCRIPT_PATH} — ${script.steps.length} bước`);
  console.log(`Khung hình: ${WIDTH}x${HEIGHT} @ ${FPS}fps, định dạng ${IMG_FORMAT}`);
  console.log(`render.js v1.1.4 (shotfix+loadwatch+heartbeat+nocine+sfx) — SHOT_TIMEOUT=${SHOT_TIMEOUT}ms x${SHOT_RETRIES}, LOAD_WAIT=${LOAD_WAIT_MS}ms, HEARTBEAT=${HEARTBEAT_MS}ms, CINEMATIC=${CINEMATIC}, MAX_FRAMES=${MAX_FRAMES}`);

  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--mute-audio'
    ]
  });
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error' || t.includes('[KB]')) console.log('[trình duyệt]', msg.type(), t.slice(0, 300));
  });
  page.on('pageerror', (err) => console.log('[lỗi trang]', String(err).slice(0, 500)));
  await page.addInitScript(INIT_SCRIPT);

  console.log('Mở game:', GAME_URL_FULL);
  await page.goto(GAME_URL_FULL, { waitUntil: 'load', timeout: 180000 });
  await page.waitForSelector('#game canvas', { timeout: 180000 });
  // Ẩn nút 👁️ hiện/ẩn UI trong lúc chạy kịch bản để video sạch.
  await page.addStyleTag({ content: '#kbUiReveal{display:none !important}' });
  // Khung chữ hiện kiểu hoạt hình: mỗi câu mới mờ dần + trồi lên. Keyframes
  // giữ nguyên translateX(-50%) căn giữa để khung không nhảy ngang.
  await page.addStyleTag({ content: '#kbCaption{animation:kbCapIn .4s ease-out}@keyframes kbCapIn{from{opacity:0;transform:translateX(-50%) translateY(14px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}' });
  await sleep(1000);

  // Bắt đầu chơi (auto=true để bỏ qua xin khóa chuột + tiếng bíp).
  const started = await page.evaluate(() => {
    if (typeof window.startGame === 'function') { window.startGame(true); return 'startGame'; }
    return 'no-startGame';
  });
  if (started !== 'startGame') {
    console.log('Không gọi được startGame(), thử bấm nút #playBtn...');
    await page.click('#playBtn', { timeout: 30000 });
    await sleep(1000);
  }

  // Bọc 2 hàm hiện chữ để bắt mốc caption + trang trí khung chữ cho video.
  // (Nếu game đổi tên hàm thì báo rõ.)
  const wrapped = await page.evaluate(() => {
    window.__captions = [];
    // Mỗi nhân vật một màu riêng (cấp theo thứ tự xuất hiện, không băm tên
    // để khỏi trùng màu; 12 nhân vật đầu chắc chắn khác nhau). Lời dẫn
    // giữ màu vàng của game, không đổi.
    const SPEAKER_COLORS = ['#7dd3fc', '#f9a8d4', '#86efac', '#fdba74', '#c4b5fd', '#5eead4', '#fca5a5', '#fde047', '#e879f9', '#22d3ee', '#a3e635', '#fb7185'];
    const speakerColorMap = {};
    function speakerColor(name) {
      const k = String(name);
      if (!speakerColorMap[k]) speakerColorMap[k] = SPEAKER_COLORS[Object.keys(speakerColorMap).length % SPEAKER_COLORS.length];
      return speakerColorMap[k];
    }
    // Chạy lại hiệu ứng hiện khung chữ cho mỗi câu mới (game giữ display
    // block liên tục giữa các câu nên không ép thì hiệu ứng chỉ chạy 1 lần).
    function restartCapAnim() {
      const c = document.getElementById('kbCaption');
      if (!c) return;
      c.style.animation = 'none';
      void c.offsetWidth;
      c.style.animation = '';
    }
    let ok = 0;
    if (typeof window.kbSay === 'function') {
      const orig = window.kbSay;
      window.kbSay = function (text) {
        if (text) window.__captions.push({ t: window.__vt / 1000, text: String(text), head: 'narration' });
        const r = orig(text);
        if (text) {
          // Mặc định: lời dẫn hiển thị phía DƯỚI màn hình.
          const c = document.getElementById('kbCaption');
          if (c) { c.style.top = 'auto'; c.style.bottom = '60px'; }
          restartCapAnim();
        }
        return r;
      };
      ok++;
    }
    if (typeof window.kbSayDialogue === 'function') {
      const orig = window.kbSayDialogue;
      window.kbSayDialogue = function (name, text) {
        if (text) window.__captions.push({ t: window.__vt / 1000, text: String(text), head: String(name) });
        const r = orig(name, text);
        if (text) {
          const c = document.getElementById('kbCaption');
          if (c) {
            const col = speakerColor(name);
            c.style.borderColor = col;
            const lb = c.querySelector('span');
            if (lb) lb.style.color = col;
            // Mặc định: lời thoại hiển thị phía TRÊN màn hình.
            c.style.top = '150px';
            c.style.bottom = 'auto';
          }
          restartCapAnim();
        }
        return r;
      };
      ok++;
    }
    // --- SFX (v1.1.4): bọc 5 hàm âm thanh của game để bắt sự kiện tiếng động.
    // Mỗi wrapper gọi hàm gốc trước rồi mới ghi event — không đổi giá trị
    // trả về, không throw (try/catch quanh phần ghi), nên game chạy y như
    // cũ. Event ghi URL tuyệt đối của file mp3 (el.src đã resolve) để
    // voice.js tải trực tiếp; t=null, driver đóng dấu sau lúc drain.
    // Hàm nào game không có thì bỏ qua (không lỗi) — engine cũ vẫn render
    // bình thường, chỉ là sfx.json sẽ rỗng.
    window.__sfxEvents = window.__sfxEvents || [];
    let sfxOk = 0;
    const sfxPush = (ev) => { try { window.__sfxEvents.push(ev); } catch (e) {} };
    if (typeof window.playSound === 'function') {
      const origPS = window.playSound;
      window.playSound = function (cat, opts) {
        const el = origPS(cat, opts);
        try {
          // playSound trả null khi fallback beep (không có mp3) -> bỏ qua.
          if (el && el.src) sfxPush({ t: null, kind: 'sfx', cat: String(cat), file: String(el.src), rate: (typeof el.playbackRate === 'number' ? el.playbackRate : 1), vol: (typeof el.volume === 'number' ? el.volume : 1) });
        } catch (e) {}
        return el;
      };
      sfxOk++;
    }
    if (typeof window.startSfxLoop === 'function') {
      const origSL = window.startSfxLoop;
      window.startSfxLoop = function (cat, opts) {
        const el = origSL(cat, opts);
        try {
          const loop = window.SFX_LOOP;
          if (loop && loop.src) sfxPush({ t: null, kind: 'loop-start', cat: String(window.SFX_LOOP_CAT || cat), file: String(loop.src), vol: (typeof loop.volume === 'number' ? loop.volume : 0.4) });
        } catch (e) {}
        return el;
      };
      sfxOk++;
    }
    if (typeof window.stopSfxLoop === 'function') {
      const origStop = window.stopSfxLoop;
      window.stopSfxLoop = function () {
        const had = !!window.SFX_LOOP;
        const r = origStop();
        try { if (had) sfxPush({ t: null, kind: 'loop-stop' }); } catch (e) {}
        return r;
      };
      sfxOk++;
    }
    if (typeof window.startSfxAmbientLoop === 'function') {
      const origAL = window.startSfxAmbientLoop;
      window.startSfxAmbientLoop = function () {
        const r = origAL();
        try {
          const a = window.SFX_AMBIENT;
          if (a && a.src) sfxPush({ t: null, kind: 'ambient-start', cat: 'ambient', file: String(a.src), vol: (typeof a.volume === 'number' ? a.volume : 0.25) });
        } catch (e) {}
        return r;
      };
      sfxOk++;
    }
    if (typeof window.stopSfxAmbientLoop === 'function') {
      const origAStop = window.stopSfxAmbientLoop;
      window.stopSfxAmbientLoop = function () {
        const had = !!window.SFX_AMBIENT;
        const r = origAStop();
        try { if (had) sfxPush({ t: null, kind: 'ambient-stop' }); } catch (e) {}
        return r;
      };
      sfxOk++;
    }
    window.__sfxWrapped = sfxOk;
    return ok;
  });
  if (wrapped < 2) {
    throw new Error(`Không bọc được hàm hiện chữ của game (bọc được ${wrapped}/2). Game có thể đã đổi tên hàm kbSay/kbSayDialogue.`);
  }
  const sfxWrapped = await page.evaluate(() => window.__sfxWrapped || 0);
  if (sfxWrapped >= 3) console.log(`Đã bọc ${sfxWrapped}/5 hàm âm thanh (playSound/loop/ambient) — SFX sẽ ghi ra sfx.json.`);
  else console.log(`(cảnh báo) chỉ bọc được ${sfxWrapped}/5 hàm âm thanh — game có thể là engine cũ, sfx.json có thể rỗng.`);

  // Chạy kịch bản (không await: kịch bản chạy nền, driver điều khiển từng frame).
  await page.evaluate((sc) => { void window.kbRun(sc); }, script);

  // ffmpeg nhận ảnh theo luồng, không lưu 12 nghìn file PNG ra đĩa.
  const ff = spawn('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'image2pipe',
    '-framerate', String(FPS),
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '18',
    '-preset', 'medium',
    '-movflags', '+faststart',
    OUT_VIDEO
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg thoát với mã ' + code))));
  });
  async function writeFrame(buf) {
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }

  // Chụp màn hình có thử lại: máy chạy GitHub không có GPU nên việc đọc
  // WebGL (ReadPixels) thỉnh thoảng kẹt quá 30s mặc định của Playwright —
  // một lần kẹt không được phép giết cả lần render dài. Timeout 120s/lần,
  // thử lại tối đa 3 lần, mỗi lần cách nhau 2s.
  async function takeShot(opts) {
    let lastErr = null;
    for (let attempt = 1; attempt <= SHOT_RETRIES; attempt++) {
      try {
        const shot = await page.screenshot({ timeout: SHOT_TIMEOUT, ...opts });
        if (shot && shot.length) return shot;
        lastErr = new Error('Không chụp được màn hình (screenshot rỗng).');
      } catch (e) {
        lastErr = e;
        console.log(`Chụp frame thử lần ${attempt}/${SHOT_RETRIES} chưa được (${String((e && e.message) || e).slice(0, 160)}) — thử lại sau 2s...`);
      }
      await sleep(2000);
    }
    throw new Error(`Không chụp được màn hình sau ${SHOT_RETRIES} lần thử: ${String((lastErr && lastErr.message) || lastErr).slice(0, 300)}`);
  }

  // Chẩn đoán khi kẹt ở màn hình chờ / chưa bắt đầu: chụp ảnh + lấy thông báo game.
  async function loadDiag(tag) {
    let info = '';
    try {
      info = await page.evaluate(() => {
        const m = document.getElementById('kbMsg');
        const n = document.getElementById('kbStepN');
        const d = document.getElementById('kbStepDo');
        return JSON.stringify({ msg: m ? m.textContent.slice(0, 500) : '', step: n ? n.textContent : '', do: d ? d.textContent : '' });
      });
    } catch (e) { info = '(không đọc được trạng thái trang: ' + String((e && e.message) || e).slice(0, 120) + ')'; }
    try { await takeShot({ path: 'render-debug.png' }); } catch (e) { console.log('Không chụp được ảnh debug: ' + String((e && e.message) || e).slice(0, 120)); }
    console.log(`Chẩn đoán kẹt ${tag}: ${info} (ảnh render-debug.png)`);
    return info;
  }

  let emitted = 0;      // số frame đã đưa vào video (quyết định mốc thời gian)
  let skipped = 0;      // số frame bỏ qua vì màn hình chờ chưa tắt
  let waited = 0;       // số frame ảo đã chờ kịch bản bắt đầu (đếm riêng: emitted+skipped không tăng trong lúc chờ bắt đầu nên không dùng được làm điều kiện dừng)
  let startedRun = false;
  let loopErr = null;
  const captionsOut = [];
  const sfxOut = [];       // sự kiện SFX đã đóng dấu thời gian ảo (v1.1.4)
  const wallStart = Date.now();
  let lastBeat = wallStart; // mốc log nhịp tim (theo thời gian ngoài đời)
  let lastProg = wallStart; // mốc log tiến độ render

  try {
    for (;;) {
      const r = await page.evaluate(() => window.__step());
      if (r.rafError) throw new Error('Lỗi trong vòng lặp game: ' + r.rafError);

      if (r.running) startedRun = true;
      // Caption của bước này phải giữ lại kể cả khi frame đang ở màn hình chờ.
      for (const c of r.caps) captionsOut.push({ t: emitted / FPS, text: c.text, head: c.head });
      // SFX cũng vậy: đóng dấu thời gian ảo lúc drain (sai số trong 1 frame
      // — 33ms ở 30fps). Event từ setTimeout (vd playSoundSeq) rơi vào
      // giữa 2 bước __step cũng được gom ở lần drain kế tiếp.
      for (const ev of (r.sfx || [])) { ev.t = emitted / FPS; sfxOut.push(ev); }
      if (!startedRun) {
        // Chưa thấy class kb-running: kịch bản chưa bắt đầu thật (vd chưa qua
        // kiểm tra, hoặc isPlaying chưa bật). Đợi tối đa ~10s thời gian ảo,
        // và tối đa LOAD_WAIT_MS ngoài đời.
        waited++;
        if (Date.now() - lastBeat > HEARTBEAT_MS) { lastBeat = Date.now(); console.log(`Đang chờ kịch bản bắt đầu... ${waited} frame ảo, ${((Date.now() - wallStart) / 1000).toFixed(0)}s ngoài đời`); }
        if (waited > FPS * 10 || Date.now() - wallStart > LOAD_WAIT_MS) {
          const info = await loadDiag('chưa bắt đầu');
          throw new Error('Kịch bản không bắt đầu chạy sau ' + waited + ' frame ảo / ' + ((Date.now() - wallStart) / 1000).toFixed(0) + 's ngoài đời. ' + info);
        }
        continue;
      }
      if (r.loading) {
        skipped++;
        if (Date.now() - lastBeat > HEARTBEAT_MS) { lastBeat = Date.now(); console.log(`Đang chờ màn hình chờ (kbLoading) tắt... đã bỏ ${skipped} frame, ${((Date.now() - wallStart) / 1000).toFixed(0)}s ngoài đời`); }
        if (skipped > MAX_SKIP_FRAMES || Date.now() - wallStart > LOAD_WAIT_MS) {
          const info = await loadDiag('màn hình chờ');
          throw new Error('Màn hình chờ (kbLoading) không tắt sau ' + skipped + ' frame / ' + ((Date.now() - wallStart) / 1000).toFixed(0) + 's ngoài đời — kịch bản có thể kẹt ở bước wake/scene hoặc world chưa load xong. ' + info);
        }
        continue; // bỏ frame màn hình chờ, video bắt đầu từ lúc cảnh hiện ra
      }
      // Chụp TOÀN TRANG (game + khung chữ + popup báo giấy) thay vì chỉ canvas.
      const shotStart = Date.now();
      const shot = await takeShot(IMG_FORMAT === 'jpeg'
        ? { type: 'jpeg', quality: Math.round(JPEG_QUALITY * 100) }
        : { type: 'png' });
      await writeFrame(shot);
      const shotMs = Date.now() - shotStart;
      if (shotMs > 5000) console.log(`Chụp frame ${emitted + 1} mất ${(shotMs / 1000).toFixed(1)}s`);
      emitted++;
      if (emitted % 60 === 0 || Date.now() - lastProg > 60000) {
        lastProg = Date.now();
        const wall = (Date.now() - wallStart) / 1000;
        console.log(`Đã render ${emitted} frame (${(emitted / FPS).toFixed(1)}s video) — tốc độ ${(emitted / wall).toFixed(2)} frame/giây ngoài đời, caption bắt được: ${captionsOut.length}`);
      }
      if (MAX_FRAMES > 0 && emitted >= MAX_FRAMES) { console.log('Dừng ở MAX_FRAMES=' + MAX_FRAMES + ' (chế độ chạy thử)'); break; }
      if (!r.running && emitted > 0) { console.log('Kịch bản đã kết thúc (class kb-running đã tắt).'); break; }
    }
  } catch (e) {
    loopErr = e;
  } finally {
    ff.stdin.end();
  }
  try { await ffDone; } catch (e) { if (!loopErr) throw e; console.log('ffmpeg cũng lỗi sau khi render đã lỗi (có thể do chưa có frame nào): ' + e.message); }
  if (loopErr) throw loopErr;
  // Drain lần cuối: event SFX có thể rơi vào sau bước __step cuối cùng
  // (vd loop-stop ở kbEnd) — gom nốt trước khi ghi file.
  try {
    const tail = await page.evaluate(() => { const evs = window.__sfxEvents || []; window.__sfxEvents = []; return evs; });
    for (const ev of tail) { ev.t = emitted / FPS; sfxOut.push(ev); }
  } catch (e) { console.log('Không drain được SFX cuối: ' + String((e && e.message) || e).slice(0, 120)); }
  fs.writeFileSync(OUT_CAPTIONS, JSON.stringify({
    fps: FPS, width: WIDTH, height: HEIGHT,
    frames: emitted, skippedLoadingFrames: skipped,
    captions: captionsOut
  }, null, 2), 'utf-8');
  fs.writeFileSync(OUT_SFX, JSON.stringify({
    script: script.name || SCRIPT_PATH, fps: FPS,
    frames: emitted, events: sfxOut
  }, null, 2), 'utf-8');
  await browser.close();
  console.log(`XONG render: ${emitted} frame = ${(emitted / FPS).toFixed(1)}s video, bỏ ${skipped} frame màn hình chờ, bắt ${captionsOut.length} caption, ${sfxOut.length} sự kiện SFX.`);
  console.log('Video chưa tiếng:', OUT_VIDEO);
  console.log('Mốc caption:', OUT_CAPTIONS);
  console.log('Mốc SFX:', OUT_SFX);
}

main().catch((e) => { console.error('RENDER THẤT BẠI:', e && e.stack || e); process.exit(1); });
