#!/usr/bin/env python3
"""CAD Change Log - local app.

Run:  python app.py            (Python 3.8+, standard library only)
      python app.py --data D:/CAD/log --port 8800 --no-browser

Everything is stored in the data folder (default: ./data next to this file):
  data/log.json        parts and revisions, pretty-printed JSON
  data/log.json.bak    the previous save, kept as a one-step undo
  data/images/         screenshots attached to revisions
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
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
COLLS = ("parts", "revisions")
IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif",
           "image/webp": ".webp", "image/bmp": ".bmp"}
IMG_TYPES = {v: k for k, v in IMG_EXT.items()}
MAX_IMG = 25 * 1024 * 1024
MAX_JSON = 4 * 1024 * 1024
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
IMG_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|gif|webp|bmp)$")


class Store:
    def __init__(self, root):
        self.root = root
        self.img_dir = os.path.join(root, "images")
        os.makedirs(self.img_dir, exist_ok=True)
        self.path = os.path.join(root, "log.json")
        self.lock = threading.Lock()
        self.data = self._load()

    def _load(self):
        if not os.path.exists(self.path):
            return {k: {} for k in COLLS}
        with open(self.path, encoding="utf-8") as f:
            raw = json.load(f)
        return {k: {d["id"]: d for d in raw.get(k, []) if "id" in d} for k in COLLS}

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

    def put(self, coll, doc_id, body):
        with self.lock:
            body = dict(body)
            body["id"] = doc_id
            self.data[coll][doc_id] = body
            self._save()

    def patch(self, coll, doc_id, body):
        with self.lock:
            if doc_id not in self.data[coll]:
                return False
            self.data[coll][doc_id].update(body)
            self.data[coll][doc_id]["id"] = doc_id
            self._save()
            return True

    def delete(self, coll, doc_id):
        with self.lock:
            existed = self.data[coll].pop(doc_id, None) is not None
            if existed:
                self._save()
            return existed


def make_handler(store):
    class H(BaseHTTPRequestHandler):
        server_version = "CADLog/1"

        def log_message(self, *a):
            pass

        # ---- helpers ----
        def _send(self, code, body=b"", ctype="application/json"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _err(self, code, msg):
            self._send(code, {"error": msg})

        def _guard(self):
            # Writes must come from this app's own page: a custom header blocks
            # cross-site form posts, and the Host check blocks DNS rebinding.
            host = (self.headers.get("Host") or "").split(":")[0]
            if host not in ("127.0.0.1", "localhost"):
                self._err(403, "Bad host")
                return False
            if self.headers.get("X-Requested-With") != "cadlog":
                self._err(403, "Missing app header")
                return False
            return True

        def _body(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                self._err(413, "Too large (max %d MB)" % (limit // 1048576))
                return None
            return self.rfile.read(n)

        def _json(self):
            raw = self._body(MAX_JSON)
            if raw is None:
                return None
            try:
                d = json.loads(raw or b"{}")
            except ValueError:
                self._err(400, "Invalid JSON")
                return None
            if not isinstance(d, dict):
                self._err(400, "Body must be an object")
                return None
            return d

        def _doc_path(self, path):
            m = re.match(r"^/api/(parts|revisions)/([^/]+)$", path)
            if not m or not ID_RE.match(m.group(2)):
                return None
            return m.group(1), m.group(2)

        # ---- routes ----
        def do_GET(self):
            path = urlparse(self.path).path
            if path in ("/", "/index.html"):
                with open(os.path.join(HERE, "index.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            if path == "/api/data":
                return self._send(200, store.snapshot())
            if path == "/api/info":
                return self._send(200, {"dataDir": store.root})
            if path.startswith("/images/"):
                name = unquote(path[len("/images/"):])
                if not IMG_RE.match(name):
                    return self._err(404, "Not found")
                fp = os.path.join(store.img_dir, name)
                if not os.path.isfile(fp):
                    return self._err(404, "Not found")
                with open(fp, "rb") as f:
                    return self._send(200, f.read(), IMG_TYPES.get(os.path.splitext(name)[1], "application/octet-stream"))
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
            store.put(t[0], t[1], body)
            self._send(200, {"id": t[1]})

        def do_PATCH(self):
            if not self._guard():
                return
            t = self._doc_path(urlparse(self.path).path)
            if not t:
                return self._err(404, "Not found")
            body = self._json()
            if body is None:
                return
            if not store.patch(t[0], t[1], body):
                return self._err(404, "No such document")
            self._send(200, {"id": t[1]})

        def do_DELETE(self):
            if not self._guard():
                return
            path = urlparse(self.path).path
            if path.startswith("/api/images/"):
                name = unquote(path[len("/api/images/"):])
                if not IMG_RE.match(name):
                    return self._err(404, "Not found")
                fp = os.path.join(store.img_dir, name)
                if os.path.isfile(fp):
                    os.remove(fp)
                return self._send(204)
            t = self._doc_path(path)
            if not t:
                return self._err(404, "Not found")
            store.delete(*t)
            self._send(204)

        def do_POST(self):
            if not self._guard():
                return
            if urlparse(self.path).path != "/api/images":
                return self._err(404, "Not found")
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            ext = IMG_EXT.get(ctype)
            if not ext:
                return self._err(415, "Use PNG, JPG, GIF, WebP or BMP")
            raw = self._body(MAX_IMG)
            if raw is None:
                return
            name = uuid.uuid4().hex + ext
            with open(os.path.join(store.img_dir, name), "wb") as f:
                f.write(raw)
            self._send(200, {"id": name, "url": "/images/" + name, "sizeBytes": len(raw), "contentType": ctype})

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
    print("CAD Change Log running at " + url)
    print("Data folder: " + store.root)
    print("Keep this window open while you use the app. Press Ctrl+C to stop.")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
