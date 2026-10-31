// voice.js — Ráp giọng cho video game: chia câu theo quota API key, tạo TTS,
// đổi cao độ theo từng vai, đặt đúng mốc thời gian, mux vào video.
//
// Luồng làm việc:
//   1. Đọc kịch bản -> danh sách câu thoại theo thứ tự (say/talk/dialogue),
//      mỗi câu đã có sẵn trường pitch (nửa cung) trong file voice_pitch.
//   2. Đọc captions.json do render.js ghi -> mốc thời gian (giây) từng câu.
//      Khớp caption với câu theo nội dung + thứ tự. Caption lạ chen vào
//      (vd câu hệ thống của game) thì bỏ qua, không làm lệch các câu sau.
//   3. Đọc file txt key: mỗi dòng 1 API key ElevenLabs (bỏ dòng trống, dòng
//      bắt đầu bằng #, trùng nhau). Hỏi API /v1/user/subscription xem mỗi key
//      còn bao nhiêu ký tự, rồi CHIA CÂU TRƯỚC KHI TẠO: key nào đủ cho câu
//      nào thì nhận câu đó, hết thì chuyển sang key sau. Nếu không key nào
//      đủ cho 1 câu thì DỪNG NGAY và báo cáo, không đốt quota vô ích.
//   4. Tạo TTS từng câu bằng giọng Antoni qua API ElevenLabs.
//      Gặp lỗi hết quota giữa chừng thì đánh dấu key đó = 0 và chia lại
//      các câu còn lại, không tạo lại từ đầu.
//   5. Đổi cao độ từng câu bằng ffmpeg (API ElevenLabs không có chỉnh pitch):
//      asetrate tăng/giảm tốc độ mẫu theo hệ số 2^(nửa cung/12) rồi atempo
//      trả tốc độ đọc về như cũ -> cao độ đổi mà thời lượng không đổi.
//   6. Đặt mỗi câu vào đúng mốc bằng adelay, trộn lại bằng amix, gắn vào
//      video bằng ffmpeg (video giữ nguyên hình, chỉ thêm tiếng).
//
// Cách dùng:
//   node voice.js --script binance_godzilla_v15_voice_pitch.json \
//     --captions captions.json --keys keys.txt \
//     --video-in video_silent.mp4 --video-out final.mp4
// Tùy chọn:
//   --voice-id (mặc định ErXwobaYiN019PkySvjV = Antoni)
//   --model    (mặc định eleven_multilingual_v2)
//   --eleven-base (mặc định https://api.elevenlabs.io; dùng để test với mock)
//   --music <file> --music-volume 0.2 (nhạc nền, tùy chọn; lặp vô hạn rồi cắt đúng độ dài video)
//   --work-dir (mặc định ./voice_work)
//   --meta-out (mặc định ./upload_meta.json) — file tiêu đề + mô tả + tags +
//     chapter lấy từ kịch bản (video_title/video_description, nếu không có
//     thì lấy name/description; tags từ video_tags nếu có; chapter từ
//     trường chapter gắn vào câu say/talk/dialogue mở đầu phân cảnh) để
//     bước sau dùng đăng YouTube.
//   --script-name (tên file kịch bản gốc trên host, để ghi vào meta-out;
//     mặc định lấy tên file --script)

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function hasArg(name) { return process.argv.includes('--' + name); }

const SCRIPT_PATH = arg('script', './binance_godzilla_v15_voice_pitch.json');
const CAPTIONS_PATH = arg('captions', './captions.json');
const KEYS_PATH = arg('keys', './keys.txt');
const VIDEO_IN = arg('video-in', './video_silent.mp4');
const VIDEO_OUT = arg('video-out', './final.mp4');
const WORK_DIR = arg('work-dir', './voice_work');
const VOICE_ID = arg('voice-id', 'ErXwobaYiN019PkySvjV'); // Antoni
const MODEL_ID = arg('model', 'eleven_multilingual_v2');
const ELEVEN_BASE = (arg('eleven-base', 'https://api.elevenlabs.io') || '').replace(/\/$/, '');
const MUSIC = arg('music', null);
const MUSIC_VOL = arg('music-volume', '0.2');
const META_OUT = arg('meta-out', './upload_meta.json');
const SCRIPT_NAME = arg('script-name', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mask = (k) => (k.length <= 8 ? '****' : k.slice(0, 4) + '…' + k.slice(-4));
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const charsOf = (s) => [...String(s)].length;

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} -> mã ${code}: ${err.slice(-2000)}`))));
  });
}
async function ffprobeDuration(file) {
  const out = await new Promise((resolve, reject) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = '';
    p.stdout.on('data', (d) => { so += d; });
    p.stderr.on('data', (d) => { se += d; });
    p.on('close', (code) => (code === 0 ? resolve(so.trim()) : reject(new Error('ffprobe: ' + se))));
  });
  return parseFloat(out);
}

// ---- 1. Danh sách câu thoại từ kịch bản ----
// Kịch bản của anh toàn bộ bằng tiếng Anh, nhưng file mẫu v15 vẫn là tiếng
// Việt nên nhãn lời dẫn và tên vai mặc định được đoán theo ngôn ngữ của
// kịch bản: có dấu tiếng Việt thì dùng nhãn Việt, còn lại dùng nhãn Anh.
function detectLang(script) {
  const viRe = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i;
  for (const s of script.steps || []) {
    const texts = [];
    if (s.text) texts.push(s.text);
    if (s.do === 'dialogue') for (const ln of s.lines || []) if (ln.text) texts.push(ln.text);
    if (texts.some((t) => viRe.test(String(t)))) return 'vi';
  }
  return 'en';
}

function extractLines(script) {
  const lang = detectLang(script);
  const names = lang === 'vi'
    ? { player: 'Bạn', godzilla: 'Godzilla', binance_hq: 'Loa Binance' }
    : { player: 'Player', godzilla: 'Godzilla', binance_hq: 'Binance HQ Announcer' };
  for (const s of script.steps || []) {
    if (s.do === 'character' && s.id && s.name) names[s.id] = s.name;
  }
  const narrationLabel = lang === 'vi' ? 'Lời dẫn' : 'Narrator';
  const lines = [];
  // Chapter: step (hoặc dòng dialogue) nào mang trường chapter (chuỗi tên
  // phân cảnh) thì câu đó mở đầu 1 chapter. Thời gian của chapter lấy từ
  // mốc caption của chính câu đó (xem matchCaptions) nên luôn khớp video.
  // Hook: câu nào mang "hook": true thì câu đó là đoạn hay đặt sau intro
  // (xem hookWindow). Game bỏ qua cả 2 trường này nên kịch bản vẫn chạy
  // bình thường.
  const chapterOf = (o) => (typeof o.chapter === 'string' && o.chapter.trim() ? o.chapter.trim() : null);
  for (const s of script.steps || []) {
    if (s.do === 'say' && s.text && String(s.text).trim()) {
      lines.push({ kind: 'say', speaker: narrationLabel, speakerKey: 'narration', text: s.text, pitch: (typeof s.pitch === 'number' ? s.pitch : null), chapter: chapterOf(s), hook: s.hook === true });
    } else if (s.do === 'talk' && s.text && String(s.text).trim()) {
      const sp = s.speaker || s.speakerName || 'player';
      lines.push({ kind: 'talk', speaker: names[sp] || sp, speakerKey: sp, text: s.text, pitch: (typeof s.pitch === 'number' ? s.pitch : null), chapter: chapterOf(s), hook: s.hook === true });
    } else if (s.do === 'dialogue') {
      for (const ln of s.lines || []) {
        if (ln.text && String(ln.text).trim()) {
          lines.push({ kind: 'dialogue', speaker: names[ln.speaker] || ln.speaker, speakerKey: ln.speaker, text: ln.text, pitch: (typeof ln.pitch === 'number' ? ln.pitch : null), chapter: chapterOf(ln), hook: ln.hook === true });
        }
      }
    }
  }
  return lines;
}

// ---- Hook: vài giây đoạn hay đặt ngay sau intro ----
// Làm sao biết đoạn nào hay? Đáng tin nhất là tác giả đánh dấu ("hook":
// true vào câu say/talk hoặc dòng dialogue) — chính người viết kịch bản
// mới biết đoạn nào gây tò mò, buồn cười hay kịch tính nhất (thường là
// câu thách thức của nhân vật phản diện, cú twist, hay câu punchline).
// Nếu không có câu nào được đánh dấu thì máy đoán: câu thoại đầu tiên của
// nhân vật (không phải lời dẫn) có dấu "!" và nằm sau 25% video — thường
// là câu đòi hỏi, hăm dọa hay cao trào. Đoán chỉ là dự phòng, log sẽ ghi
// rõ là tự chọn để lần sau đánh dấu tay cho chắc.
// Trả về {start, end, text, auto} hoặc null (không có hook). Cửa sổ cắt:
// từ 0.5s trước câu đến 0.3s sau câu kế tiếp (hoặc +6s nếu là câu cuối).
function hookWindow(lines, videoDur) {
  // Mốc dùng để cắt hook: ưu tiên mốc ĐÃ XẾP LỊCH (start) vì đó mới là
  // lúc câu thoại thật sự phát ra trong video cuối; chưa xếp lịch thì
  // dùng mốc caption (time) như cũ.
  const tOf = (l) => (typeof l.start === 'number' ? l.start : l.time);
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].hook && typeof tOf(lines[i]) === 'number') { idx = i; break; }
  }
  let auto = false;
  if (idx < 0) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.kind !== 'say' && typeof tOf(l) === 'number' && tOf(l) > videoDur * 0.25 && /!/.test(l.text)) { idx = i; auto = true; break; }
    }
  }
  if (idx < 0) return null;
  const line = lines[idx];
  let nextT = null;
  for (let j = idx + 1; j < lines.length; j++) {
    if (typeof tOf(lines[j]) === 'number') { nextT = tOf(lines[j]); break; }
  }
  const lt = tOf(line);
  const start = Math.max(0, lt - 0.5);
  let end = nextT !== null ? Math.min(videoDur, nextT + 0.3) : Math.min(videoDur, lt + 6);
  if (end - start < 1.5) end = Math.min(videoDur, start + 3);
  if (end - start < 1.5) return null;
  // lineTime: mốc caption (thời gian video) của chính câu hook — bước
  // thumbnail dùng nó để cắt 1 frame thật từ phân cảnh hook làm nền.
  // kind: 'say' (lời dẫn, khung chữ dưới) hay thoại (khung chữ trên) —
  // bước thumbnail đặt tiêu đề ở phía đối diện để khỏi đè lên khung chữ.
  return { start, end, text: line.text, auto, lineTime: lt, kind: line.kind || null };
}

// Xếp lịch phát giọng theo 2 chuỗi riêng: lời dẫn (kind 'say') xếp với
// nhau, lời thoại xếp với nhau — cùng loại không bao giờ chồng nhau.
// KHÁC loại được phép trùng mốc (vd lời thoại chạy dài đè lên lời dẫn
// tới sau): lúc đó bước ráp sẽ dùng ducking — thoại tự hạ nhỏ dưới lời
// dẫn rồi tự to lại khi lời dẫn hết (xem phần ráp bên dưới).
// Trả về { audioEnd, maxLag }.
// (Lý do cần xếp lại: game chờ mỗi câu theo max(2, ký tự × 0.05–0.06s)
// nhưng giọng đọc tiếng Anh thường chậm hơn (~0.07s/ký tự) nên đặt đúng
// mốc caption sẽ làm câu sau đè lên câu trước.)
function scheduleLines(lines) {
  let prevNarEnd = 0, prevDlgEnd = 0, maxLag = 0;
  for (const l of lines) {
    if (typeof l.time !== 'number' || typeof l.dur !== 'number') { l.start = null; continue; }
    const prevEnd = l.kind === 'say' ? prevNarEnd : prevDlgEnd;
    const start = Math.max(l.time, prevEnd);
    l.start = start;
    l.end = start + l.dur;
    l.lag = start - l.time;
    if (l.lag > maxLag) maxLag = l.lag;
    if (l.kind === 'say') prevNarEnd = l.end; else prevDlgEnd = l.end;
  }
  return { audioEnd: Math.max(prevNarEnd, prevDlgEnd), maxLag };
}

// Pitch từ bảng voice.roles của chính kịch bản (nếu có) — dùng khi câu chưa
// gắn sẵn pitch. Khớp theo đúng khóa vai (vd quan_gia, na, cz...).
function rolePitch(script, line) {
  const roles = (script.voice && script.voice.roles) || {};
  if (line.kind === 'say' && roles.narration && typeof roles.narration.semitones === 'number') return roles.narration.semitones;
  const k = line.speakerKey;
  if (k && roles[k] && typeof roles[k].semitones === 'number') return roles[k].semitones;
  if (k === 'CZ (qua điện thoại)' && roles.cz_phone && typeof roles.cz_phone.semitones === 'number') return roles.cz_phone.semitones;
  return null;
}

// Pitch dự phòng cho kịch bản chưa gắn sẵn pitch: đoán theo vai từ tên
// nhân vật (bảng chuẩn lấy theo giọng Antoni). Hỗ trợ cả tên tiếng Anh
// (kịch bản trong kb_github) và tên tiếng Việt (file mẫu v15) — cùng một
// vai thì cùng một pitch. Trả null nếu không đoán được để bước sau cảnh
// báo và dùng 0, thay vì im lặng gán sai.
function fallbackPitch(kind, speaker) {
  if (kind === 'say') return 0; // lời dẫn luôn là mốc 0
  const n = String(speaker || '').toLowerCase();
  if (n.includes('godzilla')) return -6;
  if (n.includes('bé') || n.includes('baby') || n.includes('kid') || n.includes('child') || n.includes('lily') || /(^|[^a-z])na([^a-z]|$)/.test(n)) return 6;
  if (n.includes('quản gia') || n.includes('housekeeper')) return -2;
  if (n.includes('bảo vệ') || n.includes('guard') || n.includes('bao') || /(^|[^a-z])ben([^a-z]|$)/.test(n)) return -4;
  if (n.includes('lễ tân') || n.includes('receptionist') || n.includes('anna') || /(^|[^a-z])an([^a-z]|$)/.test(n)) return 3;
  if (n.includes('cz')) return -1;
  if (n.includes('loa') || n.includes('announcer') || n.includes('hq') || n.includes('binance')) return 2;
  if (n.includes('bạn') || n.includes('player') || /(^|[^a-z])you([^a-z]|$)/.test(n)) return 1;
  if (n.includes('lời dẫn') || n.includes('narrator') || n.includes('narration')) return 0;
  return null;
}

// ---- 2. Khớp caption với câu ----
function matchCaptions(lines, captions) {
  const unmatchedLines = [];
  const extraCaptions = [];
  let j = 0;
  for (const cap of captions) {
    const cn = norm(cap.text);
    if (j < lines.length && norm(lines[j].text) === cn) {
      lines[j].time = cap.t; j++;
      continue;
    }
    let found = -1;
    for (let k = j + 1; k < Math.min(lines.length, j + 4); k++) {
      if (norm(lines[k].text) === cn) { found = k; break; }
    }
    if (found >= 0) {
      for (let k = j; k < found; k++) unmatchedLines.push(lines[k]);
      lines[found].time = cap.t; j = found + 1;
    } else {
      extraCaptions.push(cap); // caption lạ của game, bỏ qua
    }
  }
  for (; j < lines.length; j++) unmatchedLines.push(lines[j]);
  return { unmatchedLines, extraCaptions };
}

// ---- 3. Key + quota ----
async function checkQuota(key) {
  const headers = { 'xi-api-key': key };
  let r = await fetch(`${ELEVEN_BASE}/v1/user/subscription`, { headers });
  let j = null;
  try { j = await r.json(); } catch (e) { /* không phải JSON */ }
  if (!r.ok || !j) {
    // Dự phòng: endpoint /v1/user cũng trả subscription kèm theo.
    r = await fetch(`${ELEVEN_BASE}/v1/user`, { headers });
    try { j = await r.json(); } catch (e) { j = null; }
    if (j && j.subscription) j = j.subscription;
  }
  if (!r.ok || !j || typeof j.character_count !== 'number' || typeof j.character_limit !== 'number') {
    return { ok: false, remaining: 0, detail: (j && (j.detail || j.message)) || ('HTTP ' + r.status) };
  }
  return { ok: true, remaining: Math.max(0, j.character_limit - j.character_count), used: j.character_count, limit: j.character_limit };
}

// Chia câu: tham lam theo thứ tự, key nào đủ thì nhận câu đó.
function planLines(lines, keys) {
  const remaining = keys.map((k) => k.remaining);
  const assign = new Array(lines.length).fill(-1);
  for (let i = 0; i < lines.length; i++) {
    const need = charsOf(lines[i].text);
    let pick = -1;
    for (let k = 0; k < keys.length; k++) {
      if (remaining[k] >= need) { pick = k; break; }
    }
    if (pick < 0) return { ok: false, line: i, need, remaining };
    assign[i] = pick;
    remaining[pick] -= need;
  }
  return { ok: true, assign, remaining };
}

function planReport(lines, keys, plan) {
  let s = 'Không đủ ký tự cho câu số ' + (plan.line + 1) + ': "' + String(lines[plan.line].text).slice(0, 80) + '" cần ' + plan.need + ' ký tự.\n';
  s += 'Tổng cần cho toàn bộ: ' + lines.reduce((a, l) => a + charsOf(l.text), 0) + ' ký tự.\n';
  keys.forEach((k, i) => { s += `  key ${mask(k.key)}: còn ${plan.remaining[i]} ký tự\n`; });
  s += 'Hãy thêm key vào file txt rồi chạy lại (chưa tạo câu nào nên chưa tốn quota).';
  return s;
}

// ---- 4. Tạo TTS ----
async function tts(key, text) {
  const r = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
    })
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const isQuota = r.status === 401 || r.status === 429 || /quota|character|limit/i.test(body);
    const err = new Error(`ElevenLabs HTTP ${r.status}: ${body.slice(0, 300)}`);
    err.isQuota = isQuota;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

async function main() {
  const script = JSON.parse(fs.readFileSync(SCRIPT_PATH, 'utf-8'));
  const capData = JSON.parse(fs.readFileSync(CAPTIONS_PATH, 'utf-8'));
  const lines = extractLines(script);
  console.log(`Kịch bản: ${lines.length} câu thoại, tổng ${lines.reduce((a, l) => a + charsOf(l.text), 0)} ký tự.`);
  console.log(`Caption bắt được: ${capData.captions.length} mốc.`);

  const { unmatchedLines, extraCaptions } = matchCaptions(lines, capData.captions);
  console.log(`Caption lạ bỏ qua: ${extraCaptions.length}`);
  if (unmatchedLines.length) {
    console.error('KHỚP THẤT BẠI: ' + unmatchedLines.length + ' câu không có mốc thời gian:');
    for (const l of unmatchedLines.slice(0, 20)) console.error('  - ' + String(l.text).slice(0, 100));
    console.error('DỪNG để tránh video lệch tiếng. Kiểm tra lại captions.json / kịch bản.');
    process.exit(3);
  }

  // Thứ tự lấy pitch cho từng câu: (1) pitch gắn sẵn trong câu, (2) bảng
  // voice.roles của kịch bản, (3) đoán theo tên vai. Vai lạ không đoán được
  // thì cảnh báo và dùng 0 (vẫn tạo giọng, nhưng các vai đó khó phân biệt).
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].pitch === null || lines[i].pitch === undefined) {
      let p = rolePitch(script, lines[i]);
      if (p === null) p = fallbackPitch(lines[i].kind, lines[i].speaker);
      if (p === null) console.log(`  (cảnh báo) câu ${i + 1} vai "${lines[i].speaker}" không có pitch và không đoán được vai, dùng 0.`);
      lines[i].pitch = p === null ? 0 : p;
    }
  }

  // Key: mỗi dòng 1 key, bỏ trống/comment/trùng. In ::add-mask:: để log Actions tự che key.
  const rawKeys = fs.readFileSync(KEYS_PATH, 'utf-8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  const seen = new Set();
  const keys = [];
  for (const k of rawKeys) if (!seen.has(k)) { seen.add(k); keys.push({ key: k }); }
  if (!keys.length) { console.error('File key rỗng (mỗi dòng 1 API key).'); process.exit(2); }
  for (const k of keys) console.log('::add-mask::' + k.key);
  console.log(`Có ${keys.length} key. Đang kiểm tra quota từng key...`);
  for (const k of keys) {
    const q = await checkQuota(k.key);
    k.ok = q.ok; k.remaining = q.remaining; k.detail = q.detail;
    console.log(`  key ${mask(k.key)}: ${q.ok ? `còn ${q.remaining} ký tự (đã dùng ${q.used}/${q.limit})` : 'LỖI: ' + q.detail}`);
  }
  const usable = keys.filter((k) => k.ok && k.remaining > 0);
  if (!usable.length) { console.error('Không key nào dùng được. Kiểm tra lại file txt / key ElevenLabs.'); process.exit(2); }

  // Chia câu TRƯỚC khi tạo để không đốt quota vô ích.
  let plan = planLines(lines, usable);
  if (!plan.ok) { console.error(planReport(lines, usable, plan)); process.exit(4); }
  console.log('Chia câu xong:');
  usable.forEach((k, i) => {
    const n = plan.assign.filter((a) => a === i).length;
    console.log(`  key ${mask(k.key)}: nhận ${n} câu, còn lại ${plan.remaining[i]} ký tự sau khi tạo`);
  });

  fs.mkdirSync(WORK_DIR, { recursive: true });
  const generated = new Array(lines.length).fill(false);
  // Tạo từng câu, gặp lỗi quota thì chia lại phần còn lại.
  for (let i = 0; i < lines.length; i++) {
    if (generated[i]) continue;
    const keyIdx = plan.assign[i];
    const key = usable[keyIdx].key;
    const rawPath = path.join(WORK_DIR, `raw_${String(i + 1).padStart(3, '0')}.mp3`);
    try {
      const audio = await tts(key, lines[i].text);
      fs.writeFileSync(rawPath, audio);
    } catch (e) {
      if (e.isQuota) {
        console.log(`Key ${mask(key)} hết quota giữa chừng ở câu ${i + 1}, chia lại các câu còn lại...`);
        usable[keyIdx].remaining = 0;
        const rest = lines.map((l, idx) => ({ l, idx })).filter(({ idx }) => !generated[idx]);
        const sub = planLines(rest.map((x) => x.l), usable);
        if (!sub.ok) {
          const failLine = rest[sub.line].l;
          console.error(`Hết quota khi tạo tới câu ${rest[sub.line].idx + 1}: "${String(failLine.text).slice(0, 80)}" cần ${sub.need} ký tự, không key nào còn đủ.`);
          process.exit(4);
        }
        plan.assign = plan.assign.slice();
        rest.forEach((x, ri) => { plan.assign[x.idx] = sub.assign[ri]; });
        i--; // thử lại câu này với key mới
        continue;
      }
      await sleep(5000);
      try {
        const audio2 = await tts(key, lines[i].text);
        fs.writeFileSync(rawPath, audio2);
      } catch (e2) {
        console.error(`Tạo câu ${i + 1} thất bại 2 lần: ${e2.message}`);
        process.exit(5);
      }
    }
    // Đổi cao độ: f = 2^(nửa cung/12), asetrate đổi mẫu rồi atempo trả tốc độ.
    const pitch = lines[i].pitch || 0;
    const pitchedPath = path.join(WORK_DIR, `pitched_${String(i + 1).padStart(3, '0')}.wav`);
    if (pitch === 0) {
      await run('ffmpeg', ['-y', '-v', 'error', '-i', rawPath, '-af', 'aresample=44100', pitchedPath]);
    } else {
      const rate = Math.round(44100 * Math.pow(2, pitch / 12));
      const tempo = (44100 / rate).toFixed(6);
      await run('ffmpeg', ['-y', '-v', 'error', '-i', rawPath, '-af', `asetrate=${rate},aresample=44100,atempo=${tempo}`, pitchedPath]);
    }
    lines[i].pitched = pitchedPath;
    lines[i].keyMasked = mask(key);
    lines[i].chars = charsOf(lines[i].text);
    generated[i] = true;
    if ((i + 1) % 10 === 0) console.log(`Đã tạo ${i + 1}/${lines.length} câu...`);
  }
  console.log(`Đã tạo đủ ${lines.length} câu.`);

  // Đo độ dài từng câu rồi xếp lịch lại để giọng không chồng nhau (xem
  // scheduleLines). Tiếng có thể trễ nhẹ so với cảnh trong đoạn thoại
  // dày, nhưng không bao giờ 2 giọng nói cùng lúc.
  for (let i = 0; i < lines.length; i++) lines[i].dur = await ffprobeDuration(lines[i].pitched);
  const sched = scheduleLines(lines);
  console.log(`Đã xếp lịch giọng: ${lines.length} câu, trễ tối đa ${sched.maxLag.toFixed(2)}s so với mốc caption.`);

  // Ráp đường tiếng thành 2 bus riêng (lời dẫn + lời thoại), rồi DUCKING:
  // bus thoại đi qua sidechaincompress với sidechain là bus lời dẫn —
  // khi lời dẫn vang lên, thoại tự hạ nhỏ; lời dẫn hết thì thoại tự to
  // lại. (Chỉ có 1 bus thì bỏ qua bước ducking, dùng thẳng bus đó.)
  const videoDur = await ffprobeDuration(VIDEO_IN);
  console.log(`Video dài ${videoDur.toFixed(1)}s.`);
  const outDur = Math.max(videoDur, sched.audioEnd);
  const nar = lines.filter((l) => l.kind === 'say');
  const dlg = lines.filter((l) => l.kind !== 'say');
  console.log(`Lời dẫn: ${nar.length} câu, lời thoại: ${dlg.length} câu — thoại duck dưới lời dẫn, nhạc duck dưới giọng.`);
  const filterParts = [];
  const inputs = [];
  let inIdx = 0;
  const bus = (group, tag) => {
    if (!group.length) return null;
    const tags = [];
    for (const l of group) {
      inputs.push('-i', l.pitched);
      const idx = inIdx++;
      filterParts.push(`[${idx}:a]adelay=${Math.round(l.start * 1000)}:all=1[${tag}${idx}]`);
      tags.push(`[${tag}${idx}]`);
    }
    if (tags.length === 1) filterParts.push(`${tags[0]}apad[${tag}mix]`);
    else filterParts.push(`${tags.join('')}amix=inputs=${tags.length}:normalize=0:duration=longest,apad[${tag}mix]`);
    return `[${tag}mix]`;
  };
  const narMix = bus(nar, 'n');
  const dlgMix = bus(dlg, 'd');
  let voiceTag;
  if (narMix && dlgMix) {
    filterParts.push(`${dlgMix}${narMix}sidechaincompress=threshold=0.05:ratio=6:attack=20:release=400[dd]`);
    filterParts.push(`[nmix][dd]amix=inputs=2:normalize=0:duration=longest,apad[aout]`);
    voiceTag = '[aout]';
  } else {
    voiceTag = narMix || dlgMix;
  }
  const filter = filterParts.join(';');
  const voiceTrack = path.join(WORK_DIR, 'voice_track.wav');
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', voiceTag, '-t', String(outDur), voiceTrack]);

  // Nếu tiếng kéo dài quá video (đoạn thoại cuối bị xếp trễ dồn lại) thì
  // kéo dài video bằng khung hình cuối (tpad) thay vì cắt mất câu cuối.
  // Làm thành 1 bước riêng để khỏi xung đột filter với bước mux bên dưới.
  let videoInEff = VIDEO_IN;
  let padded = false;
  if (outDur > videoDur + 0.05) {
    const pad = outDur - videoDur;
    videoInEff = path.join(WORK_DIR, 'video_padded.mp4');
    console.log(`Tiếng dài hơn video ${pad.toFixed(1)}s — kéo dài video bằng khung cuối (tpad) để không cắt câu cuối.`);
    await run('ffmpeg', ['-y', '-v', 'error', '-i', VIDEO_IN, '-vf', `tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', videoInEff]);
    padded = true;
  }

  // Mux vào video (giữ nguyên hình, thêm tiếng; có nhạc nền thì trộn nhỏ bên dưới).
  // Nhạc nền lặp vô hạn (-stream_loop -1) nhưng amix duration=first cắt
  // đúng độ dài đường giọng (= độ dài video), nên nhạc kéo dài tới hết
  // kịch bản rồi dừng cùng video. normalize=0 để giọng giữ nguyên mức,
  // nhạc ở đúng mức volume đã đặt (không bị amix chia đôi đường tiếng).
  // Nhạc cũng DUCK dưới giọng (sidechaincompress, sidechain là giọng):
  // có người nói thì nhạc tự nhỏ lại, hết nói thì nhạc tự to lại.
  const muxArgs = ['-y', '-v', 'error', '-i', videoInEff, '-i', voiceTrack];
  let muxFilter = null;
  if (MUSIC) {
    muxArgs.push('-stream_loop', '-1', '-i', MUSIC);
    muxFilter = `[1:a]volume=1.0[v];[2:a]volume=${MUSIC_VOL},apad[m];[m][v]sidechaincompress=threshold=0.05:ratio=4:attack=20:release=500[md];[v][md]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[a]`;
    muxArgs.push('-filter_complex', muxFilter, '-map', '0:v', '-map', '[a]');
  } else {
    muxArgs.push('-map', '0:v', '-map', '1:a');
  }
  muxArgs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', VIDEO_OUT);
  await run('ffmpeg', muxArgs);

  const planOut = {
    videoSeconds: videoDur,
    audioSeconds: sched.audioEnd,
    outSeconds: outDur,
    maxLagSeconds: sched.maxLag,
    videoPadded: padded,
    ducking: { dialogueUnderNarration: !!(narMix && dlgMix), musicUnderVoice: !!MUSIC },
    voiceId: VOICE_ID, model: MODEL_ID,
    lines: lines.map((l, i) => ({ i: i + 1, kind: l.kind, time: l.time, start: l.start, dur: l.dur, lag: l.lag, speaker: l.speaker, pitch: l.pitch, key: l.keyMasked, chars: l.chars }))
  };
  fs.writeFileSync(path.join(WORK_DIR, 'voice_plan.json'), JSON.stringify(planOut, null, 2), 'utf-8');
  // Meta cho bước đăng YouTube sau này: tiêu đề + mô tả + tags + chapter
  // + hook lấy từ kịch bản. Trường video_title/video_description được ưu
  // tiên để không đụng với name/description mà game đang dùng hiển thị
  // trong danh sách kịch bản. Tags là tùy chọn: kịch bản có thể mang
  // video_tags (mảng chuỗi, mỗi tag tối đa 30 ký tự); không có thì để
  // mảng rỗng, bước đăng sẽ không gắn tag. Chapter: các câu mang trường
  // chapter sẽ thành mốc thời gian trong mô tả (bước đăng tự chèn khối
  // Timestamps, chỉ khi có từ 3 mốc trở lên và cách nhau tối thiểu 10
  // giây). Hook: cửa sổ vài giây đoạn hay để đặt sau intro (xem
  // hookWindow); bước cắt hook và bước ghép sẽ dùng nó, rồi cộng độ dài
  // hook vào chapters.
  const hook = hookWindow(lines, outDur);
  if (hook) console.log(`Hook: câu "${String(hook.text).slice(0, 80)}" từ ${hook.start.toFixed(2)}s đến ${hook.end.toFixed(2)}s (${hook.auto ? 'máy tự chọn' : 'đã đánh dấu'}).`);
  else console.log('Hook: không có đoạn hay (muốn có thì gắn "hook": true vào 1 câu thoại).');
  const uploadMeta = {
    video: path.basename(VIDEO_OUT),
    script: SCRIPT_NAME || path.basename(SCRIPT_PATH),
    title: script.video_title || script.name || '',
    description: script.video_description || script.description || '',
    tags: Array.isArray(script.video_tags) ? script.video_tags : [],
    chapters: lines.filter((l) => l.chapter && typeof l.time === 'number')
      .map((l) => ({ t: l.time, title: l.chapter })),
    hook: hook ? { start: hook.start, end: hook.end, text: hook.text, auto: hook.auto } : null
  };
  if (uploadMeta.chapters.length) console.log(`Chương: ${uploadMeta.chapters.length} mốc phân cảnh (${uploadMeta.chapters.map((c) => c.title).join(' | ')}).`);
  fs.writeFileSync(META_OUT, JSON.stringify(uploadMeta, null, 2), 'utf-8');
  console.log('XONG. Video có tiếng:', VIDEO_OUT);
  console.log('Bảng phân công chi tiết:', path.join(WORK_DIR, 'voice_plan.json'));
  console.log('Meta đăng YouTube sau này:', META_OUT, uploadMeta.title ? `— tiêu đề: "${String(uploadMeta.title).slice(0, 80)}"` : '(kịch bản chưa có video_title)');
}

if (require.main === module) main().catch((e) => { console.error('VOICE THẤT BẠI:', e && e.stack || e); process.exit(1); });
module.exports = { extractLines, matchCaptions, hookWindow, scheduleLines, fallbackPitch };
