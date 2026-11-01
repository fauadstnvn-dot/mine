"""Dang video len YouTube, lay token tu MySQL (cot token_mine).

Logic giong ban publish.py cua du an tour-main, chi khac:
  - Cot token la token_mine (khong phai token_arena).
  - Khong dung DeepSeek SEO, khong lich su tieu de qua FTP:
    tieu de / mo ta / tags / chapter lay thang tu upload_meta.json do
    voice.js ghi (tieu de = video_title || name, mo ta = video_description
    || description, tags = video_tags neu kich ban co, chapter = cac cau
    mang truong chapter trong kich ban, thoi gian lay tu caption cua
    chinh cau do). Mo ta duoc chen them khoi "Timestamps:" truoc dong
    hashtag cuoi (chi khi co tu 3 moc tro len, cach nhau toi thieu 10
    giay) theo dung logic build_chapters/add_chapters cua tour-main.
  - Khong xoa file video sau khi dang (video van nam trong Artifacts).
  - Sau khi dang thanh cong, sidecar <video>.youtube.json duoc cap nhat
    them video_id, link va client_id cua tai khoan da dang — de buoc dang
    thumbnail va buoc dang Short sau do dung DUNG tai khoan do (Short
    phai cung kenh voi video chinh; thumbnail chi dat duoc tren video
    cua chinh tai khoan do).
  - Dang thumbnail tuy chinh: --set-thumbnail --sidecar <video>.youtube.json
    --image thumb.jpg (khong tang num, vi khong phai dang video). YouTube
    chi cho dat thumbnail tuy chinh khi kenh da xac minh so dien thoai:
    kenh chua xac minh se bi 403 — truong hop nay script thoat loi (de
    workflow giu lai file thumb.jpg trong Artifacts cho viec dat tay sau
    khi xac minh) chu khong co gang tai khoan khac.

Bang tb_bao_secret, moi dong la 1 tai khoan YouTube:
  client_id, client_secret, token_mine (JSON: access_token, refresh_token,
  expires_in, saved_at, scope), num (so video da dang, toi da 9 roi tu reset).

Secret DB giong het secret FTP (host/user/pass dung chung, nhu cach
publish.py cua tour dung DB_HOST/DB_USER/DB_PASS cho ca MySQL lan FTP):
  DB_HOST = secrets.FTP_HOST, DB_USER = secrets.FTP_USERNAME,
  DB_PASS = secrets.FTP_PASSWORD, DB_NAME rieng (input -> vars -> secrets),
  DB_PORT mac dinh 3306.

Chay:
  python upload_youtube.py --video <ten>.mp4 --meta upload_meta.json
  Tuy chon: --privacy public|unlisted|private (mac dinh public),
    --category 20 (= Gaming), --made-for-kids, --publish-at HH:MM (gio UTC,
    video se len private truoc roi tu public vao gio do),
    --pin-account <client_id> (chi dang bang tai khoan nay, dung cho Short
    de cung kenh voi video chinh; neu tai khoan nay da du 9 luot thi tu
    reset num=0 thay vi doi sang kenh khac),
    --set-thumbnail --sidecar <video>.youtube.json --image thumb.jpg,
    --comment main|short --sidecar <video>.youtube.json --meta upload_meta.json
    (dang 1 binh luan keu goi tuong tac duoi video vua dang, dung cung
    tai khoan voi video do; can scope youtube.force-ssl — loi thi thoat
    1 de workflow bo qua, video van giu nguyen. Luu y: YouTube Data API
    khong co chuc nang ghim (pin) binh luan, muon ghim thi ghim tay trong
    YouTube Studio),
    --dry-run (chi in tieu de/tags, khong dung DB, khong dang).

Token khong bao gio in ra log. Log chi in 12 ky tu dau cua client_id
(de nhan biet tai khoan) va link video sau khi dang xong.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import re
import sys
import time
from pathlib import Path

import pymysql
import requests

TABLE = "tb_bao_secret"
TOKEN_COLUMN = "token_mine"
MAX_NUM = 9
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status"
THUMB_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"
COMMENT_URL = "https://www.googleapis.com/youtube/v3/commentThreads"
HAS_TOKEN = f"{TOKEN_COLUMN} IS NOT NULL AND TRIM({TOKEN_COLUMN}) <> ''"


class AccountError(Exception):
    """Problem with this account only (bad token, quota): try the next one."""


def connect():
    return pymysql.connect(
        host=os.environ["DB_HOST"], port=int(os.environ.get("DB_PORT") or 3306),
        user=os.environ["DB_USER"], password=os.environ["DB_PASS"], database=os.environ["DB_NAME"],
        charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=30, read_timeout=60, write_timeout=60, autocommit=True,
    )


def run_db(work, attempts: int = 5):
    """Fresh connection per operation (uploads take minutes; the host drops idle connections)."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        db = None
        try:
            db = connect()
            return work(db)
        except pymysql.err.Error as exc:
            last = exc
            print(f"  ! MySQL error ({exc}), retry {attempt}/{attempts}")
            time.sleep(min(5 * attempt, 20))
        finally:
            if db is not None:
                try:
                    db.close()
                except Exception:
                    pass
    raise RuntimeError(f"MySQL unreachable after {attempts} tries: {last}")


def check_db_env() -> None:
    """Bao loi ro rang neu thieu thong tin DB, thay vi KeyError kho hieu."""
    missing = [v for v in ("DB_HOST", "DB_USER", "DB_PASS", "DB_NAME") if not os.environ.get(v)]
    if missing:
        sys.exit(
            "Thieu thong tin database: " + ", ".join(missing) + ". "
            "DB_HOST/DB_USER/DB_PASS lay tu secret FTP (FTP_HOST/FTP_USERNAME/FTP_PASSWORD), "
            "DB_NAME dien vao o db_name luc chay hoac them vao Secrets/Variables (DB_NAME)."
        )


def candidates() -> list[dict]:
    sql = (f"SELECT client_id, client_secret, {TOKEN_COLUMN} AS token, COALESCE(num, 0) AS num "
           f"FROM {TABLE} WHERE {HAS_TOKEN} AND COALESCE(num, 0) < %s ORDER BY RAND()")

    def work(db):
        with db.cursor() as cur:
            cur.execute(sql, (MAX_NUM,))
            rows = cur.fetchall()
            if rows:
                return rows
            cur.execute(f"UPDATE {TABLE} SET num = 0 WHERE {HAS_TOKEN}")
            print(f"  All accounts used (num >= {MAX_NUM}) -> reset num=0 for {cur.rowcount} rows")
            cur.execute(sql, (MAX_NUM,))
            return cur.fetchall()

    return run_db(work)


def valid_access_token(row: dict) -> str:
    try:
        tokens = json.loads(row["token"])
    except (TypeError, ValueError) as exc:
        raise AccountError(f"{TOKEN_COLUMN} is not valid JSON") from exc
    expires_at = tokens.get("saved_at", 0) + tokens.get("expires_in", 3600) - 300
    if tokens.get("access_token") and time.time() < expires_at:
        return tokens["access_token"]
    if not tokens.get("refresh_token"):
        raise AccountError("missing refresh_token")
    r = requests.post(TOKEN_URL, data={
        "client_id": row["client_id"], "client_secret": row["client_secret"],
        "refresh_token": tokens["refresh_token"], "grant_type": "refresh_token",
    }, timeout=60)
    if r.status_code != 200:
        raise AccountError(f"token refresh failed ({r.status_code}): {r.text[:200]}")
    new = r.json()
    new.setdefault("refresh_token", tokens["refresh_token"])
    new.setdefault("scope", tokens.get("scope"))
    new["saved_at"] = int(time.time())

    def save(db):
        with db.cursor() as cur:
            cur.execute(f"UPDATE {TABLE} SET {TOKEN_COLUMN} = %s WHERE client_id = %s",
                        (json.dumps(new), row["client_id"]))

    run_db(save)
    return new["access_token"]


def increment_num(client_id: str) -> None:
    def work(db):
        with db.cursor() as cur:
            cur.execute(f"UPDATE {TABLE} SET num = COALESCE(num, 0) + 1 WHERE client_id = %s", (client_id,))

    run_db(work)


def pinned_candidate(client_id: str) -> dict:
    """Lay dung 1 tai khoan theo client_id (de Short cung kenh voi video
    chinh, thumbnail dung tai khoan chu video). Khong loc num<9: neu tai
    khoan nay da du 9 luot thi reset num=0 cho rieng no thay vi doi sang
    kenh khac (doi kenh la sai muc dich cua viec pin)."""

    def work(db):
        with db.cursor() as cur:
            cur.execute(f"SELECT client_id, client_secret, {TOKEN_COLUMN} AS token, COALESCE(num, 0) AS num "
                        f"FROM {TABLE} WHERE client_id = %s", (client_id,))
            row = cur.fetchone()
            if not row:
                return None
            if row["num"] >= MAX_NUM:
                cur.execute(f"UPDATE {TABLE} SET num = 0 WHERE client_id = %s", (client_id,))
                row["num"] = 0
                print(f"  Pinned account num >= {MAX_NUM} -> reset num=0 to keep the same channel")
            return row

    row = run_db(work)
    if not row:
        raise RuntimeError(f"pinned account not found: {client_id}")
    return row


def set_thumbnail(access_token: str, video_id: str, image_path: Path) -> None:
    """Dat thumbnail tuy chinh cho 1 video (thumbnails.set, upload media
    truc tiep). Khong tang num. Loi 403 thuong la kenh chua xac minh so
    dien thoai — YouTube chi cho dat thumbnail tuy chinh khi da xac minh."""
    mime = "image/jpeg" if image_path.suffix.lower() in (".jpg", ".jpeg") else "image/png"
    data = image_path.read_bytes()
    if len(data) >= 2 * 1024 * 1024:
        raise AccountError("thumbnail file >= 2MB (YouTube limit)")
    r = requests.post(THUMB_URL, params={"videoId": video_id, "uploadType": "media"},
                      headers={"Authorization": f"Bearer {access_token}", "Content-Type": mime},
                      data=data, timeout=120)
    if r.status_code != 200:
        raise AccountError(f"thumbnails.set failed ({r.status_code}): {r.text[:300]}")


def build_comment(kind: str, meta: dict) -> str:
    """Binh luan keu goi tuong tac cho video chinh ('main') hoac Short
    ('short'). Dung cau hook cua tap lam cau mo neu co (cat ngan gon),
    roi them cau hoi + CTA like/subscribe. Binh luan dang duoi ten kenh
    (tai khoan vua dang video) nen hien noi bat ngay duoi video."""
    hook = ""
    h = meta.get("hook") or {}
    if isinstance(h, dict) and h.get("text"):
        hook = " ".join(str(h["text"]).split())
        if len(hook) > 150:
            hook = hook[:150].rsplit(" ", 1)[0].rstrip() + "..."
    cta = "LIKE 👍 and SUBSCRIBE 🔔 for more Blocky Tales!"
    if kind == "short":
        if hook:
            return f"“{hook}” 😂 What would YOU do? Comment below! 👇 {cta}"
        return f"😂 What was your favorite part? Comment below! 👇 {cta}"
    if hook:
        return (f"“{hook}”\n\nWhat was YOUR favorite moment in this adventure? "
                f"Tell us below! 👇\n\nIf you laughed, {cta}")
    return (f"What was YOUR favorite moment in this adventure? Tell us below! 👇\n\n"
            f"If you laughed, {cta}")


def post_comment(access_token: str, video_id: str, text: str) -> str:
    """Dang 1 binh luan moi (commentThreads.insert) len video cua chinh kenh do.
    Can scope youtube.force-ssl trong token. Tra ve comment id. Loi 403
    thuong la thieu scope, video 'made for kids' hoac video tat binh luan."""
    r = requests.post(COMMENT_URL, params={"part": "snippet"},
                      headers={"Authorization": f"Bearer {access_token}",
                               "Content-Type": "application/json"},
                      json={"snippet": {"videoId": video_id,
                                        "topLevelComment": {"snippet": {"textOriginal": text}}}},
                      timeout=60)
    if r.status_code != 200:
        raise AccountError(f"commentThreads.insert HTTP {r.status_code}: {r.text[:300]}")
    return r.json().get("id", "")


def sanitize(info: dict, with_tags: bool = True) -> dict:
    def strip(text: str) -> str:
        return re.sub(r"[<>\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(text or "")).replace("\r", "")

    title = " ".join(strip(info.get("title")).split())
    if len(title) > 100:
        title = title[:100].rsplit(" ", 1)[0]
    desc = strip(info.get("description"))
    while len(desc.encode("utf-8")) > 4900:
        desc = desc[:-100]
    tags, seen, total = [], set(), 0
    if with_tags:
        for t in info.get("tags") or []:
            t = re.sub(r"[<>\",#]", "", str(t)).strip()
            if not t or len(t) > 30 or t.lower() in seen or total + len(t) + 3 > 450:
                continue
            seen.add(t.lower())
            tags.append(t)
            total += len(t) + 3
    return {"title": title or "Blocky Tales", "description": desc.strip(), "tags": tags}


def _stamp(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def build_chapters(chapters: list, budget: int) -> str:
    """YouTube chapter lines: starts at 0:00, at least 3, each at least 10 s apart, ascending, within `budget` chars."""
    items = sorted(((float(c.get("t", 0)), re.sub(r"[<>\n]", " ", str(c.get("title", ""))).strip()) for c in chapters or []),
                   key=lambda x: x[0])
    kept: list[tuple[float, str]] = []
    for t, title in items:
        if not title:
            continue
        if kept and t - kept[-1][0] < 10:
            if len(kept) == 1:  # too close to the 0:00 chapter: merge the names
                kept[0] = (0.0, f"{kept[0][1]} + {title}"[:90])
            continue
        kept.append((t, title[:90]))
    if kept and kept[0][0] > 0:
        kept[0] = (0.0, kept[0][1])
    if len(kept) < 3:
        return ""
    # Drop middle entries evenly if the list does not fit the description budget.
    # (Khu vuc nay KHAC tour-main mot chut: cong thuc goc cua tour
    # "step = len // (len // 12)" khong luoc duoc moc nao khi danh sach co
    # duoi 24 moc ma van vuot budget -> vong lap khong bao gio dung. Ban
    # nay luoc mot nua so moc giua moi vong, luon giam dan nen chac chan
    # dung, van giu moc dau va moc cuoi.)
    def render(lst):
        return "\n".join(f"{_stamp(t)} {title}" for t, title in lst)
    while len(render(kept)) > budget and len(kept) > 3:
        kept = [x for i, x in enumerate(kept) if i == 0 or i == len(kept) - 1 or i % 2 == 1]
    text = render(kept)
    return text if len(text) <= budget else ""


def add_chapters(description: str, chapters: list) -> str:
    """Insert the timestamps before the trailing hashtag line(s) of the description."""
    lines = description.rstrip().split("\n")
    tail: list[str] = []
    while lines and (not lines[-1].strip() or all(w.startswith("#") for w in lines[-1].split())):
        tail.insert(0, lines.pop())
    body = "\n".join(lines).rstrip()
    hashtags = "\n".join(tail).strip()
    budget = 4700 - len(body) - len(hashtags) - len("\n\nTimestamps:\n\n")
    block = build_chapters(chapters, budget)
    if not block:
        return description
    if not body:
        out = f"Timestamps:\n{block}"
    else:
        out = f"{body}\n\nTimestamps:\n{block}"
    return f"{out}\n\n{hashtags}" if hashtags else out


def next_publish_at(hhmm: str) -> str | None:
    """Next occurrence of HH:MM UTC as RFC3339, or None if empty/invalid.
    If today's slot is less than 20 minutes away (or already passed), the
    NEXT day's slot is used, so a video is never scheduled in the past or
    before it can finish processing (v1.16: previously this returned None,
    which uploaded immediately instead of waiting for the next slot)."""
    try:
        h, m = (int(x) for x in hhmm.strip().split(":"))
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    now = datetime.now(timezone.utc)
    target = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if target - now < timedelta(minutes=20):
        target += timedelta(days=1)
    return target.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def upload(access_token: str, mp4: Path, info: dict, privacy: str, category: str, kids: bool, publish_at: str | None = None) -> str:
    try:
        return _upload(access_token, mp4, sanitize(info), privacy, category, kids, publish_at)
    except requests.HTTPError as exc:
        if exc.response is None or exc.response.status_code != 400:
            raise
        print(f"  ! YouTube 400 ({exc.response.text[:300]}), retrying without tags/language")
        return _upload(access_token, mp4, sanitize(info, with_tags=False), privacy, category, kids, publish_at, minimal=True)


def _upload(access_token, mp4: Path, info, privacy, category, kids, publish_at=None, minimal=False) -> str:
    body = {"snippet": {"title": info["title"], "description": info["description"], "categoryId": str(category)},
            "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": kids}}
    if publish_at:
        body["status"]["privacyStatus"] = "private"
        body["status"]["publishAt"] = publish_at
    if info["tags"]:
        body["snippet"]["tags"] = info["tags"]
    if not minimal:
        body["snippet"]["defaultLanguage"] = "en"
        body["snippet"]["defaultAudioLanguage"] = "en"
    size = mp4.stat().st_size
    init = requests.post(UPLOAD_URL, json=body, timeout=60, headers={
        "Authorization": f"Bearer {access_token}", "X-Upload-Content-Type": "video/mp4",
        "X-Upload-Content-Length": str(size)})
    if init.status_code in (401, 403):
        raise AccountError(f"YouTube refused ({init.status_code}): {init.text[:300]}")
    if not init.ok:
        raise requests.HTTPError(f"{init.status_code}: {init.text[:500]}", response=init)
    location = init.headers["Location"]
    for attempt in range(3):
        with mp4.open("rb") as fh:
            r = requests.put(location, data=fh, timeout=3600,
                             headers={"Content-Type": "video/mp4", "Content-Length": str(size)})
        if r.status_code in (200, 201):
            return r.json()["id"]
        if r.status_code in (401, 403):
            raise AccountError(f"upload refused ({r.status_code}): {r.text[:300]}")
        print(f"  ! upload try {attempt + 1} failed {r.status_code}, retrying")
        time.sleep(10 * (attempt + 1))
    raise RuntimeError("Upload failed after 3 tries")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", default="")
    ap.add_argument("--meta", default="upload_meta.json")
    ap.add_argument("--privacy", default=os.environ.get("YT_PRIVACY", "public"),
                    choices=["public", "unlisted", "private"])
    ap.add_argument("--category", default="20", help="20 = Gaming")
    ap.add_argument("--made-for-kids", action="store_true")
    ap.add_argument("--publish-at", default="", help="Release time HH:MM UTC (video is uploaded private and goes public then)")
    ap.add_argument("--pin-account", default="", help="Only upload with this client_id (Short must share the main video's channel)")
    ap.add_argument("--set-thumbnail", action="store_true", help="Set a custom thumbnail instead of uploading a video")
    ap.add_argument("--comment", choices=["main", "short"], default="",
                    help="Post an engagement comment instead of uploading a video (needs --sidecar and --meta)")
    ap.add_argument("--sidecar", default="", help="Sidecar <video>.youtube.json holding video_id + client_id (for --set-thumbnail/--comment)")
    ap.add_argument("--image", default="", help="Thumbnail image file (for --set-thumbnail)")
    ap.add_argument("--dry-run", action="store_true", help="Only show metadata; no DB, no upload")
    args = ap.parse_args()

    if args.set_thumbnail:
        if not args.sidecar or not args.image:
            sys.exit("--set-thumbnail needs --sidecar and --image")
        sidecar = Path(args.sidecar)
        if not sidecar.exists():
            sys.exit(f"Sidecar not found: {sidecar}")
        side = json.loads(sidecar.read_text(encoding="utf-8"))
        video_id = side.get("video_id")
        client_id = side.get("client_id")
        if not video_id or not client_id:
            sys.exit("Sidecar has no video_id/client_id (main upload may have failed) — skipping thumbnail.")
        image = Path(args.image)
        if not image.exists():
            sys.exit(f"Thumbnail image not found: {image}")
        check_db_env()
        try:
            row = pinned_candidate(client_id)
            token = valid_access_token(row)
            set_thumbnail(token, video_id, image)
        except (AccountError, RuntimeError) as exc:
            print(f"Thumbnail upload failed: {exc}")
            print("  (Ghi chú) YouTube chỉ cho đặt thumbnail tùy chỉnh khi kênh đã xác minh số điện thoại.")
            print("  File thumb.jpg vẫn nằm trong Artifacts (debug) — xác minh xong thì đặt tay trong YouTube Studio.")
            sys.exit(1)
        print(f"Thumbnail set for https://youtu.be/{video_id}")
        return

    if args.comment:
        if not args.sidecar:
            sys.exit("--comment needs --sidecar")
        sidecar = Path(args.sidecar)
        if not sidecar.exists():
            sys.exit(f"Sidecar not found: {sidecar}")
        side = json.loads(sidecar.read_text(encoding="utf-8"))
        video_id = side.get("video_id")
        client_id = side.get("client_id")
        if not video_id or not client_id:
            sys.exit("Sidecar has no video_id/client_id (upload may have failed) — skipping comment.")
        meta = {}
        meta_path = Path(args.meta)
        if meta_path.exists():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        text = build_comment(args.comment, meta)
        print(f"Comment text:\n{text}")
        check_db_env()
        try:
            row = pinned_candidate(client_id)
            token = valid_access_token(row)
            cid = post_comment(token, video_id, text)
        except (AccountError, RuntimeError) as exc:
            print(f"Comment failed: {exc}")
            print("  (Ghi chú) Bình luận cần scope youtube.force-ssl trong token; video 'made for kids' hoặc tắt bình luận cũng bị 403 — video vẫn đã đăng xong, chỉ thiếu bình luận.")
            sys.exit(1)
        print(f"Comment posted ({cid}) on https://youtu.be/{video_id}")
        return

    if not args.video:
        sys.exit("--video is required (unless --set-thumbnail/--comment)")
    mp4 = Path(args.video)
    if not mp4.exists():
        sys.exit(f"Video not found: {mp4}")
    meta = {}
    meta_path = Path(args.meta)
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    info = {
        "title": (meta.get("title") or "").strip() or mp4.stem,
        "description": add_chapters(meta.get("description") or "", meta.get("chapters") or []),
        "tags": meta.get("tags") or [],
    }
    final = sanitize(info)
    print(f"Title: {final['title']}\nTags: {', '.join(final['tags'])}")
    if "Timestamps:" in final["description"]:
        n_ch = sum(1 for ln in final["description"].split("\n") if re.match(r"^\d+:\d\d ", ln))
        print(f"Chapters: {n_ch} moc phan canh trong mo ta.")
    mp4.with_suffix(".youtube.json").write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.dry_run:
        print("Dry run: khong dung DB, khong dang video.")
        return

    check_db_env()
    publish_at = next_publish_at(args.publish_at) if args.publish_at else None
    print(f"Release: {publish_at or 'immediately (' + args.privacy + ')'}")
    if args.pin_account:
        try:
            rows = [pinned_candidate(args.pin_account)]
        except RuntimeError as exc:
            sys.exit(str(exc))
    else:
        rows = candidates()
    for row in rows:
        print(f"Trying account client_id={row['client_id'][:12]}... (num={row['num']})")
        try:
            token = valid_access_token(row)
            video_id = upload(token, mp4, info, args.privacy, args.category, args.made_for_kids, publish_at)
        except AccountError as exc:
            if args.pin_account:
                sys.exit(f"Pinned account failed: {exc} (not falling back to another channel)")
            print(f"  ! skipping this account: {exc}")
            continue
        print(f"Uploaded: https://youtu.be/{video_id}")
        try:
            increment_num(row["client_id"])
            print("  num +1")
        except RuntimeError as exc:
            print(f"  ! Uploaded but num was not incremented: {exc}")
        # Cap nhat sidecar them video_id/link/client_id de buoc thumbnail
        # va buoc Short sau do dung dung tai khoan nay.
        try:
            side = json.loads(mp4.with_suffix(".youtube.json").read_text(encoding="utf-8"))
        except Exception:
            side = final
        side.update({"video_id": video_id, "link": f"https://youtu.be/{video_id}",
                     "client_id": row["client_id"]})
        mp4.with_suffix(".youtube.json").write_text(json.dumps(side, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  sidecar updated with video_id={video_id}")
        return
    sys.exit("No account could upload")


if __name__ == "__main__":
    main()
