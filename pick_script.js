// pick_script.js — Lấy kịch bản ngẫu nhiên từ host qua FTP, và chuyển nó đi
// sau khi video đã làm xong.
//
// Luồng:
//   1. Lấy (pick): nối FTP, liệt kê thư mục KB_DIR (workflow truyền từ secret PROJECT_DIR; chạy tay thì mặc định kb_github),
//      lọc file .json, chọn NGẪU NHIÊN 1 file, tải về máy chạy workflow,
//      ghi picked_meta.json {file, dir, expDir} để bước sau biết file nào.
//   2. Chuyển (move, chỉ chạy khi video đã xong và đã đăng artifact):
//      đổi tên file đó từ KB_DIR sang KB_EXP_DIR (workflow truyền từ secret PROJECT_DIR; chạy tay thì mặc định kb_github_exp)
//      bằng lệnh rename của FTP. Như vậy mỗi kịch bản chỉ làm video 1 lần.
//      Nếu bước này lỗi thì job báo lỗi để anh biết mà xử lý tay, tránh
//      lần chạy sau lại bốc trúng đúng file đó.
//
// Biến môi trường (đi từ GitHub Secrets, KHÔNG ghi mật khẩu vào code/log):
//   FTP_HOST, FTP_USERNAME, FTP_PASSWORD (bắt buộc)
//   FTP_PORT    (mặc định 21)
//   FTP_SECURE  (mặc định false; đặt true nếu host yêu cầu FTPS)
//   KB_DIR      (đường dẫn FTP tới thư mục kịch bản; workflow truyền từ secret PROJECT_DIR, chạy tay thì mặc định kb_github)
//   KB_EXP_DIR  (cùng quy tắc như trên; chạy tay thì mặc định kb_github_exp)
//
// Cách dùng:
//   node pick_script.js --out picked_script.json --meta picked_meta.json
//   node pick_script.js --out picked_script.json --meta picked_meta.json --file vid1.json
//     (chỉ định đúng 1 kịch bản, vd chạy lại file bị lỗi lần trước thay vì bốc ngẫu nhiên)
//   node pick_script.js --move --meta picked_meta.json

const { Client } = require('basic-ftp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FTP_HOST = process.env.FTP_HOST;
const FTP_USERNAME = process.env.FTP_USERNAME;
const FTP_PASSWORD = process.env.FTP_PASSWORD;
const FTP_PORT = parseInt(process.env.FTP_PORT || '21', 10);
const FTP_SECURE = String(process.env.FTP_SECURE || 'false').toLowerCase() === 'true';
const KB_DIR = (process.env.KB_DIR || 'kb_github').replace(/\/$/, '');
const KB_EXP_DIR = (process.env.KB_EXP_DIR || 'kb_github_exp').replace(/\/$/, '');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

// Chỉ lấy file .json (thư mục con, file rác, .DS_Store... đều bỏ qua).
function filterJsonFiles(list) {
  return list.filter((f) => {
    const isFile = f.type === undefined || f.type === 1;
    return isFile && typeof f.name === 'string' && f.name.toLowerCase().endsWith('.json');
  });
}

// Chọn ngẫu nhiên đều nhau bằng crypto (không dùng Math.random cho chắc).
function pickRandomIndex(n) {
  if (n <= 0) throw new Error('Không có file nào để chọn.');
  return crypto.randomInt(n);
}

// Đường dẫn tương đối từ thư mục đích về thư mục nguồn, để lệnh rename
// chạy được dù 2 thư mục nằm sâu bao nhiêu (vd kb_github -> kb_github_exp
// cùng cấp thì ra ../kb_github).
function relativeRenameSrc(fromDir, toDir, file) {
  const rel = path.posix.relative(toDir, fromDir);
  if (!rel || rel === '.') throw new Error('Thư mục nguồn và đích trùng nhau, không chuyển được.');
  return rel + '/' + file;
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

// Tìm đúng tên file trong danh sách (để chạy lại 1 kịch bản cụ thể).
function findFile(files, name) {
  return files.find((f) => f.name === name) || null;
}

async function pick(outPath, metaPath, onlyFile) {
  const client = await connect();
  try {
    const list = await client.list(KB_DIR);
    const files = filterJsonFiles(list);
    console.log(`Thư mục ${KB_DIR}: ${files.length} kịch bản .json`);
    if (!files.length) {
      throw new Error(`Thư mục ${KB_DIR} không còn kịch bản .json nào (đã làm hết hoặc đường dẫn FTP sai).`);
    }
    let chosen;
    if (onlyFile) {
      chosen = findFile(files, onlyFile);
      if (!chosen) throw new Error(`Không thấy file "${onlyFile}" trong thư mục ${KB_DIR}. Kiểm tra lại tên file.`);
      console.log('Chỉ định sẵn kịch bản:', chosen.name);
    } else {
      files.forEach((f) => console.log('  - ' + f.name));
      chosen = files[pickRandomIndex(files.length)];
      console.log('Bốc ngẫu nhiên được:', chosen.name);
    }
    await client.downloadTo(outPath, KB_DIR + '/' + chosen.name);
    fs.writeFileSync(metaPath, JSON.stringify({ file: chosen.name, dir: KB_DIR, expDir: KB_EXP_DIR, pickedAt: new Date().toISOString() }, null, 2), 'utf-8');
    console.log('Đã tải về:', outPath);
    console.log('Thông tin file đã bốc:', metaPath);
  } finally {
    client.close();
  }
}

async function move(metaPath) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  const client = await connect();
  try {
    await client.ensureDir(meta.expDir);
    const src = relativeRenameSrc(meta.dir, meta.expDir, meta.file);
    console.log(`Chuyển ${meta.dir}/${meta.file} -> ${meta.expDir}/${meta.file}`);
    await client.rename(src, meta.file);
    console.log('Đã chuyển xong. Kịch bản này sẽ không bị bốc lại nữa.');
  } finally {
    client.close();
  }
}

async function main() {
  if (process.argv.includes('--move')) {
    await move(arg('meta', './picked_meta.json'));
  } else {
    await pick(arg('out', './picked_script.json'), arg('meta', './picked_meta.json'), arg('file', ''));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('PICK/MOVE THẤT BẠI:', e && e.stack || e); process.exit(1); });
}

module.exports = { filterJsonFiles, pickRandomIndex, relativeRenameSrc, findFile };
