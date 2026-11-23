# Panel Server

Panel untuk menjalankan bot/aplikasi dengan backend asli (proses, console, file, backup).
Tanpa dependensi: cukup Node.js 16+.

## Cara jalan
    node server.js
Buka http://localhost:3000 . Password pertama dicetak di terminal.
Atur sendiri: PANEL_USER=nama PANEL_PASS=sandi PORT=3000 node server.js

## Catatan
- File server ada di data/server, backup di data/backups.
- Aplikasi yang dijalankan sebaiknya memakai port dari env SERVER_PORT (8080).
- Wajib pasang HTTPS / reverse proxy kalau dipakai di internet, dan pakai password kuat.
- Panel ini menjalankan perintah shell sesuai "perintah start": hanya beri akses ke orang tepercaya.
