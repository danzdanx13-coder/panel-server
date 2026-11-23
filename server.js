// Panel Server - backend asli, tanpa dependensi (hanya modul bawaan Node.js)
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, "data"), ROOT = path.join(DATA, "server"), BAK = path.join(DATA, "backups");
const CFG = path.join(DATA, "config.json"), PUB = path.join(__dirname, "public");
[DATA, ROOT, BAK].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ---------- konfigurasi & akun ----------
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString("hex");
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG, "utf8")); } catch {}
const saveCfg = () => fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
{
  let pass = process.env.PANEL_PASS;
  if (!cfg.pass && !pass) { pass = crypto.randomBytes(4).toString("hex"); console.log("Akun pertama dibuat -> user: " + (process.env.PANEL_USER || "admin") + " | password: " + pass); }
  if (pass) { cfg.salt = crypto.randomBytes(8).toString("hex"); cfg.pass = hash(pass, cfg.salt); }
  cfg.user = process.env.PANEL_USER || cfg.user || "admin";
  cfg.startCmd = cfg.startCmd || "node index.js";
  saveCfg();
}
const sessions = new Map();
function auth(req, u) {
  const t = (req.headers.authorization || "").replace("Bearer ", "") || u.searchParams.get("token");
  const e = sessions.get(t);
  return e && e > Date.now();
}

// ---------- proses server ----------
let proc = null, status = "off", startedAt = 0, logs = [];
const clients = new Set();
const emit = o => { const s = "data: " + JSON.stringify(o) + "\n\n"; clients.forEach(r => r.write(s)); };
function log(t) {
  t = String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  logs.push(t); if (logs.length > 500) logs.shift();
  emit({ t: "log", v: t });
}
function setStatus(s) { status = s; emit({ t: "status", v: s }); }
function start(cmd) {
  if (proc) return false;
  log("[panel] Menjalankan: " + cmd + "\n");
  const p = spawn("sh", ["-c", cmd], { cwd: ROOT, detached: true, env: { ...process.env, SERVER_PORT: "8080", PATH: nodePath() } });
  proc = p; startedAt = Date.now(); setStatus("on");
  p.stdout.on("data", log); p.stderr.on("data", log);
  p.on("error", e => log("[panel] Error: " + e.message + "\n"));
  p.on("close", c => { if (proc === p) { proc = null; setStatus("off"); log("[panel] Proses berhenti (kode " + c + ")\n"); } });
  return true;
}
function stop(cb) {
  if (!proc) return cb && cb();
  const p = proc;
  p.once("close", () => cb && cb());
  try { process.kill(-p.pid, "SIGTERM"); } catch {}
  setTimeout(() => { try { process.kill(-p.pid, "SIGKILL"); } catch {} }, 5000);
}

// ---------- statistik ----------
let diskCache = { t: 0, v: 0 };
const sh = (cmd, args) => new Promise(r => execFile(cmd, args, { timeout: 4000 }, (e, o) => r(e ? "" : String(o))));
async function stats() {
  let cpu = 0, mem = 0;
  if (proc) {
    const out = await sh("ps", ["-eo", "pgid=,rss=,pcpu="]);
    out.split("\n").forEach(l => { const [g, r, c] = l.trim().split(/\s+/); if (+g === proc.pid) { mem += +r || 0; cpu += +c || 0; } });
  }
  if (Date.now() - diskCache.t > 10000) {
    const o = await sh("du", ["-sk", ROOT]);
    diskCache = { t: Date.now(), v: parseInt(o) * 1024 || 0 };
  }
  let rx = 0, tx = 0;
  try {
    fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2).forEach(l => {
      const [n, rest] = l.split(":"); if (!rest || n.trim() === "lo") return;
      const f = rest.trim().split(/\s+/); rx += +f[0]; tx += +f[8];
    });
  } catch { rx = tx = null; }
  return {
    status, uptime: proc ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    cpu: Math.round(cpu * 10) / 10, cores: os.cpus().length,
    mem: mem * 1024, memTotal: os.totalmem(), disk: diskCache.v, rx, tx
  };
}

// ---------- versi Node.js ----------
const NODES = path.join(DATA, "node"), MAJORS = [18, 20, 22, 24], ANDROID = process.platform === "android";
fs.mkdirSync(NODES, { recursive: true });
const ARCH = { x64: "x64", arm64: "arm64", arm: "armv7l" }[process.arch];
const nodeBin = n => path.join(NODES, n, "bin");
function nodePath() {
  const n = cfg.node;
  return n && fs.existsSync(path.join(nodeBin(n), "node")) ? nodeBin(n) + path.delimiter + process.env.PATH : process.env.PATH;
}
function nodeList() {
  return fs.readdirSync(NODES, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^node-v\d+\./.test(e.name) && fs.existsSync(path.join(nodeBin(e.name), "node")))
    .map(e => ({ name: e.name, version: e.name.split("-")[1], major: +e.name.match(/^node-v(\d+)\./)[1] }));
}
const getUrl = (url, hops = 5) => new Promise((ok, no) => {
  require("https").get(url, { headers: { "User-Agent": "panel-server" } }, r => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops > 0) { r.resume(); return ok(getUrl(new URL(r.headers.location, url).href, hops - 1)); }
    if (r.statusCode !== 200) { r.resume(); return no(new Error("HTTP " + r.statusCode)); }
    ok(r);
  }).on("error", no).setTimeout(30000, function () { this.destroy(new Error("Koneksi timeout")); });
});
const readAll = r => new Promise((ok, no) => { let b = ""; r.on("data", c => b += c); r.on("end", () => ok(b)); r.on("error", no); });
let nodeBusy = false;
async function installNode(major) {
  nodeBusy = true;
  try {
    if (!ARCH) throw new Error("Arsitektur " + process.arch + " tidak didukung");
    log("[panel] Mencari Node " + major + " terbaru...\n");
    const idx = JSON.parse(await readAll(await getUrl("https://nodejs.org/dist/index.json")));
    const v = (idx.find(x => x.version.startsWith("v" + major + ".")) || {}).version;
    if (!v) throw new Error("Versi " + major + " tidak ditemukan");
    const name = "node-" + v + "-linux-" + ARCH, file = path.join(NODES, name + ".tar.xz");
    if (fs.existsSync(nodeBin(name))) { log("[panel] " + v + " sudah terpasang\n"); return; }
    log("[panel] Mengunduh " + v + " (sekitar 25-30 MB)...\n");
    const r = await getUrl("https://nodejs.org/dist/" + v + "/" + name + ".tar.xz");
    await new Promise((ok, no) => { const w = fs.createWriteStream(file); r.pipe(w); w.on("finish", ok); w.on("error", no); r.on("error", no); });
    log("[panel] Mengekstrak...\n");
    await new Promise((ok, no) => execFile("tar", ["-xJf", file, "-C", NODES], { timeout: 180000 }, e => e ? no(new Error("Gagal ekstrak (butuh tar dan xz): " + e.message)) : ok()));
    fs.rmSync(file, { force: true });
    log("[panel] Node " + v + " terpasang. Pilih 'Pakai' di Setup.\n");
  } catch (e) { log("[panel] Gagal pasang Node: " + e.message + "\n"); }
  finally { nodeBusy = false; }
}

// ---------- util ----------
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
function readBody(req, limit = 5e6) {
  return new Promise((ok, no) => {
    let b = "", n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { no(new Error("Terlalu besar")); req.destroy(); } else b += c; });
    req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error("JSON tidak valid")); } });
  });
}
function safe(p) {
  const f = path.resolve(ROOT, "./" + (p || ""));
  if (f !== ROOT && !f.startsWith(ROOT + path.sep)) throw new Error("Path tidak diizinkan");
  return f;
}
const okName = n => typeof n === "string" && n && path.basename(n) === n && n !== "." && n !== "..";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

const TPL = {
  node: {
    cmd: "node index.js", install: "npm install",
    files: {
      "package.json": JSON.stringify({ name: "app", version: "1.0.0", main: "index.js", dependencies: { express: "^4.19.2" } }, null, 2),
      "index.js": "const express = require('express');\nconst app = express();\nconst port = process.env.SERVER_PORT || 8080;\napp.get('/', (req, res) => res.send('Halo dari Panel Server!'));\napp.listen(port, () => console.log('Server jalan di port ' + port));\n"
    }
  },
  python: {
    cmd: "python3 app.py", install: "pip install -r requirements.txt",
    files: {
      "requirements.txt": "flask\n",
      "app.py": "import os\nfrom flask import Flask\napp = Flask(__name__)\n\n@app.route('/')\ndef home():\n    return 'Halo dari Panel Server!'\n\nif __name__ == '__main__':\n    app.run(host='0.0.0.0', port=int(os.environ.get('SERVER_PORT', 8080)))\n"
    }
  }
};

// ---------- router ----------
http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname, q = k => u.searchParams.get(k) || "";
  try {
    if (!p.startsWith("/api/")) {
      const f = path.join(PUB, p === "/" ? "index.html" : p);
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
      res.writeHead(200, { "Content-Type": mime[path.extname(f)] || "application/octet-stream" });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === "/api/login" && req.method === "POST") {
      const b = await readBody(req);
      const a = Buffer.from(hash(String(b.pass || ""), cfg.salt)), c = Buffer.from(cfg.pass);
      if (b.user === cfg.user && crypto.timingSafeEqual(a, c)) {
        const t = crypto.randomBytes(24).toString("hex"); sessions.set(t, Date.now() + 864e5);
        return json(res, 200, { token: t, user: cfg.user });
      }
      return json(res, 401, { error: "Username atau password salah" });
    }
    if (!auth(req, u)) return json(res, 401, { error: "Belum login" });

    if (p === "/api/state") return json(res, 200, { user: cfg.user, startCmd: cfg.startCmd, status });
    if (p === "/api/stats") return json(res, 200, await stats());
    if (p === "/api/console") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("data: " + JSON.stringify({ t: "init", v: logs.join(""), s: status }) + "\n\n");
      clients.add(res); req.on("close", () => clients.delete(res)); return;
    }
    if (p === "/api/power" && req.method === "POST") {
      const { action } = await readBody(req);
      if (action === "start") { if (!start(cfg.startCmd)) return json(res, 400, { error: "Server sudah berjalan" }); }
      else if (action === "stop") stop();
      else if (action === "restart") stop(() => start(cfg.startCmd));
      else return json(res, 400, { error: "Aksi tidak dikenal" });
      return json(res, 200, { ok: true });
    }
    if (p === "/api/command" && req.method === "POST") {
      const { cmd } = await readBody(req);
      if (!proc) return json(res, 400, { error: "Server tidak berjalan" });
      log("> " + cmd + "\n"); proc.stdin.write(cmd + "\n"); return json(res, 200, { ok: true });
    }
    if (p === "/api/config" && req.method === "POST") {
      const { startCmd } = await readBody(req);
      if (!startCmd || typeof startCmd !== "string") return json(res, 400, { error: "Perintah kosong" });
      cfg.startCmd = startCmd.trim(); saveCfg(); return json(res, 200, { ok: true });
    }
    if (p === "/api/template" && req.method === "POST") {
      const { type } = await readBody(req), t = TPL[type];
      if (!t) return json(res, 400, { error: "Template tidak ada" });
      for (const [n, c] of Object.entries(t.files)) fs.writeFileSync(path.join(ROOT, n), c);
      cfg.startCmd = t.cmd; saveCfg(); return json(res, 200, { ok: true, startCmd: t.cmd });
    }
    if (p === "/api/install" && req.method === "POST") {
      const { type } = await readBody(req), t = TPL[type];
      if (!t) return json(res, 400, { error: "Tipe tidak dikenal" });
      if (!start(t.install)) return json(res, 400, { error: "Hentikan server dulu" });
      return json(res, 200, { ok: true });
    }

    // --- versi Node.js ---
    if (p === "/api/node" && req.method === "GET")
      return json(res, 200, { system: process.version, android: ANDROID, majors: MAJORS, installed: nodeList(), active: cfg.node || "", busy: nodeBusy });
    if (p === "/api/node/install" && req.method === "POST") {
      const { major } = await readBody(req);
      if (ANDROID) return json(res, 400, { error: "Termux tidak bisa memakai Node resmi. Gunakan tombol Node LTS / Terbaru." });
      if (!MAJORS.includes(+major)) return json(res, 400, { error: "Versi tidak tersedia" });
      if (nodeBusy) return json(res, 400, { error: "Instalasi lain masih berjalan" });
      installNode(+major); return json(res, 200, { ok: true });
    }
    if (p === "/api/node/pkg" && req.method === "POST") {
      const { pkg } = await readBody(req);
      if (!ANDROID) return json(res, 400, { error: "Hanya untuk Termux" });
      if (!["nodejs", "nodejs-lts"].includes(pkg)) return json(res, 400, { error: "Paket tidak dikenal" });
      if (!start("pkg install -y " + pkg)) return json(res, 400, { error: "Hentikan server dulu" });
      return json(res, 200, { ok: true });
    }
    if (p === "/api/node/use" && req.method === "POST") {
      const { name } = await readBody(req);
      if (name && !nodeList().some(n => n.name === name)) return json(res, 400, { error: "Versi belum terpasang" });
      cfg.node = name || ""; saveCfg(); return json(res, 200, { ok: true });
    }
    if (p === "/api/node/remove" && req.method === "POST") {
      const { name } = await readBody(req);
      if (!nodeList().some(n => n.name === name)) return json(res, 400, { error: "Versi tidak ditemukan" });
      if (cfg.node === name) { cfg.node = ""; saveCfg(); }
      fs.rmSync(path.join(NODES, name), { recursive: true, force: true }); return json(res, 200, { ok: true });
    }

    // --- file manager ---
    if (p === "/api/files") {
      const d = safe(q("path"));
      const list = fs.readdirSync(d, { withFileTypes: true }).map(e => {
        const s = fs.statSync(path.join(d, e.name));
        return { name: e.name, dir: e.isDirectory(), size: s.size, mtime: s.mtimeMs };
      }).sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name));
      return json(res, 200, { files: list });
    }
    if (p === "/api/file") {
      const f = safe(q("path"));
      if (fs.statSync(f).size > 2e6) return json(res, 400, { error: "File terlalu besar untuk diedit" });
      return json(res, 200, { content: fs.readFileSync(f, "utf8") });
    }
    if (p === "/api/save" && req.method === "POST") {
      const b = await readBody(req); fs.writeFileSync(safe(b.path), String(b.content ?? "")); return json(res, 200, { ok: true });
    }
    if (p === "/api/mkdir" && req.method === "POST") {
      const b = await readBody(req); if (!okName(b.name)) return json(res, 400, { error: "Nama tidak valid" });
      fs.mkdirSync(path.join(safe(b.path), b.name), { recursive: true }); return json(res, 200, { ok: true });
    }
    if (p === "/api/rename" && req.method === "POST") {
      const b = await readBody(req), f = safe(b.path);
      if (f === ROOT || !okName(b.to)) return json(res, 400, { error: "Nama tidak valid" });
      fs.renameSync(f, path.join(path.dirname(f), b.to)); return json(res, 200, { ok: true });
    }
    if (p === "/api/delete" && req.method === "POST") {
      const b = await readBody(req), f = safe(b.path);
      if (f === ROOT) return json(res, 400, { error: "Tidak bisa menghapus root" });
      fs.rmSync(f, { recursive: true, force: true }); return json(res, 200, { ok: true });
    }
    if (p === "/api/upload" && req.method === "POST") {
      if (!okName(q("name"))) return json(res, 400, { error: "Nama tidak valid" });
      const w = fs.createWriteStream(path.join(safe(q("path")), q("name")));
      req.pipe(w); w.on("finish", () => json(res, 200, { ok: true })); w.on("error", e => json(res, 500, { error: e.message }));
      return;
    }
    if (p === "/api/download") {
      const f = safe(q("path"));
      res.writeHead(200, { "Content-Disposition": 'attachment; filename="' + path.basename(f) + '"' });
      return fs.createReadStream(f).pipe(res);
    }

    // --- backup ---
    if (p === "/api/backups" && req.method === "GET") {
      const l = fs.readdirSync(BAK).filter(n => n.endsWith(".tar.gz")).map(n => ({ name: n, size: fs.statSync(path.join(BAK, n)).size, mtime: fs.statSync(path.join(BAK, n)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { backups: l });
    }
    if (p === "/api/backups" && req.method === "POST") {
      const n = "backup-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".tar.gz";
      execFile("tar", ["-czf", path.join(BAK, n), "--exclude=./node_modules", "-C", ROOT, "."], e => e ? json(res, 500, { error: "Gagal membuat backup" }) : json(res, 200, { name: n }));
      return;
    }
    if (p === "/api/backup/download") {
      const n = q("name"); if (!okName(n)) return json(res, 400, { error: "Nama tidak valid" });
      res.writeHead(200, { "Content-Disposition": 'attachment; filename="' + n + '"' });
      return fs.createReadStream(path.join(BAK, n)).pipe(res);
    }
    if (p === "/api/backup/delete" && req.method === "POST") {
      const b = await readBody(req); if (!okName(b.name)) return json(res, 400, { error: "Nama tidak valid" });
      fs.rmSync(path.join(BAK, b.name), { force: true }); return json(res, 200, { ok: true });
    }
    if (p === "/api/backup/restore" && req.method === "POST") {
      const b = await readBody(req); if (!okName(b.name)) return json(res, 400, { error: "Nama tidak valid" });
      if (proc) return json(res, 400, { error: "Hentikan server dulu" });
      execFile("tar", ["-xzf", path.join(BAK, b.name), "-C", ROOT], e => e ? json(res, 500, { error: "Gagal restore" }) : json(res, 200, { ok: true }));
      return;
    }
    json(res, 404, { error: "Endpoint tidak ada" });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
}).listen(PORT, () => console.log("Panel berjalan di http://localhost:" + PORT));
