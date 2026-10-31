// pick_music.js — Lấy nhạc nền ngẫu nhiên từ host qua FTP.
//
// Luồng:
//   Nối FTP, liệt kê thư mục MUSIC_DIR (mặc định nhac_nen, nằm cùng cấp
//   với play.php trên host), lọc file .mp3, chọn NGẪU NHIÊN 1 file, tải
//   về máy chạy workflow, ghi picked_music_meta.json {file, dir} để
//   bước sau biết đã bốc bản nào (và để debug).
//
//   KHÁC với kịch bản: file nhạc KHÔNG bị chuyển đi sau khi dùng — nhạc
//   nền dùng lại nhiều lần, lần chạy sau vẫn có thể bốc trúng lại. Vì
//   vậy file này KHÔNG có bước --move như pick_script.js.
//
// Biến môi trường (đi từ GitHub Secrets, KHÔNG ghi mật khẩu vào code/log):
//   FTP_HOST, FTP_USERNAME, FTP_PASSWORD (bắt buộc, dùng chung với
//   pick_script.js)
//   FTP_PORT    (mặc định 21)
//   FTP_SECURE  (mặc định false; đặt true nếu host yêu cầu FTPS)
//   MUSIC_DIR   (mặc định nhac_nen — đường dẫn FTP tới thư mục nhạc,
//                tính từ thư mục gốc khi đăng nhập FTP, vd nếu host chứa
//                web ở public_html/mine thì ghi public_html/mine/nhac_nen)
//
// Cách dùng:
//   node pick_music.js --out picked_music.mp3 --meta picked_music_meta.json
//   node pick_music.js --out picked_music.mp3 --meta picked_music_meta.json --file nhac1.mp3
//     (chỉ định đúng 1 bản nhạc, vd chạy thử 1 bản cụ thể thay vì bốc ngẫu nhiên)
//
//   Bước này chạy TRƯỚC khi render: nếu thư mục trống hoặc đường dẫn FTP
//   sai thì job dừng ngay từ đầu (chưa tốn công render), báo rõ để sửa.

const { Client } = require('basic-ftp');
const fs = require('fs');
const { pickRandomIndex, findFile } = require('./pick_script.js');

const FTP_HOST = process.env.FTP_HOST;
const FTP_USERNAME = process.env.FTP_USERNAME;
const FTP_PASSWORD = process.env.FTP_PASSWORD;
const FTP_PORT = parseInt(process.env.FTP_PORT || '21', 10);
const FTP_SECURE = String(process.env.FTP_SECURE || 'false').toLowerCase() === 'true';
const MUSIC_DIR = (process.env.MUSIC_DIR || 'nhac_nen').replace(/\/$/, '');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Chỉ lấy file .mp3 (thư mục con, file .wav/.flac, file rác... đều bỏ qua).
// Chấp nhận cả .MP3 viết hoa.
function filterMp3Files(list) {
  return list.filter((f) => {
    const isFile = f.type === undefined || f.type === 1;
    return isFile && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.mp3');
  });
}

async function connect() {
  if (!FTP_HOST || !FTP_USERNAME || !FTP_PASSWORD) {
    throw new Error('Thiếu FTP_HOST / FTP_USERNAME / FTP_PASSWORD. Anh thêm 3 secret này vào repo GitHub trước khi chạy.');
  }
  const client = new Client();
  client.ftp.verbose = false;
  await client.access({ host: FTP_HOST, user: FTP_USERNAME, password: FTP_PASSWORD, port: FTP_PORT, secure: FTP_SECURE });
  return client;
}

async function pick(outPath, metaPath, onlyFile) {
  const client = await connect();
  try {
    const list = await client.list(MUSIC_DIR);
    const files = filterMp3Files(list);
    console.log(`Thư mục ${MUSIC_DIR}: ${files.length} file nhạc .mp3`);
    if (!files.length) {
      throw new Error(`Thư mục ${MUSIC_DIR} không có file nhạc .mp3 nào (thư mục trống hoặc đường dẫn FTP sai).`);
    }
    let chosen;
    if (onlyFile) {
      chosen = findFile(files, onlyFile);
      if (!chosen) throw new Error(`Không thấy file "${onlyFile}" trong thư mục ${MUSIC_DIR}. Kiểm tra lại tên file.`);
      console.log('Chỉ định sẵn bản nhạc:', chosen.name);
    } else {
      files.forEach((f) => console.log('  - ' + f.name));
      chosen = files[pickRandomIndex(files.length)];
      console.log('Bốc ngẫu nhiên được:', chosen.name);
    }
    await client.downloadTo(outPath, MUSIC_DIR + '/' + chosen.name);
    fs.writeFileSync(metaPath, JSON.stringify({ file: chosen.name, dir: MUSIC_DIR, pickedAt: new Date().toISOString() }, null, 2), 'utf-8');
    console.log('Đã tải về:', outPath);
    console.log('Thông tin bản nhạc đã bốc:', metaPath);
    console.log('Lưu ý: file nhạc KHÔNG bị chuyển đi sau khi dùng, lần sau vẫn bốc lại được.');
  } finally {
    client.close();
  }
}

async function main() {
  await pick(arg('out', './picked_music.mp3'), arg('meta', './picked_music_meta.json'), arg('file', ''));
}

if (require.main === module) {
  main().catch((e) => { console.error('PICK NHẠC THẤT BẠI:', e && e.stack || e); process.exit(1); });
}

module.exports = { filterMp3Files };
