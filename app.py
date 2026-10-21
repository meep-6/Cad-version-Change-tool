#!/usr/bin/env python3
"""CAD Change Log - local app.

Run:  python app.py            (Python 3.8+, standard library only)
      python app.py --data D:/CAD/log --port 8800 --no-browser

Everything is stored in the data folder (default: ./data next to this file):
  data/log.json        parts, revisions, issues, PCB boards and Fusion captures (pretty JSON)
  data/log.json.bak    the previous save
  data/backups/        a snapshot of log.json from each launch (last 20 kept)
  data/images/         screenshots attached to revisions
  data/files/          attached files (STEP, F3D, STL, test data...)
The server only listens on 127.0.0.1, so it is reachable from this computer only.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
COLLS = ("parts", "revisions", "ncrs", "captures", "boards")
LOCK_EDITABLE = {"tests", "fai", "orders", "bringup", "bomCosts", "updatedAt"}  # still editable once released
IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
           "image/webp": ".webp", "image/bmp": ".bmp"}
IMG_TYPES = {v: k for k, v in IMG_EXT.items()}
MAX_IMG = 25 * 1024 * 1024
MAX_FILE = 500 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
KEEP_BACKUPS = 20
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMG_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|gif|webp|bmp)$")
FILE_RE = re.compile(r"^[a-f0-9]{32}(\.[a-z0-9]{1,10})?$")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/report.html": ("report.html", "text/html; charset=utf-8"),
    "/static/app.js": ("static/app.js", "text/javascript; charset=utf-8"),
    "/static/app.css": ("static/app.css", "text/css; charset=utf-8"),
    "/static/pcb.js": ("static/pcb.js", "text/javascript; charset=utf-8"),
}
PORT_FILE = os.path.join(os.path.expanduser("~"), ".cad-change-log.json")


def empty():
    return {k: {} for k in COLLS}


class Store:
    def __init__(self, root):
        self.root = root
        self.img_dir = os.path.join(root, "images")
        self.file_dir = os.path.join(root, "files")
        self.backup_dir = os.path.join(root, "backups")
        for d in (self.img_dir, self.file_dir, self.backup_dir):
            os.makedirs(d, exist_ok=True)
        self.path = os.path.join(root, "log.json")
        self.lock = threading.Lock()
        self.warning = None
        self.data = self._load()
        self._backup()

    # ---- load / backup ----
    def _read(self, p):
        with open(p, encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("top level is not an object")
        return {k: {d["id"]: d for d in raw.get(k, []) if isinstance(d, dict) and "id" in d} for k in COLLS}

    def _load(self):
        if not os.path.exists(self.path):
            return empty()
        try:
            return self._read(self.path)
        except Exception as e:  # damaged log: keep it aside, restore newest readable copy
            err = e
        stamp = time.strftime("%Y%m%d-%H%M%S")
        bad = self.path + ".corrupt-" + stamp
        shutil.move(self.path, bad)
        cands = [self.path + ".bak"] + [
            os.path.join(self.backup_dir, f)
            for f in sorted(os.listdir(self.backup_dir), reverse=True) if f.startswith("log-")]
        for c in cands:
            if not os.path.exists(c):
                continue
            try:
                d = self._read(c)
            except Exception:
                continue
            shutil.copyfile(c, self.path)
            self.warning = ("log.json couldn't be read (%s). Restored from %s. The damaged file was kept as %s."
                            % (err, os.path.basename(c), os.path.basename(bad)))
            return d
        self.warning = ("log.json couldn't be read (%s) and no backup could be restored. Started with an empty log. "
                        "The damaged file was kept as %s." % (err, os.path.basename(bad)))
        return empty()

    def _backup(self):
        if not os.path.exists(self.path):
            return
        shutil.copyfile(self.path, os.path.join(self.backup_dir, "log-%s.json" % time.strftime("%Y%m%d-%H%M%S")))
        olds = sorted(f for f in os.listdir(self.backup_dir) if f.startswith("log-") and f.endswith(".json"))
        for f in olds[:-KEEP_BACKUPS]:
            try:
                os.remove(os.path.join(self.backup_dir, f))
            except OSError:
                pass

    def backup_count(self):
        return len([f for f in os.listdir(self.backup_dir) if f.startswith("log-")])

    # ---- read / write ----
    def snapshot(self):
        with self.lock:
            return {k: sorted(self.data[k].values(), key=lambda d: d.get("createdAt", 0)) for k in COLLS}

    def _save(self):
        out = {k: sorted(self.data[k].values(), key=lambda d: d.get("createdAt", 0)) for k in COLLS}
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        if os.path.exists(self.path):
            shutil.copyfile(self.path, self.path + ".bak")
        os.replace(tmp, self.path)

    @staticmethod
    def _locked(coll, doc):
        return coll == "revisions" and doc is not None and doc.get("status") == "Released"

    def put(self, coll, doc_id, body):
        with self.lock:
            cur = self.data[coll].get(doc_id)
            if self._locked(coll, cur):
                return 409, "Rev %s is released and locked. Log a new revision instead." % cur.get("rev", "")
            body = dict(body)
            body["id"] = doc_id
            self.data[coll][doc_id] = body
            self._save()
            return 200, None

    def patch(self, coll, doc_id, body):
        with self.lock:
            cur = self.data[coll].get(doc_id)
            if cur is None:
                return 404, "No such document"
            if self._locked(coll, cur) and set(body) - LOCK_EDITABLE:
                return 409, ("Rev %s is released and locked. Only verification and inspection results can be added; "
                             "log a new revision for design changes." % cur.get("rev", ""))
            cur.update(body)
            cur["id"] = doc_id
            self._save()
            return 200, None

    def delete(self, coll, doc_id):
        with self.lock:
            cur = self.data[coll].get(doc_id)
            if self._locked(coll, cur):
                return 409, "Rev %s is released and can't be deleted." % cur.get("rev", "")
            if cur is not None:
                del self.data[coll][doc_id]
                self._save()
            return 204, None


def make_handler(store):
    class H(BaseHTTPRequestHandler):
        server_version = "CADLog/2"

        def log_message(self, *a):
            pass

        # ---- helpers ----
        def _send(self, code, body=b"", ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)

        def _send_file(self, fp, ctype, disposition=None):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(os.path.getsize(fp)))
            self.send_header("X-Content-Type-Options", "nosniff")
            if disposition:
                self.send_header("Content-Disposition", disposition)
            self.end_headers()
            if self.command != "HEAD":
                with open(fp, "rb") as f:
                    shutil.copyfileobj(f, self.wfile, 1 << 20)

        def _err(self, code, msg):
            self._send(code, {"error": msg})

        def _host_ok(self):
            # Blocks DNS-rebinding: only requests addressed to this machine by name/IP.
            return (self.headers.get("Host") or "").split(":")[0] in ("127.0.0.1", "localhost")

        def _guard(self):
            # Writes must come from this app (or the Fusion add-in): a custom header blocks cross-site form posts.
            if not self._host_ok():
                self._err(403, "Bad host")
                return False
            if self.headers.get("X-Requested-With") != "cadlog":
                self._err(403, "Missing app header")
                return False
            return True

        def _len(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                self._err(413, "Too large (max %d MB)" % (limit // 1048576))
                return None
            return n

        def _json(self):
            n = self._len(MAX_JSON)
            if n is None:
                return None
            try:
                d = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                self._err(400, "Invalid JSON")
                return None
            if not isinstance(d, dict):
                self._err(400, "Body must be an object")
                return None
            return d

        def _recv_to(self, fp, limit):
            n = self._len(limit)
            if n is None:
                return None
            left = n
            with open(fp, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1 << 20, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
            if left:
                os.remove(fp)
                self._err(400, "Upload was interrupted")
                return None
            return n

        def _doc_path(self, path):
            m = re.match(r"^/api/(%s)/([^/]+)$" % "|".join(COLLS), path)
            if not m or not ID_RE.match(m.group(2)):
                return None
            return m.group(1), m.group(2)

        def _result(self, code, msg, doc_id=None):
            if msg:
                return self._err(code, msg)
            self._send(code, {"id": doc_id} if code == 200 else b"")

        # ---- routes ----
        def do_GET(self):
            u = urlparse(self.path)
            path = u.path
            if path in STATIC:
                name, ctype = STATIC[path]
                with open(os.path.join(HERE, name), "rb") as f:
                    return self._send(200, f.read(), ctype)
            if path.startswith("/api/") and not self._host_ok():
                return self._err(403, "Bad host")
            if path == "/api/data":
                return self._send(200, store.snapshot())
            if path == "/api/info":
                return self._send(200, {"dataDir": store.root, "warning": store.warning,
                                        "backups": store.backup_count()})
            if path.startswith("/images/"):
                name = unquote(path[len("/images/"):])
                fp = os.path.join(store.img_dir, name)
                if not IMG_RE.match(name) or not os.path.isfile(fp):
                    return self._err(404, "Not found")
                return self._send_file(fp, IMG_TYPES.get(os.path.splitext(name)[1], "application/octet-stream"))
            if path.startswith("/files/"):
                name = unquote(path[len("/files/"):])
                fp = os.path.join(store.file_dir, name)
                if not FILE_RE.match(name) or not os.path.isfile(fp):
                    return self._err(404, "Not found")
                orig = (parse_qs(u.query).get("name") or [name])[0]
                orig = re.sub(r'[\\/:*?"<>|\r\n]+', "_", orig)[:180] or name
                return self._send_file(fp, "application/octet-stream",
                                       "attachment; filename*=UTF-8''" + quote(orig))
            self._err(404, "Not found")

        do_HEAD = do_GET

        def do_PUT(self):
            if not self._guard():
                return
            t = self._doc_path(urlparse(self.path).path)
            if not t:
                return self._err(404, "Not found")
            body = self._json()
            if body is None:
                return
            code, msg = store.put(t[0], t[1], body)
            self._result(code, msg, t[1])

        def do_PATCH(self):
            if not self._guard():
                return
            t = self._doc_path(urlparse(self.path).path)
            if not t:
                return self._err(404, "Not found")
            body = self._json()
            if body is None:
                return
            code, msg = store.patch(t[0], t[1], body)
            self._result(code, msg, t[1])

        def do_DELETE(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            for prefix, rx, folder in (("/api/images/", IMG_RE, store.img_dir), ("/api/files/", FILE_RE, store.file_dir)):
                if path.startswith(prefix):
                    name = unquote(path[len(prefix):])
                    if not rx.match(name):
                        return self._err(404, "Not found")
                    fp = os.path.join(folder, name)
                    if os.path.isfile(fp):
                        os.remove(fp)
                    return self._send(204)
            t = self._doc_path(path)
            if not t:
                return self._err(404, "Not found")
            code, msg = store.delete(*t)
            self._result(code, msg)

        def do_POST(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path == "/api/images":
                ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
                ext = IMG_EXT.get(ctype)
                if not ext:
                    return self._err(415, "Use PNG, JPG, GIF, WebP or BMP")
                name = uuid.uuid4().hex + ext
                n = self._recv_to(os.path.join(store.img_dir, name), MAX_IMG)
                if n is None:
                    return
                return self._send(200, {"id": name, "url": "/images/" + name, "sizeBytes": n, "contentType": ctype})
            if path == "/api/files":
                orig = unquote(self.headers.get("X-Filename") or "file")[:180]
                ext = os.path.splitext(orig)[1].lower()
                if not re.match(r"^\.[a-z0-9]{1,10}$", ext):
                    ext = ""
                name = uuid.uuid4().hex + ext
                n = self._recv_to(os.path.join(store.file_dir, name), MAX_FILE)
                if n is None:
                    return
                return self._send(200, {"id": name, "name": orig, "size": n,
                                        "url": "/files/" + name + "?name=" + quote(orig)})
            self._err(404, "Not found")

    return H


def main():
    ap = argparse.ArgumentParser(description="CAD Change Log - local app")
    ap.add_argument("--data", default=os.path.join(HERE, "data"), help="data folder (default: ./data)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()

    store = Store(os.path.abspath(a.data))
    srv = None
    for port in range(a.port, a.port + 15):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), make_handler(store))
            break
        except OSError:
            continue
    if not srv:
        sys.exit("No free port between %d and %d." % (a.port, a.port + 14))

    url = "http://127.0.0.1:%d/" % srv.server_address[1]
    try:  # lets the Fusion 360 add-in find the app even if it moved to another port
        with open(PORT_FILE, "w", encoding="utf-8") as f:
            json.dump({"url": url, "pid": os.getpid()}, f)
    except OSError:
        pass
    print("CAD Change Log running at " + url)
    print("Data folder: " + store.root)
    if store.warning:
        print("WARNING: " + store.warning)
    print("Keep this window open while you use the app. Press Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
