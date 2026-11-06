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
// Biến môi trường:
//   GAME_URL     (bắt buộc) URL tới play.php, vd https://lop2b.click/mine/play.php
//   SCRIPT_PATH  (mặc định ./binance_godzilla_v15_voice_pitch.json)
//   WIDTH        (mặc định 2560)
//   HEIGHT       (mặc định 1440)
//   FPS          (mặc định 30)
//   MAX_FRAMES   (mặc định 0 = chạy tới khi kịch bản kết thúc; đặt 300 để chạy thử ~10s)
//   OUT_VIDEO    (mặc định ./video_silent.mp4) — video CHƯA có tiếng
//   OUT_CAPTIONS (mặc định ./captions.json) — mốc thời gian từng câu thoại
//   IMG_FORMAT   png | jpeg (mặc định png; jpeg nhẹ và nhanh hơn, chất lượng vẫn tốt)
//   JPEG_QUALITY (mặc định 0.92, chỉ dùng khi IMG_FORMAT=jpeg)
//   SHOT_TIMEOUT (mặc định 120000) thời gian chờ tối đa cho 1 lần chụp frame, ms
//   SHOT_RETRIES (mặc định 3) số lần thử chụp lại 1 frame khi bị timeout/rỗng
//
// Chạy:  node render.js
// Yêu cầu: npm install playwright  +  npx playwright install chromium

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');

const GAME_URL = process.env.GAME_URL;
const SCRIPT_PATH = process.env.SCRIPT_PATH || './binance_godzilla_v15_voice_pitch.json';
const WIDTH = parseInt(process.env.WIDTH || '2560', 10);
const HEIGHT = parseInt(process.env.HEIGHT || '1440', 10);
const FPS = parseInt(process.env.FPS || '30', 10);
const MAX_FRAMES = parseInt(process.env.MAX_FRAMES || '0', 10);
const OUT_VIDEO = process.env.OUT_VIDEO || './video_silent.mp4';
const OUT_CAPTIONS = process.env.OUT_CAPTIONS || './captions.json';
const IMG_FORMAT = (process.env.IMG_FORMAT || 'png').toLowerCase();
const JPEG_QUALITY = parseFloat(process.env.JPEG_QUALITY || '0.92');
const SHOT_TIMEOUT = parseInt(process.env.SHOT_TIMEOUT || '120000', 10);
const SHOT_RETRIES = parseInt(process.env.SHOT_RETRIES || '3', 10);
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
    return {
      running: document.body.classList.contains('kb-running'),
      loading,
      caps,
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

  console.log('Mở game:', GAME_URL);
  await page.goto(GAME_URL, { waitUntil: 'load', timeout: 180000 });
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
    return ok;
  });
  if (wrapped < 2) {
    throw new Error(`Không bọc được hàm hiện chữ của game (bọc được ${wrapped}/2). Game có thể đã đổi tên hàm kbSay/kbSayDialogue.`);
  }

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

  let emitted = 0;      // số frame đã đưa vào video (quyết định mốc thời gian)
  let skipped = 0;      // số frame bỏ qua vì màn hình chờ chưa tắt
  let startedRun = false;
  const captionsOut = [];
  const wallStart = Date.now();

  try {
    for (;;) {
      const r = await page.evaluate(() => window.__step());
      if (r.rafError) throw new Error('Lỗi trong vòng lặp game: ' + r.rafError);

      if (r.running) startedRun = true;
      if (!startedRun) {
        // Chưa thấy class kb-running: kịch bản chưa bắt đầu thật (vd chưa qua
        // kiểm tra, hoặc isPlaying chưa bật). Đợi tối đa ~10s thời gian ảo.
        if (emitted + skipped > FPS * 10) {
          const kbMsg = await page.evaluate(() => {
            const el = document.getElementById('kbMsg');
            return el ? el.textContent.slice(0, 1000) : '';
          });
          await takeShot({ path: 'render-debug.png' });
          throw new Error('Kịch bản không bắt đầu chạy. Thông báo của game: ' + (kbMsg || '(trống)') + '. Đã lưu ảnh render-debug.png');
        }
        continue;
      }
      if (r.loading) {
        skipped++;
        if (skipped > MAX_SKIP_FRAMES) throw new Error('Màn hình chờ (kbLoading) không tắt sau ' + MAX_SKIP_FRAMES + ' frame — kịch bản có thể kẹt ở bước wake/scene.');
        continue; // bỏ frame màn hình chờ, video bắt đầu từ lúc cảnh hiện ra
      }
      // Caption ghi trong bước này thuộc về frame sắp ghi (mốc = số frame đã có).
      for (const c of r.caps) captionsOut.push({ t: emitted / FPS, text: c.text, head: c.head });
      // Chụp TOÀN TRANG (game + khung chữ + popup báo giấy) thay vì chỉ canvas.
      const shot = await takeShot(IMG_FORMAT === 'jpeg'
        ? { type: 'jpeg', quality: Math.round(JPEG_QUALITY * 100) }
        : { type: 'png' });
      await writeFrame(shot);
      emitted++;
      if (emitted % 300 === 0) {
        const wall = (Date.now() - wallStart) / 1000;
        console.log(`Đã render ${emitted} frame (${(emitted / FPS).toFixed(1)}s video) — tốc độ ${(emitted / wall).toFixed(2)} frame/giây ngoài đời, caption bắt được: ${captionsOut.length}`);
      }
      if (MAX_FRAMES > 0 && emitted >= MAX_FRAMES) { console.log('Dừng ở MAX_FRAMES=' + MAX_FRAMES + ' (chế độ chạy thử)'); break; }
      if (!r.running && emitted > 0) { console.log('Kịch bản đã kết thúc (class kb-running đã tắt).'); break; }
    }
  } finally {
    ff.stdin.end();
  }
  await ffDone;
  fs.writeFileSync(OUT_CAPTIONS, JSON.stringify({
    fps: FPS, width: WIDTH, height: HEIGHT,
    frames: emitted, skippedLoadingFrames: skipped,
    captions: captionsOut
  }, null, 2), 'utf-8');
  await browser.close();
  console.log(`XONG render: ${emitted} frame = ${(emitted / FPS).toFixed(1)}s video, bỏ ${skipped} frame màn hình chờ, bắt ${captionsOut.length} caption.`);
  console.log('Video chưa tiếng:', OUT_VIDEO);
  console.log('Mốc caption:', OUT_CAPTIONS);
}

main().catch((e) => { console.error('RENDER THẤT BẠI:', e && e.stack || e); process.exit(1); });
