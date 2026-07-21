# Menu & Image Checker Online

Aplikasi web untuk:

- menemukan nama menu dan direct link;
- membuka halaman internal yang ditemukan;
- mengecek gambar HTTP error, request gagal, dan `<img>` dengan `naturalWidth = 0`;
- membuat laporan HTML beserta screenshot halaman bermasalah.

## Kenapa tidak memakai GitHub Pages saja?

GitHub Pages hanya menjalankan file statis. Scanner ini membutuhkan Node.js dan browser Chromium melalui Playwright. Karena itu, kode disimpan di GitHub lalu dijalankan sebagai Docker Web Service di Render.

## Deploy dari GitHub ke Render

1. Buat repository GitHub baru.
2. Ekstrak ZIP proyek ini, lalu upload **semua isi foldernya** ke repository. Jangan upload ZIP sebagai satu file.
3. Buka Render dan hubungkan akun GitHub.
4. Pilih **New > Blueprint**, lalu pilih repository ini. Render akan membaca `render.yaml`.
5. Jalankan deploy.
6. Setelah selesai, buka URL `https://nama-service.onrender.com`.
7. Masukkan URL website, lalu klik **Mulai Check**.

Alternatif: pilih **New > Web Service**, hubungkan repository, lalu pilih runtime Docker.

## Environment Variables

| Nama | Wajib | Keterangan |
|---|---:|---|
| `MAX_PAGES_LIMIT` | Tidak | Batas maksimal halaman per scan. Default proyek: 150. |
| `ALLOW_PRIVATE_TARGETS` | Tidak | Tetap `0` pada hosting publik. Nilai `1` hanya untuk self-hosting private yang benar-benar dipercaya. |
| `HOSTED_MODE` | Tidak | Nilai `1` memaksa browser berjalan headless. |

## Catatan penting

- Versi hosting publik hanya menerima URL `http://` dan `https://` yang dapat diakses dari internet.
- Alamat localhost, IP private, dan jaringan internal diblokir untuk mencegah penyalahgunaan SSRF.
- Tidak ada halaman login atau kata sandi aplikasi. Siapa pun yang mengetahui URL hosting dapat menjalankan pemeriksaan.
- Hanya satu scan berjalan dalam satu waktu.
- Storage pada layanan gratis dapat bersifat sementara. Unduh atau simpan laporan penting sebelum service restart atau redeploy.
- Dashboard yang memerlukan login manual belum didukung pada versi online ini.

## Menjalankan dengan Docker secara lokal

```bash
docker build -t menu-image-checker .
docker run --rm -p 3210:10000 menu-image-checker
```

Buka `http://localhost:3210`.
