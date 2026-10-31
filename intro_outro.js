// intro_outro.js — Tạo intro (5s) + outro (8s) + thumbnail tùy chỉnh
// (1280x720 JPG) phong cách game xếp khối cho pipeline game-video-render.
// Vẽ bằng canvas 2D trong Chromium (Playwright), chụp từng frame theo
// thời gian ảo rồi ghép bằng ffmpeg — cùng kỹ thuật như render.js, không
// cần quay realtime, không cần file ảnh/font ngoài: chữ pixel và mọi hình
// khối đều vẽ bằng code.
//
// 4 kiểu intro/outro (style), mỗi lần chạy bốc ngẫu nhiên 1 kiểu (hoặc
// chỉ định tay bằng --style) để các video không giống nhau:
//   castle  - ban ngày, khối rơi xếp thành tháp, chữ rơi nảy xuống
//   village - làng quê, nhà mọc lên, nhân vật đi bộ vào, chữ trượt ngang
//   battle  - hoàng hôn rực, khối bay vào dựng tường, chữ đập mạnh xuống
//   night   - ban đêm, sao nhấp nháy, khối bay lên nhẹ, chữ hiện dần
// Outro nào cũng có đủ 3 nút kêu gọi: LIKE, SHARE, SUBSCRIBE (+ chuông).
//
// Thumbnail cũng có 4 kiểu (castle/face/battle/night), dùng cùng kiểu với
// intro/outro của video đó (village dùng chung kiểu castle) để video đồng
// bộ; chữ trên thumbnail lấy từ video_thumbnail_text của kịch bản (câu
// hook ngắn, chữ to mới thu hút), không có thì dùng tên tập. Chế độ chỉ
// làm thumbnail: node intro_outro.js --script ... --thumbnail thumb.jpg
// --thumbnail-only (không cần chạy intro/outro trước, nhưng nếu bước
// intro đã lưu style vào upload_meta.json thì thumbnail dùng cùng kiểu).
//
// Cách dùng:
//   node intro_outro.js --script picked_script.json --music picked_music.mp3
//     --width 2560 --height 1440 --fps 30 --meta-out upload_meta.json
//     --intro intro.mp4 --outro outro.mp4 [--style castle]
// Đầu ra: intro.mp4, outro.mp4 (video + nhạc nền ở mức 50%, fade in/out).
// Nếu tạo đủ cả 2 clip thì tự cộng thêm 5s (độ dài intro) vào chapters
// trong upload_meta.json, vì video chính sẽ bị đẩy lùi sau intro. Nếu
// bước này lỗi giữa chừng thì không đụng vào meta, để bước ghép giữ
// nguyên video chính (workflow có continue-on-error + fallback).
//
// Lưu ý giữ: mọi intro đều dài 5s, mọi outro đều dài 8s — đổi 2 hằng số
// dưới đây thì chapters tự cộng theo đúng số đó, nhưng đừng đổi lẻ từng
// kiểu (ghép và chapters đều giả định intro dài bằng nhau mọi kiểu).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
// Playwright chỉ require trong main() (khi chạy thật trên GitHub Actions,
// nơi đã cài npm): để phần vẽ trang (buildPage) test được bằng mock mà
// không cần cài playwright trên máy dev.

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const SCRIPT_PATH = arg('script', './picked_script.json');
const MUSIC_PATH = arg('music', './picked_music.mp3');
const WIDTH = parseInt(arg('width', '2560'), 10);
const HEIGHT = parseInt(arg('height', '1440'), 10);
const FPS = parseInt(arg('fps', '30'), 10);
const META_OUT = arg('meta-out', './upload_meta.json');
const INTRO_OUT = arg('intro', './intro.mp4');
const OUTRO_OUT = arg('outro', './outro.mp4');
const STYLE_ARG = arg('style', '');
const THUMBNAIL_OUT = arg('thumbnail', '');
const THUMBNAIL_ONLY = process.argv.includes('--thumbnail-only');
const BG_PATH = arg('bg', '');
const TITLE_POS_ARG = arg('title-pos', 'top');

const INTRO_SECS = 5;
const OUTRO_SECS = 8;
const CHANNEL = 'BLOCKY TALES';
const TAGLINE = 'Big adventures in a tiny blocky world';
const MUSIC_VOL = 0.5;
const FADE = 0.5;
const STYLES = ['castle', 'village', 'battle', 'night'];
const THUMB_STYLES = ['castle', 'face', 'battle', 'night'];

// Trang canvas: toàn bộ hình vẽ nằm trong chuỗi này. Trang KHÔNG dùng
// backtick hay ${} trong code của nó, để chuỗi template của Node không
// bị phá. W/H/tiêu đề tập/kiểu chèn bằng @@W@@, @@H@@, @@EPISODE@@,
// @@STYLE@@ (thay bằng replace, tiêu đề chèn dạng JSON để khỏi vỡ chuỗi).
const PAGE_TEMPLATE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#000;overflow:hidden}
canvas{display:block}
</style></head><body><canvas id="c" width="@@W@@" height="@@H@@"></canvas>
<script>
var W = @@W@@, H = @@H@@;
var EPISODE = @@EPISODE@@;
var THUMB_TEXT = @@THUMB@@;
var STYLE = '@@STYLE@@';
var BG_SRC = @@BG@@;
var TITLE_POS = '@@TITLE_POS@@';
var BG_IMG = null;
window.__bgReady = false;
if (BG_SRC) {
  try {
    var _bg = new Image();
    _bg.onload = function () { BG_IMG = _bg; window.__bgReady = true; };
    _bg.onerror = function () { window.__bgReady = true; };
    _bg.src = BG_SRC;
  } catch (e) { window.__bgReady = true; }
} else { window.__bgReady = true; }
var SC = W / 2560;

// Font pixel 5x7 (chi co chu hoa + so + dau cau thuong gap; chu thuong se
// doi thanh chu hoa, ky tu la thi ve thanh khoang trang).
var FONT = {
'A':['01110','10001','10001','11111','10001','10001','10001'],
'B':['11110','10001','10001','11110','10001','10001','11110'],
'C':['01110','10001','10000','10000','10000','10001','01110'],
'D':['11110','10001','10001','10001','10001','10001','11110'],
'E':['11111','10000','10000','11110','10000','10000','11111'],
'F':['11111','10000','10000','11110','10000','10000','10000'],
'G':['01110','10001','10000','10111','10001','10001','01111'],
'H':['10001','10001','10001','11111','10001','10001','10001'],
'I':['01110','00100','00100','00100','00100','00100','01110'],
'J':['00111','00010','00010','00010','00010','10010','01100'],
'K':['10001','10010','10100','11000','10100','10010','10001'],
'L':['10000','10000','10000','10000','10000','10000','11111'],
'M':['10001','11011','10101','10101','10001','10001','10001'],
'N':['10001','10001','11001','10101','10011','10001','10001'],
'O':['01110','10001','10001','10001','10001','10001','01110'],
'P':['11110','10001','10001','11110','10000','10000','10000'],
'Q':['01110','10001','10001','10001','10101','10010','01101'],
'R':['11110','10001','10001','11110','10100','10010','10001'],
'S':['01111','10000','10000','01110','00001','00001','11110'],
'T':['11111','00100','00100','00100','00100','00100','00100'],
'U':['10001','10001','10001','10001','10001','10001','01110'],
'V':['10001','10001','10001','10001','10001','01010','00100'],
'W':['10001','10001','10001','10101','10101','10101','01010'],
'X':['10001','10001','01010','00100','01010','10001','10001'],
'Y':['10001','10001','01010','00100','00100','00100','00100'],
'Z':['11111','00001','00010','00100','01000','10000','11111'],
'0':['01110','10001','10011','10101','11001','10001','01110'],
'1':['00100','01100','00100','00100','00100','00100','01110'],
'2':['01110','10001','00001','00110','01000','10000','11111'],
'3':['11111','00010','00100','00010','00001','10001','01110'],
'4':['00010','00110','01010','10010','11111','00010','00010'],
'5':['11111','10000','11110','00001','00001','10001','01110'],
'6':['00110','01000','10000','11110','10001','10001','01110'],
'7':['11111','00001','00010','00100','01000','01000','01000'],
'8':['01110','10001','10001','01110','10001','10001','01110'],
'9':['01110','10001','10001','01111','00001','00010','01100'],
' ':['00000','00000','00000','00000','00000','00000','00000'],
'!':['00100','00100','00100','00100','00100','00000','00100'],
'?':['01110','10001','00001','00110','00100','00000','00100'],
'.':['00000','00000','00000','00000','00000','01100','01100'],
',':['00000','00000','00000','00000','01100','00100','01000'],
"'":['00100','00100','01000','00000','00000','00000','00000'],
'-':['00000','00000','00000','01110','00000','00000','00000'],
':':['00000','01100','01100','00000','01100','01100','00000'],
'&':['01100','10010','10100','01000','10101','10010','01101'],
'(' :['00010','00100','01000','01000','01000','00100','00010'],
')':['01000','00100','00010','00010','00010','00100','01000'],
'/':['00001','00001','00010','00100','01000','10000','10000'],
'+':['00000','00100','00100','11111','00100','00100','00000'],
'%':['11001','11010','00010','00100','01000','01011','10011'],
'"':['01010','01010','01010','00000','00000','00000','00000']
};
var ICONS = {
like:['X.....','XX....','XX.XXX','XXXXXX','XXXXXX','.XXXX.'],
share:['X...X.','.X.X..','..X...','.X.X..','X...X.'],
bell:['.XXX..','XXXXX.','XXXXX.','XXXXX.','.XXX..','..X...']
};

function seededRand(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function easeOutCubic(x) { x = clamp01(x); return 1 - Math.pow(1 - x, 3); }
function easeInQuad(x) { x = clamp01(x); return x * x; }
function easeOutBounce(x) {
  x = clamp01(x);
  if (x < 1 / 2.75) return 7.5625 * x * x;
  if (x < 2 / 2.75) { x -= 1.5 / 2.75; return 7.5625 * x * x + 0.75; }
  if (x < 2.5 / 2.75) { x -= 2.25 / 2.75; return 7.5625 * x * x + 0.9375; }
  x -= 2.625 / 2.75; return 7.5625 * x * x + 0.984375;
}
function easeOutBack(x) { x = clamp01(x); var c = 1.70158; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }

function cv() { return document.getElementById('c').getContext('2d'); }
function R(ctx, x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
function glyph(ch) { return FONT[ch] || FONT[' ']; }
function textWidth(text, px) { return text.length ? text.length * 6 * px - px : 0; }
function drawGlyph(ctx, ch, x, y, px, color) {
  var g = glyph(ch);
  for (var r = 0; r < 7; r++) for (var c = 0; c < 5; c++)
    if (g[r][c] === '1') R(ctx, x + c * px, y + r * px, px, px, color);
}
function drawText(ctx, text, cx, y, px, color, outline) {
  text = String(text || '').toUpperCase();
  var w = textWidth(text, px);
  var x = cx - w / 2;
  if (outline) {
    var o = Math.max(1, Math.floor(px / 6));
    var offs = [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]];
    for (var k = 0; k < offs.length; k++)
      for (var i = 0; i < text.length; i++)
        drawGlyph(ctx, text[i], x + i * 6 * px + offs[k][0], y + offs[k][1], px, outline);
  }
  for (var i = 0; i < text.length; i++) drawGlyph(ctx, text[i], x + i * 6 * px, y, px, color);
  return w;
}
function wrapText(text, maxW, px, maxLines) {
  text = String(text || '').toUpperCase();
  var words = text.split(/\\s+/).filter(function(s) { return !!s; });
  var lines = [];
  var cur = '';
  function wOf(s) { return textWidth(s, px); }
  for (var i = 0; i < words.length; i++) {
    var word = words[i];
    while (wOf(word) > maxW) {
      var fit = Math.max(1, Math.floor(maxW / (6 * px)));
      lines.push(word.slice(0, fit));
      word = word.slice(fit);
    }
    var trial = cur ? cur + ' ' + word : word;
    if (wOf(trial) <= maxW) cur = trial;
    else { if (cur) lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    var last = lines[lines.length - 1];
    while (lines.length && wOf(last + '...') > maxW) last = last.slice(0, -1);
    lines[lines.length - 1] = last + '...';
  }
  return lines;
}
function drawIcon(ctx, name, x, y, px, color) {
  var g = ICONS[name];
  for (var r = 0; r < g.length; r++) for (var c = 0; c < g[r].length; c++)
    if (g[r][c] === 'X') R(ctx, x + c * px, y + r * px, px, px, color);
}

// ---- The gioi chung: bau troi, may, mat dat, cay, hoa, nhan vat ----
function drawSky(ctx, top, bot) {
  var g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top); g.addColorStop(1, bot);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
var CLOUDS = (function() {
  var r = seededRand(777); var arr = [];
  for (var i = 0; i < 6; i++) arr.push({ x: r(), y: 0.05 + r() * 0.22, s: 0.6 + r() * 0.9, v: 8 + r() * 14 });
  return arr;
})();
function drawClouds(ctx, t, color) {
  for (var i = 0; i < CLOUDS.length; i++) {
    var c = CLOUDS[i];
    var span = W + 600 * SC;
    var x = ((c.x * span + t * c.v * SC) % span) - 300 * SC;
    var y = c.y * H;
    var u = 22 * c.s * SC;
    R(ctx, x, y + u, 6 * u, 2 * u, color);
    R(ctx, x + u, y, 2 * u, u, color);
    R(ctx, x + 3 * u, y - u * 0.5, 2 * u, u * 1.5, color);
  }
}
function groundY() { return H - H * 0.16; }
function drawGround(ctx, grass, dirt) {
  var gy = groundY();
  var gh = H - gy;
  R(ctx, 0, gy, W, gh * 0.22, grass);
  R(ctx, 0, gy + gh * 0.22, W, gh * 0.78, dirt);
  var r = seededRand(99);
  for (var i = 0; i < 60; i++) {
    var sx = r() * W;
    var sy = gy + gh * 0.22 + r() * gh * 0.7;
    R(ctx, sx, sy, 10 * SC, 10 * SC, 'rgba(0,0,0,0.12)');
  }
}
function drawTree(ctx, x, s) {
  var gy = groundY();
  var u = 26 * s * SC;
  var th = 3 * u;
  R(ctx, x, gy - th, u, th, '#7A4A21');
  var ly = gy - th - 3 * u;
  var cols = ['#3E8E2F', '#5FAE3F'];
  for (var r = 0; r < 3; r++) for (var c = 0; c < 3; c++) {
    if ((r === 0 || r === 2) && (c === 0 || c === 2)) continue;
    R(ctx, x + (c - 1) * u, ly + r * u, u, u, cols[(r + c) % 2]);
  }
}
function drawFlowers(ctx) {
  var gy = groundY();
  var r = seededRand(7);
  var colors = ['#FF5A5A', '#FFD54A', '#FFFFFF', '#FF8AC2'];
  for (var i = 0; i < 24; i++) {
    var fx = r() * W;
    var fy = gy + r() * H * 0.05;
    R(ctx, fx, fy, 8 * SC, 8 * SC, colors[i % 4]);
  }
}
function drawSun(ctx, x, y, s, color) {
  var u = 30 * s * SC;
  R(ctx, x - u * 0.5, y - u * 0.5, 3 * u, 3 * u, 'rgba(255,220,100,0.18)');
  R(ctx, x, y, 2 * u, 2 * u, color);
}
var STARS = (function() {
  var r = seededRand(42); var arr = [];
  for (var i = 0; i < 70; i++) arr.push({ x: r(), y: r() * 0.55, s: 0.5 + r() });
  return arr;
})();
function drawStars(ctx, t) {
  for (var i = 0; i < STARS.length; i++) {
    var s = STARS[i];
    var a = 0.5 + 0.5 * Math.sin(t * 2 + i);
    if (a < 0.25) continue;
    R(ctx, s.x * W, s.y * H, 6 * SC * s.s, 6 * SC * s.s, 'rgba(255,255,255,' + a.toFixed(2) + ')');
  }
}
function drawChar(ctx, cx, t, mode, uOverride) {
  var u = uOverride || 26 * SC;
  var gy = groundY();
  var bob = mode === 'walk' ? Math.abs(Math.sin(t * 6)) * u * 0.25 : Math.sin(t * 3) * u * 0.08;
  var y = gy - 6 * u + bob;
  R(ctx, cx - u, y + 4 * u, u, 2 * u, '#2B3A67');
  R(ctx, cx, y + 4 * u, u, 2 * u, '#2B3A67');
  R(ctx, cx - u, y + 2 * u, 2 * u, 2 * u, '#2F7DE1');
  if (mode === 'wave') {
    ctx.save();
    ctx.translate(cx + u, y + 2 * u);
    ctx.rotate(-0.6 + Math.sin(t * 7) * 0.35);
    R(ctx, 0, -2 * u, u, 2 * u, '#F2C79B');
    ctx.restore();
    R(ctx, cx - 2 * u, y + 2 * u, u, 2 * u, '#F2C79B');
  } else {
    R(ctx, cx - 2 * u, y + 2 * u, u, 2 * u, '#F2C79B');
    R(ctx, cx + u, y + 2 * u, u, 2 * u, '#F2C79B');
  }
  R(ctx, cx - u, y, 2 * u, 2 * u, '#F2C79B');
  R(ctx, cx - u, y, 2 * u, u * 0.6, '#6B4A2F');
  R(ctx, cx - u * 0.6, y + u * 0.9, u * 0.3, u * 0.3, '#1F2937');
  R(ctx, cx + u * 0.3, y + u * 0.9, u * 0.3, u * 0.3, '#1F2937');
}

// ---- Chu tieu de co hieu ung (drop/slide/slam/fade) ----
function drawTitleLetters(ctx, text, cx, y, px, color, outline, t, start, stagger, mode) {
  text = String(text || '').toUpperCase();
  var w = textWidth(text, px);
  var x0 = cx - w / 2;
  var shake = 0;
  if (mode === 'slam' && t >= start + 0.2 && t < start + 0.5) shake = Math.sin(t * 80) * 5 * SC;
  for (var i = 0; i < text.length; i++) {
    var lt = t - start - i * stagger;
    var x = x0 + i * 6 * px + shake;
    var yy = y;
    var alpha = 1;
    var sc = 1;
    if (lt < 0) {
      if (mode === 'drop') yy = y - H * 0.45;
      else if (mode === 'slide') x = x - W * 0.5;
      else if (mode === 'slam') sc = 0;
      else if (mode === 'fade') alpha = 0;
    } else if (mode === 'drop') {
      var p = easeOutBounce(lt / 0.6);
      yy = y - (1 - p) * H * 0.45;
    } else if (mode === 'slide') {
      var p2 = easeOutCubic(lt / 0.6);
      x = x - (1 - p2) * W * 0.5;
    } else if (mode === 'slam') {
      if (lt < 0.2) sc = 0.4 + (lt / 0.2) * 0.9;
      else sc = 1 + 0.3 * Math.exp(-(lt - 0.2) * 6);
    } else if (mode === 'fade') {
      alpha = clamp01(lt / 0.8);
    }
    if (alpha <= 0 || sc <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (sc !== 1) {
      var gx = x + 2.5 * px;
      var gy = y + 3.5 * px;
      ctx.translate(gx, gy); ctx.scale(sc, sc); ctx.translate(-gx, -gy);
    }
    if (outline) {
      var o = Math.max(1, Math.floor(px / 6));
      var offs = [[-o, 0], [o, 0], [0, -o], [0, o], [-o, -o], [o, -o], [-o, o], [o, o]];
      for (var k = 0; k < offs.length; k++) drawGlyph(ctx, text[i], x + offs[k][0], yy + offs[k][1], px, outline);
    }
    drawGlyph(ctx, text[i], x, yy, px, color);
    ctx.restore();
  }
}
function titlePx() { return Math.max(10, Math.floor(W * 0.78 / (12 * 6))); }
function drawEpisode(ctx, t, start) {
  if (!EPISODE) return;
  var f = fitTitle(EPISODE, W * 0.8, 3, H * 0.35, Math.max(6, Math.floor(W * 0.005)));
  var px = f.px, lines = f.lines;
  var alpha = clamp01((t - start) / 0.8);
  if (alpha <= 0) return;
  var rise = (1 - alpha) * 20 * SC;
  ctx.save();
  ctx.globalAlpha = alpha;
  var lineH = 8 * px + 6 * SC;
  var y0 = H * 0.52 + rise;
  for (var i = 0; i < lines.length; i++) drawText(ctx, lines[i], W / 2, y0 + i * lineH, px, '#FFFFFF', '#1F2937');
  ctx.restore();
}
function fadeFromBlack(ctx, t, dur) {
  if (t < dur) {
    ctx.save();
    ctx.globalAlpha = 1 - t / dur;
    R(ctx, 0, 0, W, H, '#000000');
    ctx.restore();
  }
}

// ---- Khoi roi / bay / noi (diem nhan "xep khoi") ----
function castleSlots() {
  var B = 0.05 * W;
  var base = groundY();
  var slots = [];
  var xs0 = [0.62, 0.67, 0.72, 0.77];
  for (var i = 0; i < 4; i++) slots.push({ x: xs0[i] * W, y: base - B, c: ['#5FAE3F', '#8B5A2B', '#9AA3AD', '#FFD54A'][i % 4] });
  var xs1 = [0.645, 0.695, 0.745];
  for (var j = 0; j < 3; j++) slots.push({ x: xs1[j] * W, y: base - 2 * B, c: ['#B4532A', '#5FAE3F', '#9AA3AD'][j % 3] });
  slots.push({ x: 0.695 * W, y: base - 3 * B, c: '#FFD54A' });
  return { slots: slots, B: B };
}
function drawFallingBlocks(ctx, t) {
  var info = castleSlots();
  var slots = info.slots;
  var B = info.B;
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    var lt = t - i * 0.22;
    var y;
    if (lt < 0) y = -B;
    else if (lt < 0.7) y = -B + (s.y + B) * easeInQuad(lt / 0.7);
    else { var rt = lt - 0.7; y = s.y - Math.abs(Math.sin(rt * 9)) * B * 0.18 * Math.exp(-rt * 4); }
    R(ctx, s.x, y, B, B, s.c);
    R(ctx, s.x, y, B, B * 0.18, 'rgba(255,255,255,0.25)');
  }
}
function drawWallBlocks(ctx, t) {
  var B = 0.05 * W;
  var base = groundY();
  var slots = [
    { x: 0.70 * W, y: base - B, from: -1 }, { x: 0.75 * W, y: base - B, from: 1 }, { x: 0.80 * W, y: base - B, from: -1 },
    { x: 0.725 * W, y: base - 2 * B, from: 1 }, { x: 0.775 * W, y: base - 2 * B, from: -1 },
    { x: 0.75 * W, y: base - 3 * B, from: 1 }
  ];
  var cols = ['#9AA3AD', '#7A828C', '#B4532A', '#9AA3AD', '#7A828C', '#FFD54A'];
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    var lt = t - i * 0.12;
    var x;
    if (lt < 0) x = s.from < 0 ? -B : W + B;
    else if (lt < 0.5) {
      var p = easeOutCubic(lt / 0.5);
      var x0 = s.from < 0 ? -B : W + B;
      x = x0 + (s.x - x0) * p;
    } else x = s.x;
    R(ctx, x, s.y, B, B, cols[i]);
    R(ctx, x, s.y, B, B * 0.18, 'rgba(255,255,255,0.2)');
  }
}
function drawHouse(ctx, x, w, h, baseY, wall, roof) {
  R(ctx, x, baseY - h, w, h, wall);
  R(ctx, x - w * 0.08, baseY - h - h * 0.18, w * 1.16, h * 0.18, roof);
  R(ctx, x + w * 0.4, baseY - h * 0.45, w * 0.2, h * 0.45, '#5A3A20');
  R(ctx, x + w * 0.12, baseY - h * 0.75, w * 0.18, w * 0.18, '#BFE3FF');
}

// ---- 4 kieu intro ----
function introCastle(ctx, t) {
  drawSky(ctx, '#6FB7E8', '#CDEBFF');
  drawSun(ctx, W * 0.82, H * 0.12, 1, '#FFD54A');
  drawClouds(ctx, t, 'rgba(255,255,255,0.95)');
  drawGround(ctx, '#5FAE3F', '#8B5A2B');
  drawTree(ctx, W * 0.05, 1);
  drawTree(ctx, W * 0.90, 0.8);
  drawFlowers(ctx);
  drawChar(ctx, W * 0.18, t, 'idle');
  drawFallingBlocks(ctx, t);
  drawTitleLetters(ctx, 'BLOCKY TALES', W / 2, H * 0.24, titlePx(), '#FFD54A', '#1F2937', t, 1.6, 0.09, 'drop');
  drawEpisode(ctx, t, 3.0);
  fadeFromBlack(ctx, t, 0.4);
}
function introVillage(ctx, t) {
  drawSky(ctx, '#7EC8F0', '#E8F7FF');
  drawSun(ctx, W * 0.15, H * 0.12, 1, '#FFD54A');
  drawClouds(ctx, t, 'rgba(255,255,255,0.95)');
  drawGround(ctx, '#66BB44', '#8B5A2B');
  var houses = [
    { x: W * 0.62, w: W * 0.10, h: H * 0.16, at: 0.3 },
    { x: W * 0.78, w: W * 0.08, h: H * 0.12, at: 0.7 }
  ];
  for (var i = 0; i < houses.length; i++) {
    var hs = houses[i];
    var lt = t - hs.at;
    if (lt < 0) continue;
    var s = easeOutBack(lt / 0.5);
    var by = groundY();
    ctx.save();
    ctx.translate(hs.x + hs.w / 2, by); ctx.scale(s, s); ctx.translate(-(hs.x + hs.w / 2), -by);
    drawHouse(ctx, hs.x, hs.w, hs.h, by, '#D9A066', '#A85B2A');
    ctx.restore();
  }
  drawTree(ctx, W * 0.06, 1);
  drawFlowers(ctx);
  var wx = -0.1 * W + 0.4 * W * easeOutCubic(t / 2.5);
  drawChar(ctx, wx, t, t < 2.5 ? 'walk' : 'idle');
  drawTitleLetters(ctx, 'BLOCKY TALES', W / 2, H * 0.24, titlePx(), '#FFD54A', '#1F2937', t, 1.8, 0.09, 'slide');
  drawEpisode(ctx, t, 3.0);
  fadeFromBlack(ctx, t, 0.4);
}
function introBattle(ctx, t) {
  drawSky(ctx, '#2B3A67', '#FF7A45');
  drawSun(ctx, W * 0.80, H * 0.30, 0.9, '#FF6B35');
  drawClouds(ctx, t, 'rgba(40,30,60,0.55)');
  drawGround(ctx, '#3E7A2C', '#6B4423');
  drawTree(ctx, W * 0.06, 1);
  drawChar(ctx, W * 0.18, t, 'idle');
  drawWallBlocks(ctx, t);
  drawTitleLetters(ctx, 'BLOCKY TALES', W / 2, H * 0.24, titlePx(), '#FFD54A', '#1F2937', t, 1.1, 0.07, 'slam');
  drawEpisode(ctx, t, 2.6);
  fadeFromBlack(ctx, t, 0.4);
}
function introNight(ctx, t) {
  drawSky(ctx, '#0B1026', '#27356B');
  drawStars(ctx, t);
  drawSun(ctx, W * 0.82, H * 0.14, 0.9, '#F4F1DE');
  drawClouds(ctx, t, 'rgba(120,130,180,0.5)');
  drawGround(ctx, '#2F6B24', '#5A3A20');
  drawTree(ctx, W * 0.06, 1);
  drawFlowers(ctx);
  drawChar(ctx, W * 0.18, t, 'idle');
  var B = 0.03 * W;
  var base = groundY();
  for (var i = 0; i < 6; i++) {
    var prog = ((t * 30 * SC + i * 90 * SC) % (H * 0.5)) / (H * 0.5);
    var bx = (0.55 + i * 0.05) * W + Math.sin(t * 0.8 + i) * 20 * SC;
    var by = base - B - prog * H * 0.5;
    var alpha = Math.sin(Math.PI * prog);
    if (alpha <= 0) continue;
    ctx.save();
    ctx.globalAlpha = alpha;
    R(ctx, bx, by, B, B, ['#9AA3AD', '#FFD54A', '#5FAE3F'][i % 3]);
    ctx.restore();
  }
  drawTitleLetters(ctx, 'BLOCKY TALES', W / 2, H * 0.24, titlePx(), '#FFD54A', '#1F2937', t, 1.0, 0.10, 'fade');
  drawEpisode(ctx, t, 3.0);
  fadeFromBlack(ctx, t, 0.4);
}

// ---- Outro: tieu de + hang nut LIKE / SHARE / SUBSCRIBE ----
function drawCTA(ctx, t, start) {
  var bw = W * 0.22;
  var bh = H * 0.14;
  var gap = W * 0.03;
  var total = 3 * bw + 2 * gap;
  var x0 = (W - total) / 2;
  var y = H * 0.56;
  var items = [
    { icon: 'like', word: 'LIKE', color: '#2F7DE1' },
    { icon: 'share', word: 'SHARE', color: '#34A853' },
    { icon: 'bell', word: 'SUBSCRIBE', color: '#E62117' }
  ];
  var px = Math.max(4, Math.floor(Math.min(bw * 0.85 / (9 * 6), bh * 0.22)));
  var iconPx = Math.max(4, Math.floor(bh * 0.055));
  for (var i = 0; i < 3; i++) {
    var it = items[i];
    var lt = t - start - i * 0.25;
    if (lt < 0) continue;
    var sc = easeOutBack(lt / 0.5);
    if (it.word === 'SUBSCRIBE' && lt > 0.5) sc = 1 + Math.sin((lt - 0.5) * 5) * 0.04;
    var bx = x0 + i * (bw + gap);
    ctx.save();
    ctx.translate(bx + bw / 2, y + bh / 2); ctx.scale(sc, sc); ctx.translate(-(bx + bw / 2), -(y + bh / 2));
    R(ctx, bx, y, bw, bh, it.color);
    R(ctx, bx, y, bw, bh * 0.12, 'rgba(255,255,255,0.22)');
    var iw = 6 * iconPx;
    drawIcon(ctx, it.icon, bx + bw / 2 - iw / 2, y + bh * 0.14, iconPx, '#FFFFFF');
    drawText(ctx, it.word, bx + bw / 2, y + bh * 0.58, px, '#FFFFFF', null);
    ctx.restore();
  }
}
function outroBase(ctx, t, skyTop, skyBot, sunColor, headline, isNight) {
  drawSky(ctx, skyTop, skyBot);
  if (isNight) drawStars(ctx, t);
  else drawSun(ctx, W * 0.80, H * 0.22, 1, sunColor);
  drawClouds(ctx, t, isNight ? 'rgba(120,130,180,0.5)' : 'rgba(255,255,255,0.85)');
  drawGround(ctx, isNight ? '#2F6B24' : '#4E8F33', isNight ? '#5A3A20' : '#7A4E26');
  drawTree(ctx, W * 0.06, 1);
  drawChar(ctx, W * 0.16, t, 'wave');
  var px = Math.max(8, Math.floor(W * 0.85 / (headline.length * 6)));
  drawTitleLetters(ctx, headline, W / 2, H * 0.20, px, '#FFD54A', '#1F2937', t, 0.3, 0.03, 'slam');
  drawCTA(ctx, t, 1.2);
  var foot = 'BLOCKY TALES - BIG ADVENTURES IN A TINY BLOCKY WORLD';
  var fpx = Math.max(5, Math.floor(W * 0.004));
  var flines = wrapText(foot, W * 0.9, fpx, 2);
  for (var i = 0; i < flines.length; i++) drawText(ctx, flines[i], W / 2, H * 0.80 + i * (8 * fpx + 6 * SC), fpx, '#FFFFFF', '#1F2937');
  if (t > 7.2) {
    ctx.save();
    ctx.globalAlpha = (t - 7.2) / 0.8;
    R(ctx, 0, 0, W, H, '#000000');
    ctx.restore();
  }
}
// ---- Thumbnail tuy chinh (1280x720): chu to, mau tuong phan manh ----
// Nguyen tac thu hut: chu hook ngan gon that to (khong dung ten tap dai
// vi chu se be ti khong doc duoc), nhan vat to/ro mat, mau nen tuoi hoac
// toi tuong phan manh voi chu. 4 kieu, cung ten kieu voi intro/outro de
// video dong bo (village dung chung kieu castle vi cung la canh ngay).
// Co chu thich ung cho tieu de thumbnail/tap: thu px tu co so xuong toi 8
// sao cho ca cau vua trong maxLines dong va khoi chu khong vuot maxH.
// Neu toi px=8 ma khoi chu van vua chieu cao thi chap nhan them dong
// (khong cat "..."); chi cat khi ca chieu cao cung vuot (tieu de cuc dai).
function fitTitle(text, maxW, maxLines, maxH, basePx) {
  var px = basePx || Math.max(8, Math.floor(Math.min(W * 0.012, H * 0.022)));
  var fit = Math.floor(maxW / 72);
  if (fit < px && fit >= 8) px = fit;
  var lines = [];
  while (true) {
    lines = wrapText(text, maxW, px, 1000000);
    var lineH = 8 * px + 8 * SC;
    var blockH = lines.length * lineH - 8 * SC;
    if ((lines.length <= maxLines && blockH <= maxH) || px <= 8) break;
    px--;
  }
  var lineH2 = 8 * px + 8 * SC;
  var blockH2 = lines.length * lineH2 - 8 * SC;
  if (blockH2 > maxH) lines = wrapText(text, maxW, px, maxLines);
  return { px: px, lines: lines };
}
function drawThumbTitleFit(ctx, text, cx, y, color, outline, maxW, maxLines, maxH, banner, pos, basePx) {
  var f = fitTitle(text, maxW, maxLines, maxH, basePx);
  var px = f.px, lines = f.lines;
  var lineH = 8 * px + 8 * SC;
  var blockH = lines.length * lineH - 8 * SC;
  var y0 = y;
  if (pos === 'bottom') y0 = H - blockH - 24 * SC;
  if (banner) {
    var bw = 0;
    for (var i = 0; i < lines.length; i++) { var w = textWidth(lines[i], px); if (w > bw) bw = w; }
    var pad = 14 * SC;
    R(ctx, cx - bw / 2 - pad, y0 - pad, bw + pad * 2, blockH + pad * 2, banner);
  }
  for (var j = 0; j < lines.length; j++) drawText(ctx, lines[j], cx, y0 + j * lineH, px, color, outline);
  return lines;
}
function drawThumbTitle(ctx, text, cx, y, px, color, outline, maxW, maxLines, banner) {
  var lines = wrapText(text, maxW, px, maxLines);
  var lineH = 8 * px + 8 * SC;
  var blockH = lines.length * lineH - 8 * SC;
  if (banner) {
    var bw = 0;
    for (var i = 0; i < lines.length; i++) { var w = textWidth(lines[i], px); if (w > bw) bw = w; }
    var pad = 14 * SC;
    R(ctx, cx - bw / 2 - pad, y - pad, bw + pad * 2, blockH + pad * 2, banner);
  }
  for (var j = 0; j < lines.length; j++) drawText(ctx, lines[j], cx, y + j * lineH, px, color, outline);
  return lines;
}
function drawBigHead(ctx, cx, cy, u) {
  R(ctx, cx - u, cy - u, 2 * u, 2 * u, '#F2C79B');
  R(ctx, cx - u, cy - u, 2 * u, u * 0.6, '#6B4A2F');
  var ew = u * 0.42;
  R(ctx, cx - u * 0.72, cy - u * 0.15, ew, ew, '#FFFFFF');
  R(ctx, cx + u * 0.30, cy - u * 0.15, ew, ew, '#FFFFFF');
  R(ctx, cx - u * 0.60, cy - u * 0.03, ew * 0.5, ew * 0.5, '#1F2937');
  R(ctx, cx + u * 0.42, cy - u * 0.03, ew * 0.5, ew * 0.5, '#1F2937');
  R(ctx, cx - u * 0.30, cy + u * 0.45, u * 0.6, u * 0.45, '#7A1F1F');
  R(ctx, cx - u * 0.30, cy + u * 0.75, u * 0.6, u * 0.15, '#FF8A8A');
}
function renderThumbCastle(ctx) {
  drawSky(ctx, '#6FB7E8', '#CDEBFF');
  drawSun(ctx, W * 0.82, H * 0.12, 1, '#FFD54A');
  drawClouds(ctx, 2.5, 'rgba(255,255,255,0.95)');
  drawGround(ctx, '#5FAE3F', '#8B5A2B');
  drawTree(ctx, W * 0.05, 1);
  drawFlowers(ctx);
  drawFallingBlocks(ctx, 4.9);
  drawChar(ctx, W * 0.16, 2.5, 'idle', 26 * SC * 2.2);
  drawThumbTitleFit(ctx, THUMB_TEXT, W / 2, H * 0.10, '#FFD54A', '#1F2937', W * 0.88, 3, H * 0.5, null, 'top');
}
function renderThumbFace(ctx) {
  drawSky(ctx, '#FFD54A', '#FF8C42');
  drawClouds(ctx, 2.5, 'rgba(255,255,255,0.9)');
  drawGround(ctx, '#5FAE3F', '#8B5A2B');
  drawBigHead(ctx, W * 0.26, H * 0.52, H * 0.22);
  drawThumbTitleFit(ctx, THUMB_TEXT, W * 0.70, H * 0.30, '#FFFFFF', '#1F2937', W * 0.52, 3, H * 0.5, null, 'top');
}
function renderThumbBattle(ctx) {
  drawSky(ctx, '#3A1F3D', '#FF5A3C');
  drawSun(ctx, W * 0.80, H * 0.30, 0.9, '#FF3B30');
  drawClouds(ctx, 2.5, 'rgba(40,30,60,0.55)');
  drawGround(ctx, '#3E7A2C', '#6B4423');
  drawWallBlocks(ctx, 4.9);
  drawChar(ctx, W * 0.16, 2.5, 'idle', 26 * SC * 2.2);
  drawThumbTitleFit(ctx, THUMB_TEXT, W / 2, H * 0.10, '#FFD54A', '#1F2937', W * 0.88, 3, H * 0.5, 'rgba(0,0,0,0.45)', 'top');
}
function renderThumbNight(ctx) {
  drawSky(ctx, '#0B1026', '#27356B');
  drawStars(ctx, 2.5);
  drawSun(ctx, W * 0.82, H * 0.14, 0.9, '#F4F1DE');
  drawClouds(ctx, 2.5, 'rgba(120,130,180,0.5)');
  drawGround(ctx, '#2F6B24', '#5A3A20');
  drawTree(ctx, W * 0.06, 1);
  var u = 26 * SC * 2.2;
  drawChar(ctx, W * 0.16, 2.5, 'idle', u);
  var lx = W * 0.16 + 2 * u + 20 * SC;
  var ly = groundY() - 3 * u;
  R(ctx, lx - 40 * SC, ly - 40 * SC, 80 * SC, 80 * SC, 'rgba(255,220,100,0.25)');
  R(ctx, lx, ly, 24 * SC, 24 * SC, '#FFD54A');
  drawThumbTitleFit(ctx, THUMB_TEXT, W / 2, H * 0.10, '#FFF59D', '#1F2937', W * 0.88, 3, H * 0.5, null, 'top');
}
function renderThumbnail() {
  var ctx = cv();
  ctx.clearRect(0, 0, W, H);
  if (BG_IMG) {
    // Nen la frame that tu phan canh hook: ve kin khung + lop toi nhe de
    // chu noi, roi chi ve tieu de (khong ve nhan vat/khoi ve san nua).
    // Tieu de dat o phia doi dien khung chu game: hook la thoai (khung
    // chu tren) thi tieu de xuong duoi, hook la loi dan (khung chu duoi)
    // thi tieu de len tren — khoi de len chu trong frame.
    ctx.drawImage(BG_IMG, 0, 0, W, H);
    R(ctx, 0, 0, W, H, 'rgba(0,0,0,0.25)');
    var pos = (TITLE_POS === 'bottom') ? 'bottom' : 'top';
    drawThumbTitleFit(ctx, THUMB_TEXT, W / 2, H * 0.10, '#FFFFFF', '#1F2937', W * 0.88, 3, H * 0.5, 'rgba(0,0,0,0.45)', pos);
    return;
  }
  if (STYLE === 'battle') renderThumbBattle(ctx);
  else if (STYLE === 'night') renderThumbNight(ctx);
  else if (STYLE === 'face') renderThumbFace(ctx);
  else renderThumbCastle(ctx);
}
function renderIntro(t) {
  var ctx = cv();
  ctx.clearRect(0, 0, W, H);
  if (STYLE === 'village') introVillage(ctx, t);
  else if (STYLE === 'battle') introBattle(ctx, t);
  else if (STYLE === 'night') introNight(ctx, t);
  else introCastle(ctx, t);
}
function renderOutro(t) {
  var ctx = cv();
  ctx.clearRect(0, 0, W, H);
  if (STYLE === 'village') outroBase(ctx, t, '#E8915A', '#FFD9A0', '#FF8C42', 'SEE YOU IN THE NEXT ADVENTURE!', false);
  else if (STYLE === 'battle') outroBase(ctx, t, '#3A1F3D', '#FF5A3C', '#FF3B30', 'DONT MISS THE NEXT BATTLE!', false);
  else if (STYLE === 'night') outroBase(ctx, t, '#0B1026', '#27356B', '#F4F1DE', 'GOOD NIGHT, ADVENTURERS!', true);
  else outroBase(ctx, t, '#4A5FA5', '#FF9A5A', '#FF8C42', 'THANKS FOR WATCHING!', false);
}
window.renderIntro = renderIntro;
window.renderOutro = renderOutro;
window.renderThumbnail = renderThumbnail;
window.__test = { FONT: FONT, wrapText: wrapText, drawText: drawText, drawTitleLetters: drawTitleLetters, drawCTA: drawCTA, drawThumbTitle: drawThumbTitle, fitTitle: fitTitle, drawThumbTitleFit: drawThumbTitleFit, textWidth: textWidth, STYLES: ['castle', 'village', 'battle', 'night'], THUMB_STYLES: ['castle', 'face', 'battle', 'night'] };
</script></body></html>
`;

function buildPage(w, h, episodeTitle, style, thumbText, bgDataUri, titlePos) {
  return PAGE_TEMPLATE
    .replace(/@@W@@/g, String(w))
    .replace(/@@H@@/g, String(h))
    .replace(/@@EPISODE@@/g, JSON.stringify(episodeTitle || ''))
    .replace(/@@THUMB@@/g, JSON.stringify(thumbText || episodeTitle || ''))
    .replace(/@@BG@@/g, JSON.stringify(bgDataUri || ''))
    .replace(/@@TITLE_POS@@/g, titlePos === 'bottom' ? 'bottom' : 'top')
    .replace(/@@STYLE@@/g, style);
}

// ---- Driver: chup frame theo thoi gian ao, ghep nhac, doi chapters ----
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'], ...opts });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(cmd + ' thoát với mã ' + code))));
  });
}

async function renderClip(page, kind, secs, silentPath) {
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
    silentPath
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg thoát với mã ' + code))));
  });
  const fn = kind === 'intro' ? 'renderIntro' : 'renderOutro';
  const frames = Math.round(secs * FPS);
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const dataUrl = await page.evaluate((args) => {
      window[args.fn](args.t);
      return document.getElementById('c').toDataURL('image/png');
    }, { fn, t });
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await ffDone;
}

async function addMusic(silentPath, outPath, secs) {
  const hasMusic = MUSIC_PATH && fs.existsSync(MUSIC_PATH);
  const fadeOutStart = (secs - FADE).toFixed(2);
  const filter = hasMusic
    ? '[1:a]volume=' + MUSIC_VOL + ',afade=t=in:st=0:d=' + FADE + ',afade=t=out:st=' + fadeOutStart + ':d=' + FADE + '[a]'
    : '[1:a]afade=t=in:st=0:d=' + FADE + ',afade=t=out:st=' + fadeOutStart + ':d=' + FADE + '[a]';
  const args = ['-y', '-v', 'error', '-i', silentPath];
  if (hasMusic) args.push('-stream_loop', '-1', '-i', MUSIC_PATH);
  else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-filter_complex', filter,
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-t', String(secs), outPath
  );
  await run('ffmpeg', args);
  if (!hasMusic) console.log('  (không có file nhạc nền, dùng tiếng im lặng cho clip)');
}

// Thumbnail 1280x720 (chuẩn YouTube), xuất JPG dưới 2MB (giới hạn của
// YouTube cho ảnh tùy chỉnh): thử chất lượng 3 rồi 5, 7 nếu vẫn quá nặng.
async function makeThumbnail(browser, episodeTitle, style, thumbText, bgPath, titlePos) {
  let bgDataUri = '';
  if (bgPath && fs.existsSync(bgPath)) {
    const mime = /\.png$/i.test(bgPath) ? 'image/png' : 'image/jpeg';
    bgDataUri = 'data:' + mime + ';base64,' + fs.readFileSync(bgPath).toString('base64');
    console.log('Nền thumbnail: frame thật ' + bgPath + ' (tiêu đề ở phía ' + (titlePos === 'bottom' ? 'dưới' : 'trên') + ').');
  }
  const html = buildPage(1280, 720, episodeTitle, style, thumbText, bgDataUri, titlePos);
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html);
  await page.waitForFunction(() => typeof window.renderThumbnail === 'function');
  try {
    await page.waitForFunction(() => window.__bgReady === true, null, { timeout: 15000 });
  } catch (_) {
    console.log('  (ảnh nền tải chậm/lỗi — dùng nền vẽ sẵn.)');
  }
  const dataUrl = await page.evaluate(() => {
    window.renderThumbnail();
    return document.getElementById('c').toDataURL('image/png');
  });
  fs.writeFileSync('thumb_tmp.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
  try {
    for (const q of [3, 5, 7]) {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', 'thumb_tmp.png', '-q:v', String(q), THUMBNAIL_OUT]);
      if (fs.statSync(THUMBNAIL_OUT).size < 2 * 1024 * 1024) break;
    }
    const size = fs.statSync(THUMBNAIL_OUT).size;
    if (size >= 2 * 1024 * 1024) throw new Error('thumbnail JPG vẫn >= 2MB sau khi giảm chất lượng');
    console.log('Xong thumbnail: ' + THUMBNAIL_OUT + ' (' + size + ' bytes, kiểu ' + style + ').');
  } finally {
    try { fs.unlinkSync('thumb_tmp.png'); } catch (_) {}
  }
}

async function main() {
  const script = JSON.parse(fs.readFileSync(SCRIPT_PATH, 'utf-8'));
  const episodeTitle = script.video_title || script.name || '';
  // Chữ trên thumbnail: ưu tiên câu hook ngắn do tác giả ghi
  // (video_thumbnail_text) vì chữ to mới thu hút; không có thì dùng tên
  // tập — chữ sẽ tự co nhỏ để hiển thị đủ, không bị cắt bớt bằng "...".
  const thumbText = script.video_thumbnail_text || episodeTitle;
  if (!script.video_thumbnail_text) {
    console.log('  (gợi ý) kịch bản chưa có video_thumbnail_text nên thumbnail dùng tên tập — nên ghi 1 câu ngắn gọn, gây tò mò (vd "GODZILLA WANTS CAKE!") để chữ to và dễ đọc.');
  }
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio']
  });
  try {
    // Chế độ chỉ làm thumbnail: dùng cùng kiểu với intro/outro của video
    // đó nếu bước intro đã lưu style vào meta (village -> castle, vì
    // thumbnail không có kiểu village riêng); không có thì dùng --style,
    // rồi cuối cùng là bốc ngẫu nhiên trong 4 kiểu thumbnail.
    if (THUMBNAIL_ONLY) {
      if (!THUMBNAIL_OUT) throw new Error('chế độ --thumbnail-only cần --thumbnail <file>');
      let style = STYLE_ARG;
      try {
        const m = JSON.parse(fs.readFileSync(META_OUT, 'utf-8'));
        if (m.style === 'village') style = 'castle';
        else if (THUMB_STYLES.includes(m.style)) style = m.style;
      } catch (_) {}
      if (!THUMB_STYLES.includes(style)) {
        style = THUMB_STYLES[crypto.randomInt(THUMB_STYLES.length)];
        console.log('Kiểu thumbnail bốc ngẫu nhiên: ' + style);
      } else {
        console.log('Kiểu thumbnail: ' + style);
      }
      await makeThumbnail(browser, episodeTitle, style, thumbText, BG_PATH, TITLE_POS_ARG);
      return;
    }
    let style = STYLE_ARG;
    if (!STYLES.includes(style)) {
      style = STYLES[crypto.randomInt(STYLES.length)];
      console.log('Kiểu intro/outro bốc ngẫu nhiên: ' + style + ' (muốn cố định thì điền ô intro_style lúc chạy).');
    } else {
      console.log('Kiểu intro/outro: ' + style);
    }
    // Lưu style vào meta để bước thumbnail sau dùng cùng kiểu.
    try {
      if (fs.existsSync(META_OUT)) {
        const m = JSON.parse(fs.readFileSync(META_OUT, 'utf-8'));
        m.style = style;
        fs.writeFileSync(META_OUT, JSON.stringify(m, null, 2), 'utf-8');
      }
    } catch (_) {}
    const html = buildPage(WIDTH, HEIGHT, episodeTitle, style, thumbText);
    const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.setContent(html);
    await page.waitForFunction(() => typeof window.renderIntro === 'function' && typeof window.renderOutro === 'function');
    console.log('Đang vẽ intro (' + INTRO_SECS + 's)...');
    await renderClip(page, 'intro', INTRO_SECS, 'intro_silent.mp4');
    await addMusic('intro_silent.mp4', INTRO_OUT, INTRO_SECS);
    console.log('Xong intro: ' + INTRO_OUT);
    console.log('Đang vẽ outro (' + OUTRO_SECS + 's)...');
    await renderClip(page, 'outro', OUTRO_SECS, 'outro_silent.mp4');
    await addMusic('outro_silent.mp4', OUTRO_OUT, OUTRO_SECS);
    console.log('Xong outro: ' + OUTRO_OUT);
  } catch (e) {
    // All-or-nothing: lỗi giữa chừng thì xóa cả 2 clip để bước ghép không
    // ghép lẻ 1 clip (làm lệch chapters, vì chapters chỉ cộng khi đủ cả 2).
    // Thumbnail lỗi cũng xóa file dở dang để bước đăng không đăng ảnh lỗi.
    for (const f of [INTRO_OUT, OUTRO_OUT, 'intro_silent.mp4', 'outro_silent.mp4', THUMBNAIL_OUT]) {
      if (!f) continue;
      try { fs.unlinkSync(f); } catch (_) {}
    }
    throw e;
  } finally {
    await browser.close();
  }
  // Cả 2 clip đã xong mới cộng độ dài intro vào chapters (video chính sẽ
  // bị đẩy lùi sau intro). Nếu bước này lỗi trước đó thì không đụng vào
  // meta, bước ghép sẽ giữ nguyên video chính nên chapters vẫn đúng.
  if (fs.existsSync(META_OUT)) {
    try {
      const meta = JSON.parse(fs.readFileSync(META_OUT, 'utf-8'));
      if (Array.isArray(meta.chapters) && meta.chapters.length) {
        meta.chapters = meta.chapters.map((c) => ({ t: c.t + INTRO_SECS, title: c.title }));
        fs.writeFileSync(META_OUT, JSON.stringify(meta, null, 2), 'utf-8');
        console.log('Đã cộng ' + INTRO_SECS + 's (intro) vào ' + meta.chapters.length + ' mốc chapter.');
      }
    } catch (e) {
      console.log('  (cảnh báo) không cập nhật được chapters trong meta: ' + e.message);
    }
  }
}

if (require.main === module) main().catch((e) => { console.error('INTRO/OUTRO THẤT BẠI:', e && e.stack || e); process.exit(1); });
module.exports = { buildPage, STYLES, THUMB_STYLES, INTRO_SECS, OUTRO_SECS };
