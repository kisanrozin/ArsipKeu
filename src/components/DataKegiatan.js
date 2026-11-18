import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { TAHUN_ANGGARAN_AKTIF } from "../data/masterData";
import { ambilLedgerSpm, kunciKode, nomorBulanDariId } from "../data/ledgerSpm";
import {
  SPJ_FOLDER_ID,
  API_KEY,
  parseBerkasSpm,
  rekapPerBulanDariBaris,
  terbitkanPerBulanDrive,
} from "../data/rekapKegiatan";
import {
  ambilRekapSpm,
  bulanIdDariYm,
  bulanTerakhirDenganData,
  dengarRekapSpm,
  rekapRealisasiSpm,
} from "../data/rekapSpm";
import {
  bacaKegiatanTambahan,
  dengarKegiatanTambahan,
  tulisKegiatanTambahan,
} from "../data/KegiatanTambahan";
import {
  bacaCacheKegiatan,
  cacheMasihSegar,
  muatDataKegiatanDariDrive,
} from "../data/cacheKegiatan";
import { usePeran } from "../context/PeranContext";
import CadanganData from "./CadanganData";
import { parseNamaFolder } from "../data/namaFolderKegiatan";
import {
  ambilEntriDrop,
  analisaDropKegiatan,
  gabungImporKeDaftar,
} from "../data/imporFolder";

/* ══════════════════════════════════════════════════════════════
   DATA KEGIATAN & ANGGARAN
   Sumber data: Google Drive — folder SPJ (alur mengikuti diagram
   "alurdigital": Folder Kegiatan → Folder Rekening → Berkas SPM)
   ══════════════════════════════════════════════════════════════ */

const DRIVE_FOLDER_ID = SPJ_FOLDER_ID;
const FOLDER_MIME = "application/vnd.google-apps.folder";

/* ── Sumber REALISASI dari spreadsheet (rekap kumulatif) ───────
   Kolom "Realisasi" pada tabel ini diisi dari spreadsheet rekap
   kumulatif (bukan dari penjumlahahan nama berkas PDF), sehingga
   selalu sama dengan data Excel terbaru di Drive.
   Tab yang dipakai = tab rekap TERBARU yang ada di spreadsheet,
   dan namanya dibaca otomatis dari daftar tab (src/data/daftarSheet.js).
   Jadi begitu tab baru (mis. "JAN SD OKTOBER") dibuat di Drive,
   tabel ini ikut memakai angka tab itu tanpa perlu ubah kode.
   Pembacaan tabnya orang yang sama dengan Dashboard, lewat
   src/data/rekapKegiatan.js → ambilRekapKumulatifTerbaru().   */

/* ── Sumber PAGU & PERSENTASE ─────────────────────────────────
   Pagu per KEGIATAN tidak tersedia di sumber mana pun (hanya ada
   per BIDANG: SDA / CKPS / UPTU pada tab pertama spreadsheet —
   "resume SP2D", dibaca live lewat bacaPaguPerBidang()). Karena
   itu tiap kegiatan memakai pagu BIDANG-nya:
     · petanya ada di src/data/masterData.js → PETA_BIDANG_KEGIATAN
       + KATA_KUNCI_BIDANG (bidangDariKegiatan());
     · %  = realisasi kegiatan ÷ pagu bidang;  baris induk (induk /
       cabang / detail) menjumlahkan pagu bidang yang SUDAH didup
       (tiap bidang dihitung sekali), supaya tidak dihitung 2×.   */

/* OAuth Client ID (tipe "Web application") dari Google Cloud Console →
   APIs & Services → Credentials. Kosongkan var ini bila belum diatur:
   formulir tetap bisa diisi, tetapi unggah PDF ke Drive dinonaktifkan.
   Scope drive.file = hanya folder & berkas yang dibuat aplikasi ini. */
const GOOGLE_CLIENT_ID =
  "647903074551-fho1acg1at9k8rlp324jsv37etuu4v0e.apps.googleusercontent.com";
const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.file";

/* Nama rekening sesuai alur diagram digital */
const NAMA_REKENING = {
  "521211": "Belanja Bahan",
  "522111": "Belanja Perjalanan Dinas",
  "522131": "Belanja Jasa Konsultan",
  "522151": "Belanja Jasa Profesi",
  "522191": "Belanja Jasa Lainnya",
  "524111": "Belanja Perjalanan Dinas Biasa",
};

/* ── Format & helper ────────────────────────────────────────── */
function formatRupiah(n) {
  const num = Number(n);
  if (!isFinite(num)) return "Rp 0";
  return "Rp " + num.toLocaleString("id-ID");
}

function hitungPersen(realisasi, pagu) {
  const p = Number(pagu) || 0;
  if (p <= 0) return 0;
  return ((Number(realisasi) || 0) / p) * 100;
}

/* "2026-07-28" → "28/07/2026".
   Hanya tanggal kalender yang benar-benar ada yang ditampilkan;
   bagian tanggal dari string ISO (mis. "2026-07-28T…" dari Drive)
   juga diterima. Nilai kosong/tidak lengkap/mustahil (mis.
   "32/13/2026") → "—" supaya tidak ada tanggal "undefined/…"
   maupun tanggal palsu di tabel. */
function isoToTglId(iso) {
  const cocok = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!cocok) return "—";
  const [, y, m, d] = cocok;
  const hari = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const valid =
    hari.getUTCFullYear() === Number(y) &&
    hari.getUTCMonth() === Number(m) - 1 &&
    hari.getUTCDate() === Number(d);
  return valid ? `${d}/${m}/${y}` : "—";
}

/* Ambil "YYYY-MM" (untuk filter bulan) dari tanggal valid;
   nilai tidak valid → null agar tidak ikut dibandingkan. */
function bulanIso(iso) {
  const cocok = String(iso || "").match(/^(\d{4})-(\d{2})-/);
  if (!cocok) return null;
  const bulan = Number(cocok[2]);
  return bulan >= 1 && bulan <= 12 ? `${cocok[1]}-${cocok[2]}` : null;
}

/* Normalisasi nomor SPM hanya menjadi digit, sehingga "6" dari nama
   berkas "SPM 6_522112_120126_552780.pdf" cocok dengan "00006T" dari
   ledger spreadsheet (keduanya = 6). Digunakan untuk mencocokkan bukti
   PDF dengan ledger agar SPM yang tampil benar. */
function normalNoSpm(no) {
  const digit = String(no || "").replace(/\D/g, "");
  /* Konversi ke Number hilangkan nol di depan: "00006" → "6", sehingga
     "6" dari nama berkas cocok dengan "00006T" dari ledger spreadsheet. */
  return digit ? String(Number(digit)) : "";
}

/* Tampilkan Nomor SPM tanpa nol di depan supaya mudah terbaca,
   mis. "00006T" → "6T", "00006" → "6". Huruf di akhir dipertahankan.
   Dipakai hanya untuk penampilan (bukan untuk pencocokan data). */
function formatNoSpm(no) {
  if (!no || no === "—") return "—";
  const m = String(no).match(/^(\d+)(.*)$/);
  if (!m) return no;
  return Number(m[1]) + m[2];
}

/* Tanggal hari ini menurut waktu lokal (WIB/WITA/WIT), bukan UTC —
   `toISOString()` bisa menyimpang satu hari pada pagi hari. */
function tanggalHariIni() {
  const d = new Date();
  const bulan = String(d.getMonth() + 1).padStart(2, "0");
  const hari = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${bulan}-${hari}`;
}

/* Kunci unik satu berkas (path folder + nama) — dipakai untuk mencocokkan
   hasil unggahan Drive dengan metadata yang sudah tersimpan. */
function kunciPathBerkas(path, nama) {
  return [...(path || []), nama].join("/");
}

/* Gabungkan dua daftar berkas tanpa menggandakan SPM yang sama. */
function gabungBerkasUnik(a = [], b = []) {
  const peta = new Map();
  [...a, ...b].forEach((x) => {
    if (!x) return;
    const spm = x.spm;
    const kunci = spm
      ? `${spm.noSpm}|${spm.rekening}|${spm.nilai}|${spm.tanggal}`
      : `${x.name || ""}|${(x.path || []).join("/")}`;
    if (!peta.has(kunci)) peta.set(kunci, x);
  });
  return [...peta.values()];
}

/* Bangun daftar rekening (bentuk yang dipahami rekapRekening) dari
   berkas SPM hasil impor folder. */
function rekeningDariBerkas(berkas = []) {
  const peta = new Map();
  (berkas || []).forEach((b) => {
    const kode = b && b.spm ? b.spm.rekening : b && b.rekening;
    if (!kode) return;
    if (!peta.has(kode)) peta.set(kode, { kode, jumlah: 0 });
    peta.get(kode).jumlah += 1;
  });
  return [...peta.values()];
}

/* Waktu simpan cache (ms) → teks singkat: "baru saja", "3 mnt lalu". */
function waktuRelatif(ms) {
  const t = Number(ms) || 0;
  if (t <= 0) return "";
  const detik = Math.floor((Date.now() - t) / 1000);
  if (detik < 60) return "baru saja";
  const menit = Math.floor(detik / 60);
  if (menit < 60) return `${menit} mnt lalu`;
  const jam = Math.floor(menit / 60);
  if (jam < 24) return `${jam} jam lalu`;
  return `${Math.floor(jam / 24)} hari lalu`;
}

/* "2026-07" → "Juli 2026"; dipakai untuk chip & keterangan filter bulan. */
const NAMA_BULAN_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/* Nama bulan singkat untuk label batang sparkline filter. */
const NAMA_BULAN_SINGKAT = [
  "Jan", "Feb", "Mar", "Apr", "Mei", "Jun",
  "Jul", "Agu", "Sep", "Okt", "Nov", "Des",
];

function labelBulan(ym) {
  const cocok = String(ym || "").match(/^(\d{4})-(\d{2})$/);
  if (!cocok) return ym || "—";
  const bulan = Number(cocok[2]);
  if (bulan < 1 || bulan > 12) return ym;
  return `${NAMA_BULAN_ID[bulan - 1]} ${cocok[1]}`;
}

/* Label periode dari rentang filter: "Januari 2026 – Juni 2026" bila
   bulan awal ≠ akhir, atau label bulan tunggal bila sama. Cocok dengan
   angka realisasi kumulatif yang berlaku s.d. bulan "sampai". */
function labelPeriodeBulan(dari, sampai) {
  if (dari && sampai && dari !== sampai) {
    return `${labelBulan(dari)} – ${labelBulan(sampai)}`;
  }
  return labelBulan(dari || sampai);
}

/* Periode dari beranda ({ tahun, bulan: "juli" }) → rentang kumulatif
   Januari s.d. bulan terpilih: { dari: "2026-01", sampai: "2026-07" }.
   Angka "Realisasi Bulan" di beranda memang kumulatif sejak Januari,
   jadi filter di Data Kegiatan memakai rentang yang sama. Nilai kosong/tidak valid → null. */
function rentangDariPeriode(periode) {
  const tahun = String((periode && periode.tahun) || "").trim();
  const nomor = nomorBulanDariId(periode && periode.bulan);
  if (!/^\d{4}$/.test(tahun) || !nomor) return null;
  const sampai = `${tahun}-${String(nomor).padStart(2, "0")}`;
  return {
    dari: `${tahun}-01`,
    sampai,
  };
}

/* ── Akses Google Drive API ─────────────────────────────────── */
async function listAnak(folderId) {
  const hasil = [];
  let pageToken = null;
  let guard = 0;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields:
        "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink)",
      pageSize: "200",
      key: API_KEY,
      /* Cache-buster: pembacaan harus selalu segar (realtime). */
      t: String(Date.now()),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hasil.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
    guard += 1;
  } while (pageToken && guard < 20);
  return hasil;
}

function namaRekening(kode) {
  return NAMA_REKENING[String(kode || "").trim()] || `Rekening ${kode || "—"}`;
}

/* ── Pencarian teks (kode & nama kegiatan/akun belanja) ────────
   Titik, spasi, dan tanda baca diabaikan supaya pengguna tidak perlu
   menulis format kode persis. Contoh: "7769.AFA", "7769 afa", dan
   "7769afa" semuanya menemukan kode yang sama. Setiap kata kunci
   harus ada pada kode/nama (urutan bebas), jadi "afa 7769" juga
   cocok. KODE LENGKAP (kode kegiatan + kode akun belanja) seperti
   "7769.AFA.001.100.A.521211" juga dicocokkan. Semua baris —
   termasuk data hasil "+ Tambah Data" — memakai pencocokan ini. */
function normalCari(teks) {
  return String(teks || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cocokCari(kueri, ...nilai) {
  const kata = normalCari(kueri).split(" ").filter(Boolean);
  if (kata.length === 0) return true;
  const teks = normalCari(nilai.filter(Boolean).join(" "));
  const padat = teks.replace(/ /g, "");
  return kata.every((k) => teks.includes(k) || padat.includes(k));
}

/* Kode & nama rekening (kode akun belanja) milik sebuah baris —
   dipakai agar pencarian juga menemukan kegiatan lewat kode belanja. */
function nilaiRekeningUntukCari(r) {
  const nilai = [];
  (r && r.rekening ? r.rekening : []).forEach((k) => {
    if (k && typeof k === "object") {
      nilai.push(k.kode || "", k.nama || "");
    } else {
      nilai.push(k || "", namaRekening(k));
    }
  });
  return nilai;
}

/* Ambil ID folder Drive dari tautan webViewLink
   (…/drive/folders/<ID>) — dipakai saat cache lama belum menyimpan id. */
function idFolderDariLink(url) {
  const m = String(url || "").match(/\/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

/* ══════════════════════════════════════════════════════════════
   FORM "TAMBAH DATA KEGIATAN" — pemisahan kode per tingkat
   ------------------------------------------------------------
   Kode kegiatan dipecah satu per satu, mengikuti alur digital:
     [7769] . [AFA] . [001] . [100] . [A]
       │        │        │       │      └ level 5
       │        │        │       └──────── level 4
       │        │        └──────────────── level 3
       │        └───────────────────────── level 2
       └────────────────────────────────── level 1 (Kode Induk)
   Setiap kotak berisi satu segmen; pilihan diambil dari kode yang
   sudah ada di Drive, dan boleh diketik sendiri bila segmen baru.
   ══════════════════════════════════════════════════════════════ */
const LABEL_SEGMEN = ["Induk", "Cabang", "Detail", "Kegiatan", "Output"];

/* Kunci prefix untuk saran level ke-`i`. Level 1 memakai "". */
function prefixSegmen(segmen, i) {
  const isi = segmen
    .slice(0, i)
    .map((s) => String(s || "").trim().toUpperCase())
    .filter(Boolean)
    .join(".");
  return i === 0 ? "" : `${isi}.`;
}

/* Kumpulan segmen yang sudah dipakai pada tiap level, dari kode di Drive. */
function bangunSaranSegmen(baris) {
  const setPerPrefix = new Map();
  const tambah = (prefix, nilai) => {
    if (!setPerPrefix.has(prefix)) setPerPrefix.set(prefix, new Set());
    setPerPrefix.get(prefix).add(nilai);
  };

  baris.forEach((r) => {
    const segs = String(r.kode || "")
      .split(".")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (segs.length === 0) return;
    tambah("", segs[0]);
    for (let i = 1; i < segs.length; i += 1) {
      tambah(`${segs.slice(0, i).join(".")}.`, segs[i]);
    }
  });

  const hasil = new Map();
  setPerPrefix.forEach((set, prefix) => {
    hasil.set(prefix, [...set].sort((a, b) => a.localeCompare(b, "id")));
  });
  return hasil;
}

/* Nama kegiatan yang kodenya cocok dengan kode yang sudah diketik. */
function sarankanNama(baris, kode) {
  const target = String(kode || "")
    .trim()
    .toUpperCase();
  const set = new Set();
  baris.forEach((r) => {
    const nama = String(r.nama || "").trim();
    if (!nama) return;
    if (!target || String(r.kode || "").toUpperCase().startsWith(target)) {
      set.add(nama);
    }
  });
  return [...set].sort((a, b) => a.localeCompare(b, "id"));
}

/* ══════════════════════════════════════════════════════════════
   UNGGAH BERKAS KE GOOGLE DRIVE (butuh login Google / OAuth)
   ------------------------------------------------------------
   Penulisan ke Drive tidak bisa dilakukan hanya dengan API key,
   jadi dipakai Google Identity Services:
     · login   → token akses (scope drive.file)
     · folder  → cari folder kegiatan, buat bila belum ada
     · berkas  → unggah PDF ke folder kegiatan / sub-folder rekening
   ══════════════════════════════════════════════════════════════ */
function muatPustakaGoogle() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) {
      resolve(window.google);
      return;
    }
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = () =>
      window.google && window.google.accounts
        ? resolve(window.google)
        : reject(new Error("Pustaka Google Identity Services gagal dimuat."));
    s.onerror = () =>
      reject(new Error("Gagal memuat Google Identity Services (cek koneksi)."));
    document.head.appendChild(s);
  });
}

/* Minta access token Google. Callback dipakai GIS (bukan popup manual)
   agar tidak diblokir popup browser. */
function mintaTokenAkses() {
  if (!GOOGLE_CLIENT_ID) {
    return Promise.reject(
      new Error(
        "GOOGLE_CLIENT_ID belum diisi. Isi di src/components/DataKegiatan.js terlebih dahulu."
      )
    );
  }
  return muatPustakaGoogle().then(
    (google) =>
      new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: OAUTH_SCOPE,
          callback: (resp) => {
            if (resp.error) {
              reject(
                new Error(
                  resp.error_description || resp.error || "Login Google gagal."
                )
              );
            } else {
              resolve(resp.access_token);
            }
          },
          error_callback: (err) =>
            reject(
              new Error(
                err?.message || "Login Google dibatalkan / gagal. Coba lagi."
              )
            ),
        });
        client.requestAccessToken();
      })
  );
}

/* Cache token di sessionStorage agar tidak meminta login tiap kali. */
const TOKEN_KEY = "pu_arsip_drive_token";
function bacaToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || null;
  } catch (e) {
    return null;
  }
}
function simpanToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    /* abaikan */
  }
}

/* Buat folder kegiatan bila belum ada di Drive. */
async function buatFolderDrive(token, namaFolder, indukId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: namaFolder,
        mimeType: FOLDER_MIME,
        parents: [indukId],
      }),
    }
  );
  if (!res.ok) {
    const pesan = await bacaPesanDrive(res);
    throw new Error(`Gagal membuat folder di Drive — ${pesan}`);
  }
  return res.json();
}

/* Unggah satu berkas (PDF) ke folder tertentu di Drive. */
async function unggahBerkasDrive(token, indukId, file) {
  const boundary = `puarsip${Date.now()}`;
  const meta = {
    name: file.name,
    parents: [indukId],
    mimeType: file.type || "application/pdf",
  };
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(meta),
      `\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`,
      file,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,webViewLink&key=${API_KEY}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    const pesan = await bacaPesanDrive(res);
    throw new Error(`Gagal mengunggah berkas — ${pesan}`);
  }
  return res.json();
}

async function bacaPesanDrive(res) {
  try {
    const data = await res.json();
    return data?.error?.message || `HTTP ${res.status}`;
  } catch (e) {
    return `HTTP ${res.status}`;
  }
}

/* ═══════════════════════════════════════════════════════════════
   DRIVE: baca & tulis data kegiatan tambahan sebagai JSON file
   File disimpan di folder SPJ (SPJ_FOLDER_ID) supaya data metadata
   kegiatan yang diinput admin tersimpan di Drive, tidak hanya di
   localStorage browser. Data tetap aman di localStorage bila Drive
   gagal (tidak ada penolakan penyimpanan lokal).
   ═══════════════════════════════════════════════════════════════ */
const NAMA_BERKAS_DATA_TAMBAHAN = "data-kegiatan-tambahan.json";

/* Cari berkas dengan nama tertentu di satu folder Drive. */
async function cariBerkasDiDrive(token, folderId, namaBerkas) {
  const q = `'${folderId}' in parents and name = '${namaBerkas}' and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name,mimeType,size,webViewLink)",
    key: API_KEY,
  });
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  if (!res.ok) {
    const pesan = await bacaPesanDrive(res);
    throw new Error(`Gagal mencari berkas di Drive — ${pesan}`);
  }
  const data = await res.json();
  return (data.files || [])[0] || null;
}

/* Unduh isi berkas Drive sebagai teks. */
async function bacaFileDariDrive(token, fileId) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const pesan = await bacaPesanDrive(res);
    throw new Error(`Gagal membaca berkas dari Drive — ${pesan}`);
  }
  return res.text();
}

/* Buat atau timpa berkas JSON di Drive. */
async function simpanFileJsonKeDrive(token, folderId, namaBerkas, kontenObj) {
  const konten = JSON.stringify(kontenObj, null, 2);
  const existing = await cariBerkasDiDrive(token, folderId, namaBerkas);

  const boundary = `puarsip${Date.now()}`;
  const meta = {
    name: namaBerkas,
    parents: [folderId],
    mimeType: "application/json",
  };

  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(meta),
      `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      konten,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` }
  );

  let url, method;
  if (existing) {
    // Timpa berkas yang sudah ada.
    url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&fields=id,name,size,webViewLink&key=${API_KEY}`;
    method = "PATCH";
  } else {
    url = `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,webViewLink&key=${API_KEY}`;
    method = "POST";
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  if (!res.ok) {
    const pesan = await bacaPesanDrive(res);
    throw new Error(`Gagal menyimpan berkas ke Drive — ${pesan}`);
  }
  return res.json();
}

/* Muat data kegiatan tambahan dari Drive (kembalikan null bila tidak ada / gagal). */
export async function muatDataTambahanDariDrive() {
  const token = bacaToken();
  if (!token) return null;
  try {
    const file = await cariBerkasDiDrive(
      token,
      DRIVE_FOLDER_ID,
      NAMA_BERKAS_DATA_TAMBAHAN
    );
    if (!file) return null;
    const teks = await bacaFileDariDrive(token, file.id);
    const data = JSON.parse(teks);
    return Array.isArray(data) ? data : null;
  } catch (e) {
    console.warn("Gagal memuat data kegiatan tambahan dari Drive:", e);
    return null;
  }
}

/* Simpan data kegiatan tambahan ke Drive (dipanggil setelah localStorage tersimpan). */
export function simpanDataTambahanKeDrive(daftar) {
  const token = bacaToken();
  if (!token) return Promise.resolve(null); // belum login — lewati Drive
  return simpanFileJsonKeDrive(
    token,
    DRIVE_FOLDER_ID,
    NAMA_BERKAS_DATA_TAMBAHAN,
    daftar
  ).catch((e) => {
    console.warn("Gagal menyimpan data kegiatan tambahan ke Drive:", e);
    return null;
  });
}

/* ── Pekerjaan dengan batas konkurensi (jalankanKolom) sekarang
   berada di src/data/cacheKegiatan.js karena penelusuran Drive
   dipindahkan ke modul itu. */

/* ══════════════════════════════════════════════════════════════
   STRUKTUR HIERARKIS (mengikuti diagram alurdigital)
     7769                        → Kode Induk        (program)
     └ 7769.AFA                 → Kode Cabang       (kegiatan)
        └ 7769.AFA.001.100.A    → Kode Kegiatan     (output)
           └ 521211             → Kode Akun Belanja (rekening)
   ══════════════════════════════════════════════════════════════ */
const LABEL_LEVEL = {
  induk: "Kode Induk",
  cabang: "Kode Cabang",
  detail: "Kode Detail",
  kegiatan: "",
  akun: "",
};

/* Rekap per kode akun belanja dari berkas SPM sebuah kegiatan */
function rekapRekening(r, rekapSheetData) {
  const peta = new Map();
  const ambil = (kode) => {
    const k = String(kode || "").trim();
    if (!k) return null;
    if (!peta.has(k)) {
      peta.set(k, {
        kode: k,
        nama: namaRekening(k),
        jumlahBerkas: 0,
        jumlahUnik: 0,
        salinan: 0,
        lain: 0,
        realisasi: 0,
        tanggal: null,
        link: null,
        folderId: null,
      });
    }
    return peta.get(k);
  };

  (r.rekening || []).forEach((k) => {
    const n = ambil(k.kode);
    if (!n) return;
    n.jumlahBerkas += k.jumlah || 0;
    n.link = k.link || null;
    n.folderId = k.id || n.folderId;
  });
  (r.berkas || []).forEach((b) => {
    const n = ambil(b.spm.rekening);
    if (!n) return;
    n.realisasi += b.spm.nilai;
    n.jumlahUnik += 1;
    if (b.spm.tanggal && (!n.tanggal || b.spm.tanggal > n.tanggal)) {
      n.tanggal = b.spm.tanggal;
    }
  });
  (r.salinan || []).forEach((b) => {
    const n = ambil(b.spm.rekening);
    if (n) n.salinan += 1;
  });
  (r.lainnya || []).forEach((b) => {
    const n = ambil(b.rekening);
    if (n) n.lain += 1;
  });

  // Angka utama per rekening diambil dari spreadsheet rekap kumulatif;
  // penjumlahan nama berkas PDF tetap disimpan sebagai cadangan.
  peta.forEach((n) => {
    n.realisasiBerkas = n.realisasi;
    const v =
      rekapSheetData && rekapSheetData.perRekening
        ? rekapSheetData.perRekening.get(n.kode)
        : null;
    n.sumberRealisasi = v ? "Spreadsheet" : "Berkas Drive";
    if (v && typeof v.realisasi === "number") n.realisasi = v.realisasi;
  });

  return [...peta.values()].sort((a, b) =>
    a.kode.localeCompare(b.kode, "id")
  );
}

function nodeBaru(key, kode, tipe, depth) {
  return {
    key,
    kode,
    nama: "",
    tipe,
    depth,
    pagu: 0,
    /* Pagu per bidang (SDA/CKPS/UPTU) yang membentuk node ini —
       dihapus duplikasinya saat aggregasi supaya pagu bidang tidak
       dijumlahkan berkali-kali (Map<bidang, pagu>). */
    bidangPagu: null,
    realisasi: 0,
    realisasiBerkas: 0,
    sumberRealisasi: "—",
    persen: 0,
    tanggal: null,
    jumlahBerkas: 0,
    jumlahKegiatan: 0,
    jumlahRekening: 0,
    children: [],
    berkas: [],
    lainnya: [],
    salinan: [],
    /* Folder kode akun belanja di Drive (untuk kegiatan). */
    rekening: [],
    /* ID folder kegiatan / rekening di Drive (untuk muat realtime). */
    folderId: "",
    link: null,
    lokal: false,
  };
}

/* Bangun pohon hierarkis dari baris kegiatan (satu daun = satu kegiatan) */
function bangunPohon(baris, rekapSheetData, nilaiRealisasi) {
  const akar = [];
  const indeks = new Map();

  baris.forEach((r) => {
    const segs = String(r.kode || "—")
      .split(".")
      .filter(Boolean);
    const total = segs.length;
    let parent = null;
    let key = "";

    for (let i = 0; i < total; i += 1) {
      key = segs.slice(0, i + 1).join(".");
      const tipe =
        i === total - 1 ? "kegiatan" : i === 0 ? "induk" : i === 1 ? "cabang" : "detail";
      let node = indeks.get(key);
      if (!node) {
        node = nodeBaru(key, key, tipe, i);
        indeks.set(key, node);
        if (parent) parent.children.push(node);
        else akar.push(node);
      }
      parent = node;
    }
    if (!parent) return;

    /* Daun = Kode Kegiatan */
    parent.nama = parent.nama || r.nama || "";
    /* Pagu per kegiatan berasal dari pagu BIDANG-nya (SDA/CKPS/UPTU);
       disimpan per bidang supaya baris induk tidak menjumlahkannya
       berulang (banyak kegiatan berbagi pagu bidang yang sama).
       Kegiatan tanpa bidang (atau pagu yang diisi manual lewat form)
       tetap dijumlahkan polos lewat `pagu`. */
    if (r.bidang && r.pagu > 0) {
      parent.bidangPagu = parent.bidangPagu || new Map();
      if ((parent.bidangPagu.get(r.bidang) || 0) < r.pagu) {
        parent.bidangPagu.set(r.bidang, r.pagu);
      }
    } else {
      parent.pagu += r.pagu || 0;
    }
    /* Realisasi: bila kegiatan ini ada di LEDGER spreadsheet (tab rekap
       SPM kumulatif), angka yang dipakai adalah total SPM pada ledger
       itu — sumber yang sama dengan bukti laporan SPM, sehingga kolom
       Realisasi dan daftar bukti selalu cocok. */
    const nilai =
      typeof nilaiRealisasi === "function"
        ? nilaiRealisasi(r)
        : r.realisasi || 0;
    parent.realisasi += Number(nilai) || 0;
    parent.realisasiBerkas += r.realisasiBerkas || 0;
    parent.sumberRealisasi = r.realisasiPerBulan
      ? "Impor folder"
      : r.sumberRealisasi || parent.sumberRealisasi;
    parent.jumlahBerkas += r.jumlahBerkas || 0;
    parent.link = r.link || parent.link;
    /* ID folder kegiatan di Drive — untuk memuat berkas secara realtime. */
    parent.folderId = parent.folderId || r.id || "";
    parent.lokal = parent.lokal || r.lokal;
    parent.berkas = parent.berkas.concat(r.berkas || []);
    parent.lainnya = parent.lainnya.concat(r.lainnya || []);
    parent.salinan = parent.salinan.concat(r.salinan || []);
    /* Folder kode akun belanja di Drive (folder anak kegiatan) — dipakai
       modal bukti laporan SPM untuk memecah bukti per kode belanja. */
    parent.rekening = r.rekening || parent.rekening || [];
    if (r.tanggal && (!parent.tanggal || r.tanggal > parent.tanggal)) {
      parent.tanggal = r.tanggal;
    }

    /* Anak daun = Kode Akun Belanja */
    rekapRekening(r, rekapSheetData).forEach((k) => {
      parent.children.push({
        ...nodeBaru(`${parent.key}::${k.kode}`, k.kode, "akun", parent.depth + 1),
        nama: k.nama,
        /* Kode Kegiatan induknya — dipakai untuk mencocokkan baris
           ledger (sumber badge 📎 "N berkas") saat memecahnya ke
           sini (baris akun belanja). */
        induk: parent.kode,
        pagu: null, // pagu hanya tersedia per kegiatan
        basisPagu: r.pagu,
        realisasi: k.realisasi,
        realisasiBerkas: k.realisasiBerkas,
        sumberRealisasi: k.sumberRealisasi,
        persen: hitungPersen(k.realisasi, r.pagu),
        tanggal: k.tanggal,
        jumlahBerkas: k.jumlahUnik + k.lain,
        jumlahUnik: k.jumlahUnik,
        jumlahSalinan: k.salinan,
        link: k.link,
        folderId: k.folderId || idFolderDariLink(k.link),
        berkas: (r.berkas || []).filter((b) => b.spm.rekening === k.kode),
        lainnya: (r.lainnya || []).filter((b) => b.rekening === k.kode),
        salinan: (r.salinan || []).filter((b) => b.spm.rekening === k.kode),
      });
    });
  });

  /* Gulung nilai agregat dari bawah ke atas.
     Catatan: anak bertipe "akun" hanya rincian pemecahan nilai kegiatan
     (bukan nilai tambahan), jadi tidak dijumlahkan ke induknya. */
  const gulung = (nodes) => {
    nodes.forEach((n) => {
      if (n.children.length > 0) {
        gulung(n.children);
        n.children.forEach((c) => {
          if (c.tipe === "akun") return;
          /* Anak berbasis pagu bidang → cukup gabungkan ke peta bidang
             (pagu bidang dijumlahkan SEKALI per bidang, bukan per
             anak). Anak berbasis pagu manual dijumlahkan polos. */
          if (c.bidangPagu && c.bidangPagu.size > 0) {
            n.bidangPagu = n.bidangPagu || new Map();
            c.bidangPagu.forEach((v, bidang) => {
              if ((n.bidangPagu.get(bidang) || 0) < v) {
                n.bidangPagu.set(bidang, v);
              }
            });
          } else {
            n.pagu += c.pagu || 0;
          }
          n.realisasi += c.realisasi || 0;
          n.jumlahBerkas += c.jumlahBerkas || 0;
          n.jumlahKegiatan += c.jumlahKegiatan;
          n.jumlahRekening += c.jumlahRekening;
          if (c.tanggal && (!n.tanggal || c.tanggal > n.tanggal)) {
            n.tanggal = c.tanggal;
          }
        });
      }
      /* Pagu node = pagu manual (dijumlah polos) + pagu bidang yang
         sudah dihapus duplikasinya (tiap bidang hanya dihitung sekali). */
      if (n.bidangPagu && n.bidangPagu.size > 0) {
        let total = 0;
        n.bidangPagu.forEach((v) => {
          total += v;
        });
        n.pagu = (n.pagu || 0) + total;
      }
      n.jumlahKegiatan += n.tipe === "kegiatan" ? 1 : 0;
      n.jumlahRekening += n.tipe === "kegiatan" ? n.children.length : 0;
      if (n.pagu !== null) n.persen = hitungPersen(n.realisasi, n.pagu);
    });
  };
  gulung(akar);

  return akar;
}

/* Ratakan pohon sesuai node yang sedang terbuka */
function flattenPohon(akar, isOpen) {
  const keluar = [];
  const jalan = (nodes) => {
    nodes.forEach((n) => {
      keluar.push(n);
      if (n.children.length > 0 && isOpen(n)) jalan(n.children);
    });
  };
  jalan(akar);
  return keluar;
}

/* ══════════════════════════════════════════════════════════════ */
export default function DataKegiatan({ periode = null }) {
  /* Mode tamu → tabel tetap tampil, tetapi semua kontrol input
     (tambah data, hapus baris) disembunyikan. */
  const { isAdmin } = usePeran();

  /* ── Tampilkan cache dulu agar tabel langsung terlihat ────────
     Hasil pembacaan Drive terakhir disimpan di localStorage
     (src/data/cacheKegiatan.js). Saat halaman dibuka, isi cache
     LANGSUNG dipakai sebagai data awal, jadi tabel tidak perlu
     menunggu penelusuran Drive. Penyegaran dari Drive tetap
     berjalan di belakang layar (muatData) dan mengganti isinya
     begitu selesai. */
  const cacheAwalRef = useRef(null);
  if (cacheAwalRef.current === null) cacheAwalRef.current = bacaCacheKegiatan();
  const adaCache = !!(cacheAwalRef.current && cacheAwalRef.current.rows && cacheAwalRef.current.rows.length);

  const [rows, setRows] = useState(() =>
    adaCache ? cacheAwalRef.current.rows : []
  );
  /* Ref baris terkini — dipakai di dalam muatData untuk menyimpan
     cache / mengecek keberadaan data tanpa memakai setRows sebagai
     efek samping (aman di React StrictMode). */
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const [rekapSheet, setRekapSheet] = useState(() =>
    adaCache ? cacheAwalRef.current.rekapSheet : null
  );
  const rekapSheetData = rekapSheet?.data ?? null;
  const rekapRef = useRef(null);
  useEffect(() => {
    if (rekapSheet?.data) rekapRef.current = rekapSheet.data;
  }, [rekapSheet]);
  /* Pagu per bidang (SDA/CKPS/UPTU) dari tab pertama spreadsheet rekap —
     dipakai mengisi kolom Pagu & Persentase tiap kegiatan. */
  const paguBidangRef = useRef(adaCache ? cacheAwalRef.current.paguBidang : null);

  /* Realisasi SPM dari spreadsheet "Rekap SPM kumulatif per bulan"
     di folder SPJ Drive — dibaca live lewat GVIZ, jadi angkanya
     ikut berubah begitu spreadsheetnya diperbarui. */
  const [rekapSpm, setRekapSpm] = useState(null);
  useEffect(() => dengarRekapSpm(setRekapSpm), []);

  /* `loading` hanya true bila belum ada cache sama sekali — dengan
     cache, tabel langsung tampil dan status diubah menjadi
     "menyegarkan" (progress berjalan) alih-alih layar kosong. */
  const [loading, setLoading] = useState(!adaCache);
  const [menyegarkan, setMenyegarkan] = useState(false);
  const [cacheDipakai, setCacheDipakai] = useState(adaCache);
  const [terakhirMuat, setTerakhirMuat] = useState(
    adaCache ? cacheAwalRef.current.disimpan || 0 : 0
  );
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Filter: draft (isian user) → applied (dipakai tabel)
  /* Filter periode yang dipilih di beranda ("Realisasi Data Per Bulan")
     dipakai sebagai nilai awal filter bulan di halaman ini, lalu tetap
     diperbarui bila pengguna mengganti filter tahun/bulan di beranda.
     Filter bersifat KUMULATIF: dari Januari s.d. bulan terpilih,
     sesuai tab rekap kumulatif di spreadsheet. */
  const rentangBeranda = useMemo(
    () => rentangDariPeriode(periode),
    [periode]
  );
  const dariBeranda = rentangBeranda ? rentangBeranda.dari : "";
  const sampaiBeranda = rentangBeranda ? rentangBeranda.sampai : "";
  const [draft, setDraft] = useState(() => ({
    cari: "",
    dari: dariBeranda,
    sampai: sampaiBeranda,
  }));
  const [applied, setApplied] = useState(() => ({
    cari: "",
    dari: dariBeranda,
    sampai: sampaiBeranda,
  }));

  /* Periode dari beranda berubah → ganti rentang kumulatif tanpa
     menghapus kata kunci pencarian. */
  useEffect(() => {
    if (!sampaiBeranda) return;
    const next = { dari: dariBeranda, sampai: sampaiBeranda };
    setDraft((d) =>
      d.dari === next.dari && d.sampai === next.sampai ? d : { ...d, ...next }
    );
    setApplied((a) =>
      a.dari === next.dari && a.sampai === next.sampai ? a : { ...a, ...next }
    );
  }, [dariBeranda, sampaiBeranda]);

  const [modalTambah, setModalTambah] = useState(false);
  /* Modal daftar bukti laporan SPM (tombol ringkas di kolom Bukti Kerja
     & tombol ringkasan di panel atas). */
  const [modalSpm, setModalSpm] = useState(null);
  /* Status pemuatan ulang REALTIME berkas SPM langsung dari Google Drive
     saat modal bukti dibuka — supaya daftar berkas selalu lengkap. */
  const [modalSpmLive, setModalSpmLive] = useState(null);

  /* Muat ulang berkas SPM langsung dari folder Drive (bukan dari cache).
     `folders`: [{ kode, id?, link? }]; `liveKey` memastikan hasil hanya
     diterapkan ke modal yang masih terbuka. */
  const muatBuktiSpmLive = useCallback(async (liveKey, folders, bulan, baris = []) => {
    const daftarFolder = (folders || []).filter((f) => f && (f.id || f.link));
    if (!liveKey || daftarFolder.length === 0) {
      setModalSpmLive({ memuat: false, galat: "", waktu: null });
      return;
    }
    setModalSpmLive({ memuat: true, galat: "", waktu: null });
    try {
      const hasil = await Promise.all(
        daftarFolder.map(async (f) => {
          const id = f.id || idFolderDariLink(f.link);
          if (!id) return { rek: String(f.kode || "").trim(), files: [] };
          const isi = await listAnak(id);
          return {
            rek: String(f.kode || "").trim(),
            files: isi.filter((x) => x.mimeType !== FOLDER_MIME),
          };
        })
      );
      const bertanda = [];
      const lainnya = [];
      hasil.forEach(({ rek, files }) => {
        files.forEach((file) => {
          const spm = parseBerkasSpm(file.name, rek);
          if (spm) bertanda.push({ ...file, spm, rekening: rek });
          /* Hanya berkas SPM standar (pola SPM_no_rekening_ddmmyy_nilai)
             yang masuk ke bukti laporan SPM. Berkas lain diabaikan. */
        });
      });
      const sudah = new Set();
      const unik = [];
      let salinan = 0;
      bertanda.forEach((b) => {
        const kunci = `${b.spm.noSpm}|${b.spm.rekening}|${b.spm.nilai}`;
        if (sudah.has(kunci)) {
          salinan += 1;
          return;
        }
        sudah.add(kunci);
        unik.push(b);
      });
      unik.sort((a, b) =>
        String(a.spm.tanggal || "").localeCompare(String(b.spm.tanggal || ""))
      );
      /* Hanya ambil berkas PDF yang tanggal SPM-nya masuk bulan yang dipilih
         (format YYYY-MM). Bila filter bulan tidak aktif (bulan kosong),
         tampilkan semua berkas yang bertanggal. Ini memastikan bukti PDF
         yang muncul di modal sesuai dengan SPM berdasarkan kode dan bulan
         yang ditentukan (mis. no SPM 00006 → SPM 6_522112_120126_552780
         hanya muncul saat filter bulan = 2026-01), bukan nilai bukti
         laporan dari bulan lain. */
      const pdf = unik
        .filter((b) => b.spm.tanggal)
        .filter((b) => {
          if (!bulan) return true;
          return String(b.spm.tanggal).slice(0, 7) === bulan;
        })
        .map((b) => ({
          no: b.spm.noSpm,
          rek: b.spm.rekening,
          nilai: b.spm.nilai,
          tgl: b.spm.tanggal,
          nama: b.name,
          link: b.webViewLink,
        }));
      /* Berkas tanpa tanggal tidak ditampilkan di bukti laporan SPM. */
      const pdfTanpaTanggal = [];
      setModalSpm((m) => {
        if (!m || m.liveKey !== liveKey) return m;
        /* Jika ada baris spreadsheet (dari parameter caller), hanya tampilkan
           PDF yang no SPM-nya cocok dengan baris spreadsheet. Bila tidak ada
           baris spreadsheet, tampilkan semua PDF yang lolos filter bulan. */
        const pdfBaris = baris.length
          ? new Set(baris.map((r) => normalNoSpm(r.no)))
          : null;
        const pdfTampil = pdfBaris
          ? pdf.filter((b) => {
              const no = normalNoSpm(b.no);
              return !no || pdfBaris.has(no);
            })
          : pdf;
        return {
          ...m,
          pdf: pdfTampil,
          pdfTanpaTanggal,
          pdfLainnya: [],
          /* Total selalu dari baris spreadsheet (bukan dari PDF Drive)
             agar jumlah nilai sesuai dengan no. SPM yang ditampilkan. */
          total: m.baris && m.baris.length ? m.total : pdfTampil.reduce((s, b) => s + (b.nilai || 0), 0),
        };
      });
      setModalSpmLive({
        memuat: false,
        galat: "",
        waktu: Date.now(),
        jumlahBerkas: baris.length || pdf.length,
        salinan,
      });
    } catch (e) {
      setModalSpmLive({
        memuat: false,
        galat: String((e && e.message) || e),
        waktu: null,
      });
    }
  }, []);

  /* Saat modal ditutup, bersihkan status realtime. */
  useEffect(() => {
    if (!modalSpm) setModalSpmLive(null);
  }, [modalSpm]);
  const [formTambah, setFormTambah] = useState({
    segmen: [], // diisi satu per satu: ["7769","AFA","001","100","A"]
    nama: "",
  });
  /* Hasil pembacaan folder/berkas yang dijatuhkan di modal Tambah Data:
     kode/nama kegiatan, daftar berkas, dan realisasi per bulan. */
  const [analisaTambah, setAnalisaTambah] = useState(null);
  const [menganalisaTambah, setMenganalisaTambah] = useState(false);
  /* Status area drag & drop pada modal "Tambah Data" (khusus admin):
     sedang ada berkas yang ditarik di atas area, dan pesan kesalahan. */
  const [dragTambah, setDragTambah] = useState(false);
  const [pesanFileTambah, setPesanFileTambah] = useState("");
  const [subFolderRekening, setSubFolderRekening] = useState("");
  const [daftarRekening, setDaftarRekening] = useState([]);
  const [statusUpload, setStatusUpload] = useState(null);
  const [santaiUpload, setSantaiUpload] = useState(false);
  const [tambahan, setTambahan] = useState([]);

  // Pohon hierarkis: node mana yang sedang dibuka.
  // Default SEMUA TERBUKA supaya baris Kode Kegiatan beserta bukti
  // laporan SPM-nya langsung terlihat tanpa perlu klik induk/cabang.
  const [terbuka, setTerbuka] = useState({});
  const [semuaBuka, setSemuaBuka] = useState(true);
  const [tampilkanSpark, setTampilkanSpark] = useState(true);

  const isOpen = useCallback(
    (node) =>
      semuaBuka
        ? true
        : terbuka[node.key] !== undefined
        ? terbuka[node.key]
        : node.depth < 1,
    [terbuka, semuaBuka]
  );

  const toggleNode = useCallback(
    (node) => {
      const next = !isOpen(node);
      setSemuaBuka(false);
      setTerbuka((prev) => ({ ...prev, [node.key]: next }));
    },
    [isOpen]
  );

  /* Data tambahan yang diinput admin — lewat toko data bersama
     (src/data/KegiatanTambahan.js) supaya halaman tamu ikut berubah
     begitu baris baru ditambah, termasuk dari tab lain. */
  useEffect(() => dengarKegiatanTambahan(setTambahan), []);

  /* Saat halaman dibuka, coba juga ambil data dari Drive sebagai
     sumber sinkronisasi. Data Drive hanya dipakai bila localStorage
     belum ada data sama sekali, sehingga perubahan lokal tidak
     tertimpa. */
  useEffect(() => {
    let abaikan = false;
    (async () => {
      const dariDrive = await muatDataTambahanDariDrive();
      if (abaikan) return;
      if (dariDrive && dariDrive.length > 0) {
        const lokal = bacaKegiatanTambahan();
        if (!lokal || lokal.length === 0) {
          setTambahan(dariDrive);
        }
      }
    })();
    return () => {
      abaikan = true;
    };
  }, []);

  const tampilkanToast = useCallback((pesan) => {
    setToast(pesan);
    setTimeout(() => setToast(null), 3500);
  }, []);

  /* ── Muat data kegiatan dari Drive (2 tahap) ────────────────
     Bila cache sudah terisi, tabel LANGSUNG tampil seketika (0 detik);
     statusnya "menyegarkan" di latar belakang tanpa mengosongkan tabel.
     Bila belum ada cache, Tahap 1 langsung menampilkan kegiatan dalam
     ~1 detik, lalu Tahap 2 melengkapi rincian rekening & berkas. */
  const muatData = useCallback(async (paksa = false) => {
    setError(null);
    setProgress(0);
    /* Hanya tampilkan status memuat (layar kosong) bila belum ada
       data sama sekali — kalau cache sudah mengisi tabel, pengguna
       langsung melihat tabel. */
    if (rowsRef.current.length === 0) setLoading(true);
    setMenyegarkan(true);

    try {
      const res = await muatDataKegiatanDariDrive({
        barisTerdahulu: rowsRef.current,
        onTahapSatu: ({ folders, rekapSheet: rs, paguBidang: pb }) => {
          // Begitu folder kegiatan dari Drive terbaca (~1 detik),
          // LANGSUNG tampilkan ke tabel! Jangan menunggu Tahap 2 selesai.
          setRows(folders);
          if (rs) {
            setRekapSheet(rs);
            rekapRef.current = rs.data;
          }
          if (pb) {
            paguBidangRef.current = pb;
          }
          setLoading(false);
        },
        onProgress: (selesai, total, rowTerbaru) => {
          setProgress(selesai);
          setRows((prev) =>
            prev.map((r) => (r.id === rowTerbaru.id ? { ...r, ...rowTerbaru } : r))
          );
        },
      });

      if (res && res.rows) {
        setRows(res.rows);
        if (res.rekapSheet) {
          setRekapSheet(res.rekapSheet);
          rekapRef.current = res.rekapSheet.data;
        }
        if (res.paguBidang) {
          paguBidangRef.current = res.paguBidang;
        }
      }
      setTerakhirMuat(Date.now());
      setLoading(false);
      setMenyegarkan(false);
      setCacheDipakai(false);
    } catch (e) {
      console.error("Gagal memuat Data Kegiatan:", e);
      if (rowsRef.current.length > 0) {
        setError(
          "Gagal menyegarkan data dari Google Drive. Menampilkan data tersimpan terakhir."
        );
      } else {
        setError(
          "Gagal mengambil data kegiatan dari Google Drive. Periksa koneksi internet atau API Key."
        );
      }
      setLoading(false);
      setMenyegarkan(false);
    }
  }, []);

  // Saat halaman dibuka: jika cache masih segar, langsung gunakan data cache
  // tanpa menunggu penelusuran ulang Google Drive.
  useEffect(() => {
    const cache = bacaCacheKegiatan();
    if (cacheMasihSegar(cache)) {
      setCacheDipakai(true);
      setMenyegarkan(false);
      setLoading(false);
      return;
    }
    muatData(false);
  }, [muatData]);

  /* Realtime: "Realisasi SPM" disegarkan tiap menit (paksa baca ulang)
     selama halaman ini terbuka, supaya angka di sebelah Persentase
     ikut berubah begitu spreadsheet di Drive diperbarui. */
  useEffect(() => {
    const id = setInterval(() => {
      ambilRekapSpm(API_KEY, true).catch((e) =>
        console.warn("Gagal menyegarkan Realisasi SPM:", e)
      );
    }, 60000);
    return () => clearInterval(id);
  }, []);

  /* Bekalkan rekap per bulan ke modul rekap bersama supaya kartu
     "Realisasi Bulan" di Dashboard memakai angka yang sama — tanpa
     perlu menelusuri folder Drive untuk kedua kalinya. */
  useEffect(() => {
    if (loading) return;
    terbitkanPerBulanDrive(rekapPerBulanDariBaris(rows), rows.length);
  }, [rows, loading]);

  // Re-fetch saat ada berkas yang berubah di aplikasi / tab regain focus.
  // Saat tab kembali fokus, penelusuran Drive hanya dijalankan bila
  // data terakhir sudah lewat batas "segar" — supaya perpindahan tab
  // tidak memicu pembacaan Drive yang lama.
  useEffect(() => {
    const onUpdate = () => muatData(true);
    const onFocus = () => {
      if (cacheMasihSegar(bacaCacheKegiatan())) return;
      muatData(false);
    };
    window.addEventListener("pu_files_updated", onUpdate);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("pu_files_updated", onUpdate);
      window.removeEventListener("focus", onFocus);
    };
  }, [muatData]);

  /* ── Gabungkan baris dari Drive + baris yang ditambahkan user ──
     Bila kegiatan hasil impor folder sudah ada di Drive (folder baru
     selesai diunggah/dibaca ulang), JANGAN tampilkan dua baris: data
     impor digabung ke baris Drive-nya. */
  const semuaRows = useMemo(() => {
    const petaLokal = new Map();
    (tambahan || []).forEach((t) => {
      if (t && t.kode) petaLokal.set(kunciKode(t.kode), t);
    });

    const rowsDrive = (rows || []).map((r) => {
      const t = petaLokal.get(kunciKode(r.kode));
      if (!t) return r;
      petaLokal.delete(kunciKode(r.kode));

      const berkas = gabungBerkasUnik(r.berkas, t.berkas);
      const lainnya = gabungBerkasUnik(r.lainnya, t.lainnya);
      const impor = Boolean(
        t.imporFolder ||
          (t.realisasiPerBulan && Object.keys(t.realisasiPerBulan).length)
      );
      if (!impor && berkas.length === 0 && lainnya.length === 0) return r;

      const totalImpor =
        Number(t.realisasi) ||
        Object.values(t.realisasiPerBulan || {}).reduce(
          (a, b) => a + (Number(b) || 0),
          0
        );

      const rekening = [...(r.rekening || [])];
      const sudahRek = new Set(
        rekening.map((k) => (k && typeof k === "object" ? k.kode : k))
      );
      rekeningDariBerkas(t.berkas).forEach((k) => {
        if (!sudahRek.has(k.kode)) {
          rekening.push(k);
          sudahRek.add(k.kode);
        }
      });

      return {
        ...r,
        ...(impor
          ? {
              realisasi: totalImpor,
              realisasiPerBulan: t.realisasiPerBulan || null,
              sumberRealisasi: t.sumberRealisasi || r.sumberRealisasi,
            }
          : {}),
        berkas,
        lainnya,
        rekening,
        jumlahBerkas: Math.max(
          Number(r.jumlahBerkas) || 0,
          Number(t.jumlahBerkas) || 0,
          (t.berkas || []).length
        ),
        lokalImpor: impor,
      };
    });

    const extra = [...petaLokal.values()].map((t) => {
      const berkas = t.berkas || [];
      return {
        id: `local_${t.kode}`,
        kode: t.kode,
        nama: t.nama,
        folderNama: null,
        link: null,
        pagu: Number(t.pagu) || 0,
        realisasi: Number(t.realisasi) || 0,
        persen: hitungPersen(t.realisasi, t.pagu),
        tanggal: t.tanggal || null,
        jumlahBerkas: Number(t.jumlahBerkas) || berkas.length,
        rekening: rekeningDariBerkas(berkas),
        berkas,
        lainnya: t.lainnya || [],
        salinan: [],
        realisasiPerBulan: t.realisasiPerBulan || null,
        sumberRealisasi: t.sumberRealisasi || "",
        lokal: true,
        imporFolder: Boolean(t.imporFolder),
      };
    });

    return [...rowsDrive, ...extra].sort((a, b) =>
      String(a.kode).localeCompare(String(b.kode), "id")
    );
  }, [rows, tambahan]);

  /* ── Saran kode kegiatan per level (dari kode di Drive) ──── */
  const saranSegmen = useMemo(() => bangunSaranSegmen(semuaRows), [semuaRows]);

  /* Kode gabungan dari kotak-kotak segmen yang sudah diisi. */
  const kodeGabung = useMemo(
    () =>
      formTambah.segmen
        .map((s) => String(s || "").trim().toUpperCase())
        .filter(Boolean)
        .join("."),
    [formTambah.segmen]
  );

  const saranNama = useMemo(
    () => sarankanNama(semuaRows, kodeGabung),
    [semuaRows, kodeGabung]
  );

  /* Jumlah kotak = jumlah level terpanjang di Drive, minimal 4. */
  const jumlahLevel = useMemo(() => {
    const maks = semuaRows.reduce((m, r) => {
      const n = String(r.kode || "")
        .split(".")
        .filter(Boolean).length;
      return Math.max(m, n);
    }, 0);
    return Math.max(4, Math.min(maks || 5, 6));
  }, [semuaRows]);

  /* Isi satu kotak segmen (satu per satu).
     Bila sebuah kotak dikosongkan, kotak setelahnya ikut dibersihkan
     supaya level berikutnya diketik ulang dari awal. */
  const ubahSegmen = useCallback((index, nilaiBaru) => {
    setFormTambah((lama) => {
      const segmen = lama.segmen.slice(0, index + 1);
      while (segmen.length < index + 1) segmen.push("");
      segmen[index] = nilaiBaru.toUpperCase();
      // Bila kotak ini dikosongkan, level setelahnya dibuang.
      const bersih =
        String(segmen[index] || "").trim() === ""
          ? segmen.slice(0, index)
          : segmen;
      return { ...lama, segmen: bersih };
    });
  }, []);

  /* ── Realisasi SPM dari spreadsheet rekap bulanan ───────────
     Bulan patokan diambil dari batas AKHIR filter kumulatif "s.d." di
     toolbar (format YYYY-MM). Kalau bulan itu belum punya tab di
     spreadsheet, datanya dianggap KOSONG ("—") — tidak menyalin angka
     bulan sebelumnya. Kalau filter kosong, pakai bulan terakhir yang
     benar-benar punya tab di spreadsheet, bukan bulan terakhir
     kalender. */
  const bulanRekapSpm = useMemo(() => {
    const perBulan = (rekapSpm && rekapSpm.perBulan) || {};
    const dariSampai = bulanIdDariYm(applied.sampai);
    if (dariSampai) return perBulan[dariSampai] ? dariSampai : null;
    return bulanTerakhirDenganData(rekapSpm);
  }, [rekapSpm, applied.sampai]);

  const rekapSpmBulan = useMemo(
    () => rekapRealisasiSpm(rekapSpm, TAHUN_ANGGARAN_AKTIF, bulanRekapSpm),
    [rekapSpm, bulanRekapSpm]
  );

  /* ── Laporan SPM bulan terpilih (sesuai tab spreadsheet) ────
     Saat filter bulan aktif, ringkas laporan SPM dari spreadsheet
     "Rekap SPM kumulatif per bulan":
       · `kumulatif` — angka kumulatif s.d. bulan itu (isi tab-nya);
       · `bulanIni`  — realisasi khusus bulan itu (selisih kumulatif
                       bulan ini − bulan sebelumnya);
       · `tab` / `label` — nama tab & label bulan sumbernya.
     Angka ini diambil langsung dari tab bulan terkait, bukan dari
     penjumlahan berkas PDF. */
  const laporanSpmBulan = rekapSpmBulan;

  /* ── LEDGER SPM (bukti laporan SPM dari spreadsheet) ────────
     Bukti laporan SPM diambil dari tab "Rekap SPM kumulatif per
     bulan" — tab yang BERKUMPULATIF sejak Januari, jadi nilainya
     adalah kumulatif s.d. bulan yang dipilih (tab "Jan" untuk
     Januari, "Jan-Agst" untuk Agustus, dst). Setiap baris ledger
     = satu SPM (No. SPM, rekening, TANGGAL, nilai) sehingga:
       · kolom Realisasi & bukti SPM memakai sumber yang sama;
       · "realisasi bulan ini" bisa dihitung dari tanggal SPM-nya. */
  const tabLedgerSpm =
    rekapSpm && rekapSpm.perBulan && bulanRekapSpm
      ? (rekapSpm.perBulan[bulanRekapSpm] || {}).tab || null
      : null;
  const [ledgerSpm, setLedgerSpm] = useState(null); // {tabNama, per(Map), jumlahSpm, total}
  useEffect(() => {
    let batal = false;
    if (!tabLedgerSpm) {
      setLedgerSpm(null);
      return;
    }
    ambilLedgerSpm({ tabNama: tabLedgerSpm }).then((hasil) => {
      if (!batal) setLedgerSpm(hasil);
    });
    return () => {
      batal = true;
    };
  }, [tabLedgerSpm]);

  /* Nomor bulan patokan (1…12) untuk menandai "SPM bulan ini". */
  const nomorBulanRekap = useMemo(
    () => nomorBulanDariId(bulanRekapSpm),
    [bulanRekapSpm]
  );

  /* Realisasi KHUSUS bulan patokan — dihitung dari tanggal SPM pada
     ledger (bukan selisih total GVIZ), jadi selalu pas dengan daftar
     buktinya. */
  const ledgerBulanIni = useMemo(() => {
    if (!ledgerSpm || !nomorBulanRekap) return { jumlah: 0, nilai: 0 };
    let jumlah = 0;
    let nilai = 0;
    ledgerSpm.per.forEach((blok) => {
      blok.rows.forEach((r) => {
        if (!r.tanggal) return;
        if (Number(String(r.tanggal).slice(5, 7)) !== nomorBulanRekap) return;
        jumlah += 1;
        nilai += r.nilai || 0;
      });
    });
    return { jumlah, nilai };
  }, [ledgerSpm, nomorBulanRekap]);


  /* Baris ledger yang SESUAI filter kumulatif (dari–sampai) — inilah yang
     ditampilkan langsung di kolom Bukti Kerja. Tanpa filter → seluruh
     baris kumulatif tab. */
  const ledgerTerpilihIndex = useMemo(() => {
    const peta = new Map();
    if (!ledgerSpm) return peta;
    const dari = applied.dari;
    const sampai = applied.sampai;
    ledgerSpm.per.forEach((blok, kode) => {
      const rows =
        dari || sampai
          ? blok.rows.filter((r) => {
              const ym = r.tanggal ? String(r.tanggal).slice(0, 7) : null;
              if (!ym) return false;
              return (!dari || ym >= dari) && (!sampai || ym <= sampai);
            })
          : blok.rows;
      if (!rows.length) return;
      const isi = {
        kode,
        rows,
        total: rows.reduce((s, r) => s + (r.nilai || 0), 0),
      };
      if (!peta.has(kode)) peta.set(kode, isi);
      const k = kunciKode(kode);
      if (!peta.has(k)) peta.set(k, isi);
    });
    return peta;
  }, [ledgerSpm, applied.dari, applied.sampai]);

  const ledgerTerpilihPilih = useCallback(
    (kode) => {
      if (!ledgerSpm || !kode) return null;
      return (
        ledgerTerpilihIndex.get(kode) ||
        ledgerTerpilihIndex.get(kunciKode(kode)) ||
        null
      );
    },
    [ledgerSpm, ledgerTerpilihIndex]
  );

  /* Indeks ledger TANPA filter bulan — khusus untuk pencarian. Supaya
     kode akun belanja (rekening) yang hanya ada di spreadsheet tetap
     bisa ditemukan walau bulan yang dipilih tidak memuat barisnya. */
  const ledgerSemuaIndex = useMemo(() => {
    const peta = new Map();
    if (!ledgerSpm) return peta;
    ledgerSpm.per.forEach((blok, kode) => {
      if (!peta.has(kode)) peta.set(kode, blok);
      const k = kunciKode(kode);
      if (!peta.has(k)) peta.set(k, blok);
    });
    return peta;
  }, [ledgerSpm]);

  const ledgerSemuaPilih = useCallback(
    (kode) => {
      if (!ledgerSpm || !kode) return null;
      return ledgerSemuaIndex.get(kode) || ledgerSemuaIndex.get(kunciKode(kode)) || null;
    },
    [ledgerSpm, ledgerSemuaIndex]
  );
  const ledgerTabNama = ledgerSpm ? ledgerSpm.tabNama : tabLedgerSpm;
  /* Pecahan bukti ledger per kode akun belanja: Map(kode kegiatan →
     Map(rekening → {jumlah, total})). Sumbernya baris yang sama dengan
     badge "📎 N berkas · Rp X" pada baris Kode Kegiatan, sehingga baris
     Kode Akun Belanja di bawahnya bisa memecah jumlah berkas tersebut
     ke dalam kode belanja masing-masing. */
  const buktiPerRekening = useMemo(() => {
    const peta = new Map(); // kunciKode(kegiatan) → Map(rekening → …)
    if (!ledgerSpm) return peta;
    const dari = applied.dari;
    const sampai = applied.sampai;
    ledgerSpm.per.forEach((blok, kode) => {
      const rows =
        dari || sampai
          ? blok.rows.filter((r) => {
              const ym = r.tanggal ? String(r.tanggal).slice(0, 7) : null;
              if (!ym) return false;
              return (!dari || ym >= dari) && (!sampai || ym <= sampai);
            })
          : blok.rows;
      if (!rows.length) return;
      rows.forEach((r) => {
        const rek = String(r.rekening || "").trim();
        if (!rek) return;
        const kunci = kunciKode(kode);
        let per = peta.get(kunci);
        if (!per) {
          per = new Map();
          peta.set(kunci, per);
        }
        const e = per.get(rek) || { jumlah: 0, total: 0 };
        e.jumlah += 1;
        e.total += r.nilai || 0;
        per.set(rek, e);
      });
    });
    return peta;
  }, [ledgerSpm, applied.dari, applied.sampai]);
  const filterBulanAktif = Boolean(applied.dari || applied.sampai);
  /* ── Terapkan filter ────────────────────────────────────── */
  const tabelRows = useMemo(() => {
    const q = applied.cari.trim();
    return semuaRows.filter((r) => {
      if (q) {
        /* Cocokkan ke kode kegiatan, nama kegiatan, dan kode/nama akun
           belanja. Data yang diinput lewat "+ Tambah Data" ikut karena
           berada di `semuaRows` yang sama. */
        const nilaiCari = [r.kode, r.nama, r.folderNama].concat(
          nilaiRekeningUntukCari(r)
        );
        /* Kode akun belanja dari ledger SPM + KODE LENGKAP (kode
           kegiatan + kode akun). Kode lengkap inilah yang tampil di
           kolom "Kode Lengkap" pada mode hasil pencarian — contoh
           7769.AFA.001.100.A.521211 — sehingga harus ikut dicocokkan
           walau folder rekeningnya tidak ada di Drive. */
        const akun = new Set();
        (r.rekening || []).forEach((k) => {
          const kodeAkun = k && typeof k === "object" ? k.kode : k;
          if (kodeAkun) akun.add(String(kodeAkun).trim());
        });
        const blokSemua = ledgerSemuaPilih(r.kode);
        const barisLedger = blokSemua && blokSemua.rows ? blokSemua.rows : [];
        barisLedger.forEach((b) => {
          const kodeAkun = String((b && b.rekening) || "").trim();
          if (kodeAkun) akun.add(kodeAkun);
        });
        akun.forEach((kodeAkun) => {
          nilaiCari.push(
            kodeAkun,
            namaRekening(kodeAkun),
            `${r.kode}.${kodeAkun}`
          );
        });
        if (!cocokCari(q, ...nilaiCari)) return false;
      }
      /* Filter bulan-tahun (YYYY-MM). Sebuah kegiatan dianggap cocok
         bila ADA berkas SPM-nya yang bertanggal pada rentang bulan
         itu — bukan hanya tanggal SPM terakhirnya — supaya bukti
         laporan SPM per kode kegiatan tidak hilang dari tabel.
         Baris tanpa berkas (mis. input manual) tetap dibandingkan
         lewat tanggal barisnya. */
      if (!applied.dari && !applied.sampai) return true;

      const dalamRentang = (ym) =>
        !!ym &&
        (!applied.dari || ym >= applied.dari) &&
        (!applied.sampai || ym <= applied.sampai);

      const bulanBerkas = (r.berkas || [])
        .map((b) => bulanIso(b && b.spm ? b.spm.tanggal : null))
        .filter(Boolean);
      const bulanImpor = Object.keys(r.realisasiPerBulan || {});
      if (bulanBerkas.length > 0 || bulanImpor.length > 0) {
        return (
          bulanBerkas.some(dalamRentang) || bulanImpor.some(dalamRentang)
        );
      }
      return dalamRentang(bulanIso(r.tanggal));
    });
  }, [semuaRows, applied, ledgerSemuaPilih]);

  /* Realisasi per kode kegiatan dari LEDGER spreadsheet (sumber yang
     sama dengan bukti laporan SPM) — supaya kolom Realisasi dan
     bukti SPMnya selalu cocok. Bila kegiatan tidak ada di ledger,
     dipakai angka-realisasi bawaan (rekap GVIZ / berkas Drive). */
  const realisasiLedger = useMemo(() => {
    const peta = new Map();
    if (!ledgerSpm) return peta;
    ledgerSpm.per.forEach((blok, kode) => {
      const total = blok.rows.reduce((s, r) => s + (r.nilai || 0), 0);
      peta.set(kunciKode(kode), total);
    });
    return peta;
  }, [ledgerSpm]);

  const realisasiBaris = useCallback(
    (r) => {
      /* Data impor folder punya rincian per bulan. Saat filter bulan
         aktif, jumlahkan HANYA bulan yang masuk rentang — bukan total
         seluruh tahun. */
      if (r.realisasiPerBulan && Object.keys(r.realisasiPerBulan).length) {
        return Object.entries(r.realisasiPerBulan).reduce((total, [ym, n]) => {
          if (applied.dari && ym < applied.dari) return total;
          if (applied.sampai && ym > applied.sampai) return total;
          return total + (Number(n) || 0);
        }, 0);
      }
      const v = realisasiLedger.get(kunciKode(r.kode));
      return typeof v === "number" ? v : r.realisasi || 0;
    },
    [realisasiLedger, applied.dari, applied.sampai]
  );

  /* ── Pohon hierarkis (kode induk → cabang → detail → akun) ── */
  const pohon = useMemo(
    () => bangunPohon(tabelRows, rekapSheetData, realisasiBaris),
    [tabelRows, rekapSheetData, realisasiBaris]
  );
  /* Tampilan Tree View saat difilter: langsung dari Kode Kegiatan ke
     Kode Akun Belanja (contoh: 7769.AFA.001.100.A → 521211, 522111, dst.),
     tanpa level induk/cabang/detail di atasnya. Hanya kode akun belanja
     yang memiliki berkas/bukti sesuai spreadsheet (ledger SPM periode)
     yang ditampilkan. Bila belum difilter, struktur pohon tetap seperti
     sebelumnya. */
  const pohonFilterTampil = useMemo(() => {
    const keluar = [];
    const ambilKegiatan = (nodes) => {
      (nodes || []).forEach((n) => {
        if (n.tipe === "kegiatan") {
          const per = buktiPerRekening.get(kunciKode(n.kode || n.induk || ""));
          const akun = (n.children || [])
            .filter((c) => c.tipe === "akun")
            .filter((c) => {
              if (!per) return false;
              const e = per.get(String(c.kode || "").trim());
              return e && (Number(e.jumlah) || 0) > 0;
            })
            .map((c) => ({ ...c, depth: 1 }));
          if (akun.length > 0) {
            keluar.push({
              ...n,
              depth: 0,
              children: akun,
            });
          }
          return;
        }
        if (n.children && n.children.length) ambilKegiatan(n.children);
      });
    };
    ambilKegiatan(pohon);
    return keluar;
  }, [pohon, buktiPerRekening]);
  const sedangDifilter = Boolean(applied.cari.trim() || applied.dari || applied.sampai);
  const pohonTampilAktif = sedangDifilter ? pohonFilterTampil : pohon;
  const barisTampil = useMemo(
    () => flattenPohon(pohonTampilAktif, isOpen),
    [pohonTampilAktif, isOpen]
  );

  const bukaSemua = () => {
    setSemuaBuka(true);
    setTerbuka({});
  };

  const tutupSemua = () => {
    const kunci = [];
    const kumpulkan = (nodes) =>
      nodes.forEach((n) => {
        if (n.children.length > 0) {
          kunci.push(n.key);
          kumpulkan(n.children);
        }
      });
    kumpulkan(pohonTampilAktif);
    setSemuaBuka(false);
    setTerbuka(kunci.reduce((a, k) => ({ ...a, [k]: false }), {}));
  };

  /* Total pagu: pagu per kegiatan berasal dari pagu bidangnya, jadi
     jumlahkan tiap bidang SEKALI (banyak kegiatan berbagi pagu bidang
     yang sama). Pagu manual (tanpa bidang) dijumlahkan polos. */
  const totalPagu = (() => {
    const perBidang = new Map();
    let manual = 0;
    tabelRows.forEach((r) => {
      const v = Number(r.pagu) || 0;
      if (r.bidang && v > 0) {
        if ((perBidang.get(r.bidang) || 0) < v) perBidang.set(r.bidang, v);
      } else {
        manual += v;
      }
    });
    let total = manual;
    perBidang.forEach((v) => {
      total += v;
    });
    return total;
  })();
  const totalRealisasi = tabelRows.reduce((s, r) => s + realisasiBaris(r), 0);
  const totalBerkas = useMemo(() => {
    const filterAktif = Boolean(applied.dari || applied.sampai);
    return tabelRows.reduce((s, r) => {
      if (!filterAktif) return s + (r.jumlahBerkas || 0);
      if (Array.isArray(r.berkas) && r.berkas.length > 0) {
        const dalamRentang = r.berkas.filter((b) => {
          const ym = bulanIso(b && b.spm ? b.spm.tanggal : null);
          return (
            !!ym &&
            (!applied.dari || ym >= applied.dari) &&
            (!applied.sampai || ym <= applied.sampai)
          );
        }).length;
        return s + dalamRentang;
      }
      return s + (r.jumlahBerkas || 0);
    }, 0);
  }, [tabelRows, applied.dari, applied.sampai]);

  /* ── Ringkasan bulan untuk kotak filter ─────────────────────
     Supaya jelas "data mana yang terhubung" dengan bulan yang
     dipilih, dihitung dari hasil filter:
       · bulanAktif  — daftar bulan (YYYY-MM) yang benar-benar ada
                       di data, beserta jumlah kegiatannya (untuk chips);
       · ringkasBulan — jumlah kegiatan / realisasi / berkas yang
                       LOLOS filter bulan aktif.
     Bulan dihitung dari SEMUA tanggal berkas SPM (bukan hanya tanggal
     SPM terakhir tiap kegiatan) — supaya bulan yang bukan "bulan
     terakhir" kegiatan mana pun (mis. Januari yang berkasnya sudah
     tertutup berkas bulan-bulan berikutnya) tetap muncul sebagai chip
     dan menghasilkan bukti laporan SPM saat difilter.
     Hanya tanggal valid yang dihitung (bulanIso mengembalikan null
     untuk tanggal kosong/tidak valid). */
  const bulanTersedia = useMemo(() => {
    const perBulan = new Map();
    const ambil = (m) => {
      let isi = perBulan.get(m);
      if (!isi) {
        isi = { bulan: m, kegiatan: new Set(), realisasi: 0, berkas: 0 };
        perBulan.set(m, isi);
      }
      return isi;
    };
    semuaRows.forEach((r) => {
      const perBulanImpor =
        r.realisasiPerBulan && Object.keys(r.realisasiPerBulan).length
          ? r.realisasiPerBulan
          : null;
      if (perBulanImpor) {
        /* Impor folder: angka realisasi per bulan sudah pasti. Bukti
           PDF dihitung per bulannya untuk chip "N berkas". */
        Object.entries(perBulanImpor).forEach(([m, nilai]) => {
          if (!/^\d{4}-\d{2}$/.test(m)) return;
          const isi = ambil(m);
          isi.kegiatan.add(r.kode);
          isi.realisasi += Number(nilai) || 0;
        });
        (r.berkas || []).forEach((b) => {
          if (!b || !b.spm || !b.spm.tanggal) return;
          const m = bulanIso(b.spm.tanggal);
          if (m) ambil(m).berkas += 1;
        });
        return;
      }

      const daftar = (r.berkas || []).filter(
        (b) => b && b.spm && b.spm.tanggal
      );
      if (daftar.length) {
        daftar.forEach((b) => {
          const m = bulanIso(b.spm.tanggal);
          if (!m) return;
          const isi = ambil(m);
          isi.kegiatan.add(r.kode);
          isi.realisasi += b.spm.nilai || 0;
          isi.berkas += 1;
        });
      } else {
        /* Baris tanpa berkas (mis. input manual) → pakai tanggal baris. */
        const m = bulanIso(r.tanggal);
        if (!m) return;
        const isi = ambil(m);
        isi.kegiatan.add(r.kode);
        isi.realisasi += r.realisasi || 0;
        isi.berkas += r.jumlahBerkas || 0;
      }
    });
    return [...perBulan.values()]
      .map((isi) => ({
        bulan: isi.bulan,
        jumlah: isi.kegiatan.size,
        realisasi: isi.realisasi,
        berkas: isi.berkas,
      }))
      .sort((a, b) => a.bulan.localeCompare(b.bulan));
  }, [semuaRows]);

  /* Data semua 12 bulan untuk sparkline filter: gabungkan bulan yang
     punya data dengan bulan kosong (jumlah 0), supaya batang tampil
     lengkap dari Januari sampai Desember. Tahun diambil dari filter
     aktif (applied.sampai) atau dari bulan pertama yang punya data,
     atau tahun sekarang sebagai cadangan. */
  const tahunSpark = useMemo(() => {
    if (applied.sampai) return String(applied.sampai).slice(0, 4);
    if (bulanTersedia.length > 0) return String(bulanTersedia[0].bulan).slice(0, 4);
    return String(new Date().getFullYear());
  }, [applied.sampai, bulanTersedia]);

  const petaJumlah = useMemo(() => {
    const p = new Map();
    bulanTersedia.forEach((b) => p.set(b.bulan, b.jumlah));
    return p;
  }, [bulanTersedia]);

  const bulanSemua = useMemo(() => {
    const hasil = [];
    for (let i = 1; i <= 12; i++) {
      const ym = `${tahunSpark}-${String(i).padStart(2, "0")}`;
      hasil.push({
        bulan: ym,
        labelSingkat: NAMA_BULAN_SINGKAT[i - 1],
        jumlah: petaJumlah.get(ym) || 0,
      });
    }
    return hasil;
  }, [tahunSpark, petaJumlah]);

  const maxJumlah = useMemo(
    () => Math.max(...bulanSemua.map((b) => b.jumlah), 1),
    [bulanSemua]
  );


  const ringkasBulan = useMemo(
    () => ({
      jumlah: tabelRows.length,
      realisasi: totalRealisasi,
      berkas: totalBerkas,
    }),
    [tabelRows, totalRealisasi, totalBerkas]
  );

  /* Pilih satu bulan dari chips: kumulatif dari Januari s.d. bulan itu.
     Klik bulan yang sama melepas filter. */
  const pilihBulan = useCallback((bulan) => {
    const sudahSama = applied.sampai === bulan && applied.dari === String(bulan || "").slice(0, 4) + "-01";
    const tahun = String(bulan || "").slice(0, 4);
    const baru = sudahSama || !bulan
      ? { ...applied, dari: "", sampai: "" }
      : { ...applied, dari: `${tahun}-01`, sampai: bulan };
    setDraft(baru);
    setApplied(baru);
  }, [applied]);



  /* Label periode filter (rentang kumulatif dari–sampai) — dipakai untuk judul
     kolom Bukti Kerja, tombol, dan modal bukti laporan SPM. */
  const periodeFilterLabel = filterBulanAktif
    ? labelPeriodeBulan(applied.dari, applied.sampai)
    : "";

  /* Daftar bukti kerja SPM (PDF dari Drive) yang tanggal SPM-nya masuk
     RENTANG bulan terpilih (dari s/d sampai) — bukan hanya satu bulan —
     supaya totalnya cocok dengan angka realisasi kumulatif.
     Hanya berkas dengan tanggal valid yang ikut; nilai diambil apa
     adanya dari nama berkas (bukan sumber angka realisasi). */




  /* SPM tanpa tanggal & berkas lain dari SEMUA baris tab aktif —
     dipakai panel "Bukti Laporan SPM" supaya bukti PDF yang pola nama-
     nya tidak sesuai (tak bisa dipetakan ke bulan) tetap bisa
     diperiksa, bukan sembunyi diam-diam. */


  /* Seluruh baris ledger (per kode kegiatan) untuk modal rekapan
     bulan gabungan. */


  /* Baris ledger (SEMUA kegiatan) untuk rentang filter — dipakai panel
     ringkasan di atas tabel. */
  const ledgerBarisPeriode = useMemo(() => {
    if (!ledgerSpm) return [];
    const dari = applied.dari;
    const sampai = applied.sampai;
    const keluar = [];
    ledgerSpm.per.forEach((blok, kode) => {
      blok.rows.forEach((r) => {
        if (dari || sampai) {
          const ym = r.tanggal ? String(r.tanggal).slice(0, 7) : null;
          if (!ym) return;
          if ((dari && ym < dari) || (sampai && ym > sampai)) return;
        }
        keluar.push({ ...r, kegiatanKode: kode });
      });
    });
    return keluar;
  }, [ledgerSpm, applied.dari, applied.sampai]);

  const ledgerPeriodeTotal = useMemo(
    () => ledgerBarisPeriode.reduce((s, r) => s + (r.nilai || 0), 0),
    [ledgerBarisPeriode]
  );

  /* ── Bukti laporan SPM per KODE KEGIATAN ─────────────────────
     Untuk tombol ringkas di kolom "Bukti Kerja", dikelompokkan
     menurut kode kegiatan:
       berkasPerKegiatan : Map(kode kegiatan → daftar berkas SPM)
       nilaiPerKegiatan  : Map(kode kegiatan → jumlah nilai berkas)
     Saat filter bulan aktif → berkas yang tanggalnya masuk rentang
     dari s/d sampai (kumulatif, cocok dengan angka realisasi);
     bila tidak → seluruh berkas SPM kegiatan tersebut. */
  const berkasPerKegiatan = useMemo(() => {
    const peta = new Map();
    const dari = applied.sampai;
    const sampai = applied.sampai;
    const dalamRentang = (ym) => {
      const m = ym ? String(ym).slice(0, 7) : null;
      return !!m && (!dari || m >= dari) && (!sampai || m <= sampai);
    };
    semuaRows.forEach((r) => {
      const semua = r.berkas || [];
      const daftar =
        dari || sampai
          ? semua.filter((b) => dalamRentang(b && b.spm ? b.spm.tanggal : null))
          : semua;
      if (daftar.length) peta.set(r.kode, daftar);
    });
    return peta;
  }, [semuaRows, applied.dari, applied.sampai]);



  /* ── Mode filter: BARIS DATAR (level kode akun belanja) ───────
     Saat filter terisi, pohon (induk/cabang/detail) tidak lagi
     ditampilkan — diganti baris datar per kode kegiatan + kode akun
     belanja, lengkap dengan KODE LENGKAP, uraian, realisasi,
     tanggal, dan nomor SPM. */
  const barisFilter = useMemo(() => {
    const keluar = [];
    const q = applied.cari.trim();
    tabelRows.forEach((r) => {
      const kode = r.kode;
      /* Bila kata kunci hanya menyebut kode/nama akun belanja (bukan
         kode/nama kegiatan), tampilkan HANYA akun yang cocok. Bila
         kegiatan itu sendiri yang cocok, semua akunnya tetap tampil. */
      const cocokKegiatan =
        !q || cocokCari(q, kode, r.nama, r.folderNama);
      const blok = ledgerTerpilihPilih(kode);
      const grup = new Map();
      const tambah = (rek, tgl, no, nilai, uraian) => {
        const k = rek || "—";
        if (!grup.has(k)) {
          grup.set(k, { rekening: k, nilai: 0, tanggal: null, spm: [], rows: [] });
        }
        const g = grup.get(k);
        g.nilai += nilai || 0;
        if (tgl && (!g.tanggal || tgl > g.tanggal)) g.tanggal = tgl;
        if (no) g.spm.push(no);
        g.rows.push({ no, rek: k, tgl, nilai, uraian: uraian || "" });
      };
      if (blok && blok.rows.length) {
        blok.rows.forEach((row) =>
          tambah(row.rekening, row.tanggal, row.noSpm, row.nilai, row.uraian)
        );
      } else {
        /* Tanpa data ledger spreadsheet untuk kegiatan ini pada bulan
           terpilih → tidak ada nomor SPM yang ditampilkan. Hanya data
           dari spreadsheet (berwarna putih) yang digunakan, sesuai
           tahun dan bulan filter. */
      }
      /* Berkas PDF kegiatan ini: bertanggal (dalam rentang filter),
         tanpa tanggal terbaca, dan berkas lain. Semua dihitung agar
         tombol "Bukti PDF" tetap muncul walau hanya ada berkas
         non-standar. */
      const pdfBerkas = berkasPerKegiatan.get(kode) || [];
      /* Filter bukti PDF agar hanya tampilkan berkas whose no SPM cocok
         dengan no SPM di ledger spreadsheet untuk kegiatan ini. Bila
         tidak ada data ledger spreadsheet, tidak tampilkan berkas PDF. */
      const pdfBerkasTercocok = blok
        ? pdfBerkas.filter((b) => {
            const no = normalNoSpm(b.spm.noSpm);
            return (
              !no ||
              blok.rows.some((r) => normalNoSpm(r.noSpm) === no)
            );
          })
        : [];
      const pdfTanpaTanggal = (r.berkas || []).filter(
        (b) => b.spm && !b.spm.tanggal
      );
      /* Bukti PDF hanya dari berkas SPM yang pola namanya standar
         (SPM_no_rekening_ddmmyy_nilai.pdf) dan sesuai bulan terpilih.
         Berkas non-SPM / nama tidak standar (mis.
         7770-EBA-994-C-552780-522112.pdf atau SPM 00524 ...) tidak
         tampil di kolom Bukti PDF. */
      const pdfLainnya = [];
      const jumlahPdf =
        pdfBerkasTercocok.length + pdfTanpaTanggal.length;

      if (!grup.size) {
        /* Kegiatan tanpa data SPM pada bulan terpilih → tidak ditampilkan
           sama sekali. Hanya kegiatan yang memiliki bukti SPM pada bulan
           yang difilter yang tampil di tabel. */
        return;
      }

      grup.forEach((g) => {
        const rekening = g.rekening && g.rekening !== "—" ? g.rekening : "";
        /* Kode lengkap = kode kegiatan + kode akun belanja. Pencarian
           seperti "7769.AFA.001.100.A.521211" dicocokkan ke kode ini,
           bukan hanya ke kode kegiatan atau kode akun saja. */
        const kodeLengkap = rekening ? `${kode}.${rekening}` : kode;
        if (
          !cocokKegiatan &&
          !cocokCari(q, kodeLengkap, rekening, namaRekening(rekening))
        ) {
          return;
        }
        keluar.push({
          kode: kodeLengkap,
          kegiatan: r.nama || kode,
          uraian: namaRekening(g.rekening),
          realisasi: g.nilai,
          tanggal: g.tanggal || r.tanggal,
          spm: g.spm,
          /* Baris spreadsheet untuk modal (sesuai no. SPM yang tampil). */
          baris: g.rows,
          /* Bukti PDF di Drive untuk kode kegiatan ini (dengan tautan). */
          pdf: pdfBerkasTercocok.map((b) => ({
            no: b.spm.noSpm,
            rek: b.spm.rekening,
            nilai: b.spm.nilai,
            tgl: b.spm.tanggal,
            nama: b.name,
            link: b.webViewLink,
          })),
          pdfTanpaTanggal: [],
          pdfLainnya: [],
          jumlahPdf: g.rows.length,
        });
      });
    });
    return keluar;
  }, [tabelRows, ledgerTerpilihPilih, berkasPerKegiatan, applied.cari]);

  const adaFilter =
    Boolean(applied.cari || applied.dari || applied.sampai) ||
    Boolean(draft.cari || draft.dari || draft.sampai);

  /* Saat difilter, tetap tampilkan dalam Tree View seperti sebelum difilter
     (hierarki induk → cabang → detail → kegiatan). */
  const filterTabelDatar = false;

  /* Reset form + hasil impor saat modal ditutup. */
  const resetFormTambah = useCallback(() => {
    setFormTambah({ segmen: [], nama: "" });
    setAnalisaTambah(null);
    setMenganalisaTambah(false);
    setDragTambah(false);
    setPesanFileTambah("");
    setSubFolderRekening("");
    setDaftarRekening([]);
    setStatusUpload(null);
  }, []);

  /* ── Baca folder / berkas yang dijatuhkan (khusus admin) ──────
     Folder dan subfolder ditelusuri otomatis; PDF dipakai sebagai
     bukti, Excel/CSV dipakai sebagai sumber angka realisasi. Tidak
     ada pemilih berkas (file picker). */
  const prosesEntriTambah = useCallback(
    async (entri, kodeCadangan, namaCadangan) => {
      setMenganalisaTambah(true);
      setPesanFileTambah("");
      setStatusUpload(null);
      setDaftarRekening([]);
      setSubFolderRekening("");
      try {
        const hasil = await analisaDropKegiatan(entri, {
          kode: kodeCadangan,
          nama: namaCadangan,
        });
        setAnalisaTambah(hasil);
        if (hasil.kode) {
          setFormTambah((lama) => ({
            segmen: hasil.kode.split("."),
            nama: hasil.nama || lama.nama,
          }));
        } else {
          setPesanFileTambah(
            "Kode kegiatan tidak terbaca dari nama folder. Isi Kode Kegiatan dan Nama Kegiatan secara manual."
          );
        }
      } catch (err) {
        setAnalisaTambah(null);
        setPesanFileTambah(String((err && err.message) || err));
      } finally {
        setMenganalisaTambah(false);
      }
    },
    []
  );

  const handleDragOverTambah = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (santaiUpload) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragTambah(true);
    },
    [santaiUpload]
  );

  const handleDragLeaveTambah = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    /* Jangan matikan status saat kursor hanya berpindah ke elemen
       anak di dalam dropzone (menghindari kedip). */
    if (e.currentTarget && e.currentTarget.contains(e.relatedTarget)) return;
    setDragTambah(false);
  }, []);

  const handleDropTambah = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragTambah(false);
      if (santaiUpload) return;
      /* Entry folder harus diambil SINKRON selama event drop masih
         berlangsung; proses pembacaannya boleh async. */
      const entri = ambilEntriDrop(e.dataTransfer);
      prosesEntriTambah(entri, kodeGabung, formTambah.nama);
    },
    [santaiUpload, prosesEntriTambah, kodeGabung, formTambah.nama]
  );

  /* Tutup modal + bersihkan form (dipakai tombol Batal & tutup). */
  const tutupModalTambah = useCallback(() => {
    if (santaiUpload) return; // jangan tutup saat unggahan berjalan
    setModalTambah(false);
    resetFormTambah();
  }, [santaiUpload, resetFormTambah]);

  /* Cari folder kegiatan di Drive berdasarkan kode; buat bila belum ada. */
  const siapkanFolderKegiatan = useCallback(async (token, kode, nama) => {
    const isi = await listAnak(DRIVE_FOLDER_ID);
    const cocok = isi
      .filter((f) => f.mimeType === FOLDER_MIME)
      .find((f) => parseNamaFolder(f.name).kode.toUpperCase() === kode.toUpperCase());
    if (cocok) return { folder: cocok, dibuat: false };

    const folderBaru = await buatFolderDrive(
      token,
      `${kode}.${nama}`.trim(),
      DRIVE_FOLDER_ID
    );
    return { folder: folderBaru, dibuat: true };
  }, []);

  /* Ambil daftar sub-folder rekening milik sebuah folder kegiatan. */
  const muatSubFolderRekening = useCallback(async (folderId) => {
    const isi = await listAnak(folderId);
    return isi
      .filter((f) => f.mimeType === FOLDER_MIME)
      .map((f) => ({ id: f.id, kode: parseNamaFolder(f.name).kode || f.name }));
  }, []);

  /*
// Ketika kode kegiatan sudah terisi lengkap, cari folder-nya di Drive
  // lalu tampilkan daftar sub-folder rekening sebagai tujuan unggah.
  // */
  useEffect(() => {
    if (!modalTambah || !analisaTambah || !kodeGabung) return undefined;
    let batal = false;
    setDaftarRekening([]);
    setSubFolderRekening("");

    (async () => {
      try {
        const isi = await listAnak(DRIVE_FOLDER_ID);
        const folder = isi
          .filter((f) => f.mimeType === FOLDER_MIME)
          .find(
            (f) =>
              parseNamaFolder(f.name).kode.toUpperCase() === kodeGabung
          );
        if (!folder) return;
        const rek = await muatSubFolderRekening(folder.id);
        if (!batal) setDaftarRekening(rek);
      } catch (e) {
        console.warn("Gagal membaca sub-folder rekening:", e);
      }
    })();

    return () => {
      batal = true;
    };
  }, [modalTambah, analisaTambah, kodeGabung, muatSubFolderRekening]);

  /* Unggah semua berkas hasil analisa ke folder kegiatan di Drive,
     menjaga struktur subfolder (berkas anak per folder induk). */
  const unggahSemuaBerkasKeFolder = useCallback(
    async (token, folder, files, indukLangsung) => {
      const cacheAnak = new Map();
      const anakDari = async (id) => {
        if (!cacheAnak.has(id)) cacheAnak.set(id, await listAnak(id));
        return cacheAnak.get(id);
      };
      const folderUntuk = async (segments) => {
        let induk = folder.id;
        for (const seg of segments || []) {
          const namaSeg = String(seg || "").trim();
          if (!namaSeg) continue;
          const anak = await anakDari(induk);
          let sub = (anak || []).find(
            (f) => f.mimeType === FOLDER_MIME && f.name === namaSeg
          );
          if (!sub) {
            sub = await buatFolderDrive(token, namaSeg, induk);
            (anak || []).push(sub);
          }
          induk = sub.id;
        }
        return induk;
      };

      const hasil = [];
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i];
        const path = f.path || [];
        const sub = path.slice(1); // buang nama folder kegiatan akar
        const induk = sub.length ? await folderUntuk(sub) : indukLangsung || folder.id;
        const up = await unggahBerkasDrive(token, induk, f.file);
        hasil.push({ ...up, kunci: kunciPathBerkas(path, f.file.name), path });
      }
      return hasil;
    },
    []
  );

  const handleSimpanTambah = async (e) => {
    e.preventDefault();
    if (santaiUpload) return;

    const kode =
      (kodeGabung || (analisaTambah && analisaTambah.kode) || "").trim();
    const nama =
      (formTambah.nama.trim() ||
        (analisaTambah && analisaTambah.nama) ||
        ""
      ).trim();
    if (!kode || !nama) {
      setPesanFileTambah(
        !kode ? "Kode kegiatan masih kosong sebelum menyimpan." : ""
      );
      return;
    }

    /* Bila ada hasil impor folder → gunakan kode/nama dari folder (atau
       form bila sempat diisi) dan realisasi per bulan dari PDF/Excel. */
    if (analisaTambah) {
      const next = gabungImporKeDaftar(tambahan, {
        ...analisaTambah,
        kode,
        nama,
      });
      if (!tulisKegiatanTambahan(next)) {
        setPesanFileTambah(
          "Data gagal disimpan — penyimpanan browser mungkin penuh. " +
            "Unduh cadangan lewat tombol 🛡 Cadangan Data lalu coba lagi."
        );
        return;
      }
      setTambahan(next);
      await simpanDataTambahanKeDrive(next);

      const files = analisaTambah.files || [];
      if (files.length > 0) {
        setSantaiUpload(true);
        setStatusUpload("Menyiapkan koneksi ke Google Drive…");
        try {
          let token = bacaToken();
          if (!token) {
            setStatusUpload("Silakan login dengan akun Google Anda…");
            token = await mintaTokenAkses();
            simpanToken(token);
          }
          setStatusUpload("Mencari folder kegiatan di Drive…");
          const { folder, dibuat } = await siapkanFolderKegiatan(
            token,
            kode,
            nama
          );
          setStatusUpload(
            dibuat
              ? "Folder kegiatan dibuat di Drive. Mengunggah berkas…"
              : "Folder kegiatan ditemukan. Mengunggah berkas…"
          );
          const hasilUpload = await unggahSemuaBerkasKeFolder(
            token,
            folder,
            files,
            subFolderRekening
          );

          /* Sinkronkan link Drive ke baris yang tersimpan di localStorage. */
          const daftar = bacaKegiatanTambahan();
          const petaUpload = new Map(
            (hasilUpload || []).map((h) => [h.kunci, h])
          );
          const nextLinks = daftar.map((t) => {
            const cocok =
              String(t.kode || "").trim().toUpperCase() ===
              String(kode).trim().toUpperCase();
            if (!cocok) return t;
            const updateBerkas = (b) => {
              if (!b) return b;
              const up = petaUpload.get(kunciPathBerkas(b.path, b.name));
              return up ? { ...b, id: up.id, webViewLink: up.webViewLink } : b;
            };
            const updateLain = (b) => {
              if (!b) return b;
              const up = petaUpload.get(kunciPathBerkas(b.path, b.name));
              return up ? { ...b, id: up.id, webViewLink: up.webViewLink } : b;
            };
            return {
              ...t,
              berkas: (t.berkas || []).map(updateBerkas),
              lainnya: (t.lainnya || []).map(updateLain),
            };
          });
          const linkTersimpan = tulisKegiatanTambahan(nextLinks);
          await simpanDataTambahanKeDrive(nextLinks);

          setModalTambah(false);
          resetFormTambah();
          muatData(); // muat ulang tabel agar folder/berkas baru ikut terlihat
          tampilkanToast(
            linkTersimpan
              ? `✓ Impor kegiatan "${kode}" disimpan & ${files.length} berkas terunggah ke Drive.`
              : `Berkas terunggah ke Drive, tetapi tautannya gagal disimpan. Data kegiatan tetap aman; unduh cadangan bila perlu.`
          );
        } catch (err) {
          console.error("Gagal mengunggah berkas:", err);
          setStatusUpload(`Gagal: ${err.message}`);
          tampilkanToast(
            `Data kegiatan "${kode}" tersimpan, tetapi unggah gagal: ${err.message}`
          );
        } finally {
          setSantaiUpload(false);
        }
        return;
      }
    }

    const baru = {
      kode,
      nama,
      pagu: 0,
      realisasi: 0,
      tanggal: tanggalHariIni(),
    };
    const next = [...tambahan.filter((t) => t.kode !== baru.kode), baru];
    if (!tulisKegiatanTambahan(next)) {
      setPesanFileTambah(
        "Data gagal disimpan — penyimpanan browser mungkin penuh. " +
          "Unduh cadangan lewat tombol 🛡 Cadangan Data lalu coba lagi."
      );
      return;
    }
    setTambahan(next);
    await simpanDataTambahanKeDrive(next);
    setModalTambah(false);
    resetFormTambah();
    tampilkanToast(`✓ Data kegiatan "${baru.kode}" berhasil ditambahkan.`);
  };

  const handleHapusTambahan = async (kode) => {
    const target = (tambahan || []).find((t) => t.kode === kode);
    const nama = target && target.nama ? ` — ${target.nama}` : "";
    const setuju = window.confirm(
      `Hapus data kegiatan "${kode}"${nama}?\n\n` +
        "Cadangan otomatis akan dibuat terlebih dahulu, tetapi data yang " +
        "sudah dihapus tidak tampil lagi di tabel. Anda bisa memulihkannya " +
        "lewat tombol 🛡 Cadangan Data."
    );
    if (!setuju) return;

    const next = tambahan.filter((t) => t.kode !== kode);
    const berhasil = tulisKegiatanTambahan(next, {
      izinkanKosong: true,
      alasan: "sebelum-hapus",
    });
    if (!berhasil) {
      tampilkanToast(
        "Data gagal dihapus karena penyimpanan browser bermasalah. Tidak ada data yang diubah."
      );
      return;
    }
    setTambahan(next);
    await simpanDataTambahanKeDrive(next);
    tampilkanToast(
      `Data kegiatan "${kode}" dihapus. Cadangan tersedia di 🛡 Cadangan Data.`
    );
  };

  return (
    <div className="site-content" style={{ paddingTop: 24, paddingBottom: 60 }}>
      {toast && <div className="toast">{toast}</div>}

      {/* ── Judul halaman ── */}
      <div className="page-header dk-header">
        <div>
          <h2>Data Kegiatan &amp; Anggaran</h2>
        </div>
        <div className="dk-header-badges">
          {!isAdmin && (
            <span className="tm-inline-badge" title="Tamu hanya bisa melihat data, tidak bisa menambah atau mengubahnya">
              👁 Mode Tamu · baca saja
            </span>
          )}
          {(loading || menyegarkan) && (
            <div className="dk-live-badge">
              <span className="dk-live-dot" />
              {loading
                ? `Mengambil data… ${progress}/${rows.length || "?"}`
                : `Menyegarkan dari Drive… ${progress}/${rows.length || "?"}`}
            </div>
          )}
        </div>
      </div>

      {/* ── Toolbar: rentang tanggal + filter + tambah ── */}
      <div className="dk-toolbar">
        <div className="dk-toolbar-filters">
          <input
            type="text"
            className="dk-input"
            placeholder="Cari kode / nama kegiatan..."
            title="Cari berdasarkan kode atau nama kegiatan, termasuk KODE LENGKAP (contoh: 7769.AFA.001.100.A.521211). Titik dan spasi diabaikan."
            value={draft.cari}
            onChange={(e) => {
              /* Pencarian langsung berjalan saat mengetik — tidak perlu
                 menekan Filter lebih dulu. Filter bulan tetap diterapkan
                 lewat tombol Filter/Enter. */
              const cari = e.target.value;
              setDraft((d) => ({ ...d, cari }));
              setApplied((a) => ({ ...a, cari }));
            }}
            onKeyDown={(e) => e.key === "Enter" && setApplied(draft)}
          />
          <label className="dk-date-wrap">
            <span className="dk-date-label">Kumulatif s.d.</span>
            <input
              type="month"
              className="dk-input dk-input-date"
              value={draft.sampai}
              onChange={(e) => {
                const sampai = e.target.value;
                const tahun = String(sampai || "").slice(0, 4);
                const dari = /^\d{4}$/.test(tahun) ? `${tahun}-01` : "";
                setDraft({ ...draft, dari, sampai });
              }}
            />
          </label>
          <button
            type="button"
            className="dk-btn dk-btn-filter"
            onClick={() => setApplied(draft)}
            title="Terapkan filter kumulatif (Januari s.d. bulan terpilih)"
          >
            🔍 Filter
          </button>
          <button
            type="button"
            className="dk-btn dk-btn-clear"
            onClick={() => {
              const kosong = { cari: "", dari: "", sampai: "" };
              setDraft(kosong);
              setApplied(kosong);
            }}
            disabled={!adaFilter}
            title="Hapus semua filter"
          >
            ✕ Hapus Filter
          </button>
        </div>
        <div className="dk-toolbar-right">
          <button
            type="button"
            className="dk-btn dk-btn-tree"
            onClick={semuaBuka ? tutupSemua : bukaSemua}
            title={
              semuaBuka
                ? "Tutup semua rincian"
                : "Buka semua rincian"
            }
          >
            {semuaBuka ? "▴ Tutup Semua" : "▾ Buka Semua"}
          </button>
          {isAdmin && (
            <>
              <CadanganData />
              <button
                type="button"
                className="dk-btn dk-btn-add"
                onClick={() => setModalTambah(true)}
              >
                + Tambah Data
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Panduan filter bulan ──────────────────────────────────
          Menampilkan bulan-bulan yang benar-benar punya data (chips)
          dan ringkasan data yang lolos filter bulan aktif, supaya
          jelas data mana yang terhubung dengan bulan yang dipilih. */}
      {(bulanTersedia.length > 0 || filterBulanAktif) && (
        <div className="dk-filter-bulan">
          <div className="dk-spark-card">
            <div className="dk-spark-header">
              <span className="dk-spark-icon">📅</span>
              <span className="dk-spark-title">Filter Bulan ({tahunSpark})</span>
              {filterBulanAktif && (
                <span className="dk-spark-badge">Aktif: {labelPeriodeBulan(applied.dari, applied.sampai)}</span>
              )}
              <button
                type="button"
                className="dk-spark-toggle"
                onClick={() => setTampilkanSpark(!tampilkanSpark)}
                title={tampilkanSpark ? "Sembunyikan grafik" : "Tampilkan grafik"}
              >
                {tampilkanSpark ? "▲" : "▼"}
              </button>
            </div>
            {tampilkanSpark && (
              <>
                <div className="dk-spark-bars">
                  {bulanSemua.map((b) => {
                    const aktif =
                      filterBulanAktif && applied.sampai === b.bulan;
                    const pct = maxJumlah > 0 ? (b.jumlah / maxJumlah) * 100 : 0;
                    const ada = b.jumlah > 0;
                    /* Warna batang bergantung pada tinggi (heatmap):
                       rendah = hijau, sedang = biru, tinggi = ungu muda. */
                    let warnaBar = "#3b82f6";
                    if (pct > 0) {
                      if (pct < 33) warnaBar = "#10b981";      /* hijau */
                      else if (pct < 66) warnaBar = "#3b82f6"; /* biru */
                      else warnaBar = "#8b5cf6";               /* ungu */
                    }
                    return (
                      <button
                        key={b.bulan}
                        type="button"
                        className={`dk-spark-bulan${aktif ? " dk-spark-bulan-aktif" : ""}${!ada ? " dk-spark-bulan-kosong" : ""}`}
                        onClick={() => pilihBulan(b.bulan)}
                        disabled={!ada}
                        title={
                          ada
                            ? `${b.labelSingkat} ${tahunSpark}: ${b.jumlah} kegiatan · ${formatRupiah(
                                petaJumlah.get(b.bulan) || 0
                              )} · klik ${aktif ? "untuk melepas" : "untuk menampilkan kumulatif s.d. bulan ini"}`
                            : `${b.labelSingkat} ${tahunSpark}: tidak ada data`
                        }
                      >
                        <div className="dk-spark-bar-wrap">
                          <div
                            className="dk-spark-bar"
                            style={{ height: `${pct}%`, background: warnaBar }}
                          />
                          {ada && pct > 0 && (
                            <div className="dk-spark-dot" />
                          )}
                        </div>
                        <span className="dk-spark-label">{b.labelSingkat}</span>
                        <span className="dk-spark-jumlah">({b.jumlah})</span>
                      </button>
                    );
                  })}
                </div>
                <div className="dk-spark-footer">
                  <span className="dk-spark-keterangan">
                    Tinggi batang = banyaknya kegiatan di bulan tersebut · klik batang untuk filter kumulatif Januari s.d. bulan yang dipilih
                  </span>
                </div>
              </>
            )}
          </div>
          {filterBulanAktif && (
            <div className="dk-filter-bulan-ringkas">
              {/* Daftar bukti kerja SPM (PDF Drive) sesuai bulan terpilih. */}
              <div className="dk-fbr-berkas">
                <button
                  type="button"
                  className="dk-btn dk-btn-spm"
                  onClick={() =>
                    setModalSpm({
                      label: periodeFilterLabel,
                      tab: ledgerTabNama,
                      baris: ledgerBarisPeriode.map((r) => ({
                        no: r.noSpm,
                        rek: r.rekening,
                        tgl: r.tanggal,
                        nilai: r.nilai,
                        uraian: r.uraian,
                        kode: r.kegiatanKode,
                      })),
                      total: ledgerPeriodeTotal,
                    })
                  }
                  disabled={ledgerBarisPeriode.length === 0}
                  title={`Lihat ${ledgerBarisPeriode.length} bukti laporan SPM pada rentang ${periodeFilterLabel}`}
                >
                  📎 Bukti Laporan SPM: {ledgerBarisPeriode.length} SPM
                  {ledgerBarisPeriode.length > 0
                    ? ` · ${formatRupiah(ledgerPeriodeTotal)}`
                    : ""}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Info bar ── */}
      <div className="dk-infobar">
        Menampilkan <strong>{tabelRows.length}</strong> dari{" "}
        <strong>{semuaRows.length}</strong> kegiatan
        {adaFilter && <span className="dk-infobar-tag">Filter aktif</span>}
        <span className="dk-infobar-spacer" />
        <span>
          Bukti Kerja: <strong>{totalBerkas} berkas</strong>
        </span>
        {/* Status sumber data: cache (tampil segera) vs sedang menyegarkan
            dari Drive. Tanpa cache, tabel menunggu Drive selesai. */}
        <span
          className="dk-infobar-status"
          title={
            menyegarkan
              ? "Menyegarkan data dari Google Drive di belakang layar — tabel tetap bisa dipakai."
              : cacheDipakai
              ? "Data ditampilkan dari simpanan terakhir (tidak membaca Drive lagi)."
              : "Data hasil pembacaan terbaru dari Google Drive."
          }
        >
          {menyegarkan ? (
            <>
              <span className="dk-dot dk-dot-loading" /> Menyegarkan…
            </>
          ) : cacheDipakai ? (
            <>
              <span className="dk-dot dk-dot-cache" /> Data tersimpan
              {terakhirMuat ? ` · ${waktuRelatif(terakhirMuat)}` : ""}
            </>
          ) : (
            <>
              <span className="dk-dot dk-dot-live" /> Terbaru
            </>
          )}
        </span>
        <button
          type="button"
          className="dk-btn dk-btn-refresh"
          onClick={() => muatData()}
          disabled={menyegarkan}
          title="Baca ulang data terbaru dari Google Drive"
        >
          ↻ Muat Ulang
        </button>
      </div>

      {/* ── Tabel ── */}
      <div className="dk-table-wrap">
        {filterTabelDatar ? (
          /* Mode filter: baris datar (level kode akun belanja) —
             tidak ada baris induk/cabang/detail, tidak perlu dibuka. */
          <table className="dk-table">
            <thead>
              <tr>
                <th style={{ minWidth: 240 }}>Kode Lengkap</th>
                <th>Uraian</th>
                <th style={{ textAlign: "right", minWidth: 140 }}>
                  Realisasi
                </th>
                <th style={{ textAlign: "center", width: 120 }}>Tanggal</th>
                <th style={{ minWidth: 200 }}>No. SPM</th>
                <th style={{ textAlign: "center", minWidth: 130 }}>
                  Bukti PDF
                </th>
              </tr>
            </thead>
            <tbody>
              {barisFilter.length > 0 ? (
                barisFilter.map((b) => (
                  <tr key={b.kode} className="dk-row dk-row-kegiatan">
                    <td className="dk-kode-cell">
                      <span className="dk-kode">{b.kode}</span>
                    </td>
                    <td>
                      <span className="dk-kegiatan" title={b.kegiatan}>
                        {b.kegiatan}
                      </span>
                      <span className="dk-sub">{b.uraian}</span>
                    </td>
                    <td className="dk-num">{formatRupiah(b.realisasi)}</td>
                    <td className="dk-tanggal">{isoToTglId(b.tanggal)}</td>
                    <td className="dk-spm-nomor">
                      {b.spm.length
                        ? b.spm.map(formatNoSpm).join(", ")
                        : "—"}
                    </td>
                    <td className="dk-bukti">
                      {b.jumlahPdf > 0 ? (
                        <button
                          type="button"
                          className="dk-btn-dok"
                          onClick={() =>
                            setModalSpm({
                              label: periodeFilterLabel,
                              kode: b.kode,
                              nama: b.kegiatan,
                              tab: ledgerTabNama,
                              baris: b.baris || [],
                              total: b.realisasi || 0,
                              pdf: b.pdf,
                              pdfTanpaTanggal: [],
                              pdfLainnya: [],
                            })
                          }
                          title={`Lihat ${b.jumlahPdf} berkas SPM di Google Drive`}
                        >
                          📎 {b.jumlahPdf} berkas
                        </button>
                      ) : (
                        <span className="dk-kosong">—</span>
                      )}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={6} className="dk-empty">
                    {loading
                      ? "Mengambil data kegiatan dari Google Drive..."
                      : applied.cari.trim()
                      ? `Tidak ada data yang cocok dengan pencarian "${applied.cari.trim()}". Coba kode kegiatan (contoh: 7769 atau 7769.AFA) atau kode lengkap dengan akun belanja (contoh: 7769.AFA.001.100.A.521211).`
                      : "Tidak ada kegiatan yang cocok dengan filter."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="dk-table">
          <thead>
            <tr>
              <th style={{ minWidth: 150 }}>Kode</th>
              <th>Kegiatan</th>

              <th style={{ textAlign: "right", minWidth: 130 }}>Realisasi</th>
              <th style={{ textAlign: "center", width: 110 }}>Tanggal</th>
              {sedangDifilter && <th style={{ minWidth: 140 }}>No. SPM</th>}
              <th style={{ textAlign: "center", minWidth: 200 }}>
                Bukti Kerja{filterBulanAktif ? ` · ${periodeFilterLabel}` : ""}
              </th>
            </tr>
          </thead>
          <tbody>
            {barisTampil.length > 0 ? (
              barisTampil.map((n) => {
                const expandable = n.children.length > 0;
                const terbuka = expandable && isOpen(n);
                return (
                  <tr
                    key={n.key}
                    className={`dk-row dk-row-${n.tipe}`}
                    data-level={n.depth}
                  >
                    {/* Kode — dipersingkat mengikuti level hierarki */}
                    <td className="dk-kode-cell">
                      <span
                        className="dk-kode-indent"
                        style={{ width: n.depth * 15 }}
                      />
                      {expandable ? (
                        <button
                          type="button"
                          className="dk-toggle"
                          onClick={() => toggleNode(n)}
                          aria-expanded={terbuka}
                          aria-label={`${terbuka ? "Tutup" : "Buka"} rincian ${n.kode}`}
                          title={`${terbuka ? "Tutup" : "Buka"} rincian (${n.children.length})`}
                        >
                          {terbuka ? "▾" : "▸"}
                        </button>
                      ) : (
                        <span className="dk-toggle dk-toggle-empty">·</span>
                      )}
                      <span className="dk-kode">{n.kode}</span>
                      {n.lokal && <span className="dk-tag-local">Input</span>}
                    </td>

                    {/* Kegiatan / uraian */}
                    <td>
                      {n.tipe === "kegiatan" ? (
                        <>
                          <span className="dk-kegiatan" title={n.nama}>
                            {n.nama || "—"}
                          </span>
                        </>
                      ) : n.tipe === "akun" ? (
                        <>
                          <span className="dk-kegiatan" title={n.nama}>
                            {n.nama}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="dk-level-tag">
                            {LABEL_LEVEL[n.tipe]}
                          </span>
                          <span className="dk-sub">
                            {[n.jumlahKegiatan, n.jumlahRekening]
                              .filter((x) => x > 0)
                              .map((x) => `${x} anak`)
                              .join(" · ")}
                          </span>
                        </>
                      )}
                    </td>


                    <td
                      className="dk-num"
                      title={
                        sedangDifilter
                          ? "Sumber: Spreadsheet rekap SPM (sesuai filter kumulatif)"
                          : n.tipe === "kegiatan" && n.sumberRealisasi
                          ? `Sumber: ${n.sumberRealisasi}` +
                            (n.realisasiBerkas && n.realisasiBerkas !== n.realisasi
                              ? ` · dari nama berkas PDF: ${formatRupiah(n.realisasiBerkas)}`
                              : "")
                          : undefined
                      }
                    >
                      {(() => {
                        if (sedangDifilter) {
                          if (n.tipe === "akun") {
                            const per = buktiPerRekening.get(kunciKode(n.induk));
                            const e = per ? per.get(String(n.kode || "").trim()) : null;
                            return formatRupiah(e ? e.total || 0 : 0);
                          }
                          if (n.tipe === "kegiatan") {
                            const per = buktiPerRekening.get(kunciKode(n.kode));
                            let total = 0;
                            if (per) per.forEach((v) => { total += v.total || 0; });
                            return formatRupiah(total);
                          }
                          return formatRupiah(0);
                        }
                        return formatRupiah(n.realisasi);
                      })()}
                    </td>
                    <td className="dk-tanggal">
                      {(() => {
                        if (sedangDifilter) {
                          if (n.tipe !== "akun") return "—";
                          const blok = ledgerTerpilihPilih(n.induk);
                          const rek = String(n.kode || "").trim();
                          const daftar = blok
                            ? blok.rows.filter((r) => String(r.rekening || "").trim() === rek)
                            : [];
                          const tgl = [...new Set(daftar.map((r) => r.tanggal).filter(Boolean))].sort();
                          if (tgl.length === 1) return isoToTglId(tgl[0]);
                          // Jika lebih dari satu tanggal, ditampilkan di bukti laporan PDF agar tabel rapi.
                          return "—";
                        }
                        return isoToTglId(n.tanggal);
                      })()}
                    </td>
                    {sedangDifilter && (
                      <td className="dk-spm-nomor">
                        {(() => {
                          if (n.tipe === "akun") {
                            const blok = ledgerTerpilihPilih(n.induk);
                            const rek = String(n.kode || "").trim();
                            const daftar = blok
                              ? blok.rows.filter((r) => String(r.rekening || "").trim() === rek)
                              : [];
                            const nos = [...new Set(daftar.map((r) => r.noSpm).filter(Boolean))];
                            return nos.length ? nos.map(formatNoSpm).join(", ") : "—";
                          }
                          if (n.tipe === "kegiatan") {
                            const blok = ledgerTerpilihPilih(n.kode);
                            const nos = blok
                              ? [...new Set(blok.rows.map((r) => r.noSpm).filter(Boolean))]
                              : [];
                            return nos.length ? nos.map(formatNoSpm).join(", ") : "—";
                          }
                          return "—";
                        })()}
                      </td>
                    )}
                    <td className="dk-bukti">
                      {(() => {
                        /* Tombol ringkas → modal berisi tabel bukti laporan
                           SPM (dari ledger spreadsheet "Rekap SPM kumulatif
                           per bulan"; bila kegiatan tidak ada di ledger,
                           dipakai berkas PDF Drive yang bertanggal). */
                        if (n.tipe === "akun") {
                          /* Baris Kode Akun Belanja: badge 📎 berisi jumlah
                             bukti PDF tersimpan. Diklik → modal ringkasan
                             nilai SPM + daftar bukti PDF kode belanja ini. */
                          const rek = String(n.kode || "").trim();
                          const blok = ledgerTerpilihPilih(n.induk);
                          const daftar = blok
                            ? blok.rows
                                .filter(
                                  (r) =>
                                    String(r.rekening || "").trim() === rek
                                )
                                .map((r) => ({
                                  no: r.noSpm,
                                  rek: r.rekening,
                                  tgl: r.tanggal,
                                  nilai: r.nilai,
                                  uraian: r.uraian,
                                }))
                            : (n.berkas || []).map((b) => ({
                                no: b.spm.noSpm,
                                rek: b.spm.rekening,
                                tgl: b.spm.tanggal,
                                nilai: b.spm.nilai,
                                uraian: b.name,
                                link: b.webViewLink,
                              }));
                          const tanpa = (n.berkas || []).filter(
                            (b) => b.spm && !b.spm.tanggal
                          );
                          /* Bukti PDF hanya dari berkas SPM standar.
                             Berkas non-SPM tidak tampil di modal. */
                          const lain = [];
                          const total = daftar.reduce(
                            (s, r) => s + (r.nilai || 0),
                            0
                          );
                          /* Jumlah sesuai baris spreadsheet (no. SPM yang ditampilkan). */
                          const jumlah = daftar.length;
                          if (!jumlah) {
                            return <span className="dk-kosong">—</span>;
                          }
                          return (
                            <button
                              type="button"
                              className="dk-btn-dok"
                              onClick={() => {
                                const liveKey = `akun:${n.induk}:${rek}`;
                                setModalSpm({
                                  label: periodeFilterLabel,
                                  kode: n.induk,
                                  nama: n.nama,
                                  tab: ledgerTabNama,
                                  baris: daftar,
                                  total,
                                  liveKey,
                                  pdf: (() => {
                                    /* Hanya tampilkan berkas PDF whose no SPM
                                       cocok dengan no SPM di ledger spreadsheet
                                       (untuk akun belanja ini). Bila tidak ada
                                       data ledger, tampilkan semua berkas. */
                                    const spmNoLedger = new Set(
                                      blok
                                        ? blok.rows
                                            .filter(
                                              (r) =>
                                                String(r.rekening || "").trim() ===
                                                rek
                                            )
                                            .map((r) => normalNoSpm(r.noSpm))
                                        : []
                                    );
                                    return (n.berkas || [])
                                      .filter((b) => b.spm && b.spm.tanggal)
                                      .filter((b) => {
                                        const no = normalNoSpm(b.spm.noSpm);
                                        return !no || spmNoLedger.has(no);
                                      })
                                      .map((b) => ({
                                        no: b.spm.noSpm,
                                        rek: b.spm.rekening,
                                        nilai: b.spm.nilai,
                                        tgl: b.spm.tanggal,
                                        nama: b.name,
                                        link: b.webViewLink,
                                      }));
                                  })(),
                                  pdfTanpaTanggal: [],
                                  pdfLainnya: [],
                                  rekening: n.link
                                    ? [
                                        {
                                          kode: n.kode,
                                          nama: n.nama,
                                          jumlah: n.jumlahBerkas,
                                          id: n.folderId,
                                          link: n.link,
                                        },
                                      ]
                                    : [],
                                });
                                /* Lengkapi berkas langsung dari Drive. */
                                muatBuktiSpmLive(liveKey, [
                                  { kode: rek, id: n.folderId, link: n.link },
                                ], applied.sampai, daftar);
                              }}
                              title={`Lihat ${jumlah} bukti laporan SPM — ${formatRupiah(
                                total
                              )}`}
                            >
                              📎 {jumlah} berkas
                            </button>
                          );
                        }
                        if (n.tipe !== "kegiatan") {
                          return <span className="dk-kosong">—</span>;
                        }
                        const blok = ledgerTerpilihPilih(n.kode);
                        const daftar = berkasPerKegiatan.get(n.kode) || [];
                        const tanpaTanggal = (n.berkas || []).filter(
                          (b) => b.spm && !b.spm.tanggal
                        );
                        /* Bukti PDF hanya dari berkas SPM standar.
                           Berkas non-SPM tidak tampil di modal. */
                        const lainnya = [];
                        const baris = blok
                          ? blok.rows.map((r) => ({
                              no: r.noSpm,
                              rek: r.rekening,
                              tgl: r.tanggal,
                              nilai: r.nilai,
                              uraian: r.uraian,
                            }))
                          : [];
                        const jumlahPdf = baris.length;
                        if (!baris.length && !jumlahPdf) {
                          return <span className="dk-kosong">—</span>;
                        }
                        const total = baris.reduce(
                          (s, r) => s + (r.nilai || 0),
                          0
                        );
                        return (
                          <button
                            type="button"
                            className={`dk-btn-dok${
                              filterBulanAktif ? " dk-btn-dok-bulan" : ""
                            }`}
                            onClick={() => {
                              const liveKey = `kegiatan:${n.kode}`;
                              /* Hanya tampilkan berkas PDF whose no SPM cocok
                                 dengan no SPM di ledger spreadsheet, supaya
                                 bukti yang tampil sesuai (mis. 00006T bukan
                                 00524). Data hanya dari spreadsheet. */
                              const spmNoLedger = new Set(
                                baris.map((r) => normalNoSpm(r.no))
                              );
                              const pdfDariBerkas = (n.berkas || [])
                                .filter((b) => b.spm && b.spm.tanggal)
                                .filter((b) => {
                                  const no = normalNoSpm(b.spm.noSpm);
                                  return !no || spmNoLedger.has(no);
                                })
                                .map((b) => ({
                                  no: b.spm.noSpm,
                                  rek: b.spm.rekening,
                                  nilai: b.spm.nilai,
                                  tgl: b.spm.tanggal,
                                  nama: b.name,
                                  link: b.webViewLink,
                                }));
                              setModalSpm({
                                label: periodeFilterLabel,
                                kode: n.kode,
                                nama: n.nama,
                                tab: ledgerTabNama,
                                baris,
                                total,
                                liveKey,
                                pdf: pdfDariBerkas,
                                pdfTanpaTanggal: [],
                                pdfLainnya: [],
                                /* Folder kode akun belanja yang ada di Drive
                                   (folder anak kegiatan) — dipakai untuk
                                   memecah bukti per kode belanja. */
                                rekening: n.rekening || [],
                              });
                              /* Lengkapi berkas langsung dari Drive: folder
                                 kegiatan (berkas di luar sub-folder) + semua
                                 folder rekeningnya. */
                              muatBuktiSpmLive(liveKey, [
                                { kode: "", id: n.folderId, link: n.link },
                                ...(n.rekening || []).map((k) => ({
                                  kode: k.kode,
                                  id: k.id,
                                  link: k.link,
                                })),
                              ], applied.sampai, baris);
                            }}
                            title={`Lihat ${baris.length} bukti laporan SPM — ${formatRupiah(total)}${jumlahPdf ? ` · ${jumlahPdf} berkas PDF di Drive` : ""}`}
                          >
                            📎 {baris.length || jumlahPdf} berkas
                            {baris.length ? ` · ${formatRupiah(total)}` : ""}
                          </button>
                        );
                      })()}
                      {n.tipe !== "akun" && n.link && (
                        <a
                          className="dk-link-drive"
                          href={n.link}
                          target="_blank"
                          rel="noreferrer"
                          title={`Buka folder Drive: ${n.kode}`}
                        >
                          ↗
                        </a>
                      )}
                      {isAdmin && n.lokal && (
                        <button
                          type="button"
                          className="dk-btn-hapus"
                          onClick={() => handleHapusTambahan(n.kode)}
                          title="Hapus data tambahan ini"
                        >
                          🗑
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={sedangDifilter ? 7 : 6} className="dk-empty">
                  {loading
                    ? "Mengambil data kegiatan dari Google Drive..."
                    : adaFilter
                    ? "Tidak ada kegiatan yang cocok dengan filter."
                    : "Belum ada data kegiatan di Google Drive."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {error && <div className="alert alert-danger dk-alert">{error}</div>}

      {/* ── Modal: bukti laporan SPM ── */}
      {modalSpm && (
        <div className="modal-overlay" onClick={() => setModalSpm(null)}>
          <div
            className="modal-box"
            style={{ maxWidth: 820 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h4>
                Bukti Laporan SPM
                {modalSpm.label ? ` — ${modalSpm.label}` : ""}
                {modalSpm.kode ? ` · ${modalSpm.kode}` : ""}
                <span className="dk-muted">
                  {" "}
                  · {modalSpm.baris.length} SPM
                  {modalSpm.tab ? ` (tab ${modalSpm.tab})` : ""}
                </span>
              </h4>
              <button
                className="modal-close-btn"
                onClick={() => setModalSpm(null)}
              >
                ✕
              </button>
            </div>
            {/* Status pemuatan ulang berkas langsung dari Google Drive. */}
            {modalSpmLive && (
              <div
                className={`dk-modal-live${
                  modalSpmLive.galat ? " dk-modal-live-galat" : ""
                }`}
              >
                {modalSpmLive.memuat ? (
                  <>⟳ Memuat berkas terbaru dari Google Drive…</>
                ) : modalSpmLive.galat ? (
                  <>
                    ⚠ Gagal memuat data terbaru ({modalSpmLive.galat}) —
                    menampilkan data tersimpan.
                  </>
                ) : modalSpmLive.waktu ? (
                  <>
                    ● Realtime — {modalSpmLive.jumlahBerkas} berkas diperiksa
                    {modalSpmLive.salinan
                      ? ` · ${modalSpmLive.salinan} salinan`
                      : ""}{" "}
                    · diperbarui{" "}
                    {new Date(modalSpmLive.waktu).toLocaleTimeString("id-ID", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </>
                ) : null}
              </div>
            )}
            <div className="modal-body" style={{ padding: 0 }}>
              {modalSpm.baris.length === 0 &&
              !(modalSpm.pdf || []).length &&
              !(modalSpm.pdfLainnya || []).length ? (
                <p className="dk-modal-kosong">
                  Belum ada bukti laporan SPM pada rentang ini.
                </p>
              ) : null}
              {/* Bukti laporan SPM dipecah per KODE AKUN BELANJA sesuai
                  folder yang ada di Google Drive — jadi tidak lagi
                  digabung di bawah Kode Kegiatan. */}
              {modalSpm.nama && (
                <div className="dk-modal-subhead">{modalSpm.nama}</div>
              )}
              <div className="dk-modal-scroll">
                {(() => {
                  const normNo = (s) =>
                    String(s || "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
                  /* Hanya tampilkan baris dari spreadsheet (modalSpm.baris) —
                     jumlah di modal = jumlah SPM di tabel, sesuai kode akun
                     belanja. Tidak menambahkan PDF/berkas dari Drive yang
                     tidak ada di spreadsheet. */
                  const grup = new Map();
                  const ambil = (rek) => {
                    const kunci = String(rek || "—").trim() || "—";
                    if (!grup.has(kunci)) grup.set(kunci, []);
                    return grup.get(kunci);
                  };
                  /* Map nomor SPM → link PDF dari Drive (untuk tautan saja). */
                  const pdfByNo = new Map();
                  (modalSpm.pdf || []).forEach((b) => {
                    const key = normNo(b.no);
                    if (key && !pdfByNo.has(key)) pdfByNo.set(key, b);
                  });
                  (modalSpm.baris || []).forEach((r) => {
                    const rek = String(r.rek || "").trim() || "—";
                    const pdf = pdfByNo.get(normNo(r.no));
                    ambil(rek).push(
                      pdf ? { ...r, link: pdf.link, nama: pdf.nama } : r
                    );
                  });
                  /* Folder kode akun belanja di Drive (untuk tautan folder). */
                  const folder = new Map(
                    (modalSpm.rekening || []).map((k) => [
                      String(k.kode || "—").trim(),
                      k,
                    ])
                  );
                  return [...grup.entries()]
                    .sort((a, b) => a[0].localeCompare(b[0], "id"))
                    .map(([rek, daftar], gi) => {
                      const f = folder.get(rek);
                      const totalGrup = daftar.reduce(
                        (a, b) => a + (b.nilai || 0),
                        0
                      );
                      return (
                        <div key={rek} className="dk-grup-belanja">
                          <div className="dk-grup-belanja-head">
                            <span className="dk-kode">{rek}</span>
                            <span className="dk-grup-belanja-nama">
                              {namaRekening(rek)}
                            </span>
                            <span className="dk-sub">
                              {daftar.length} SPM · total{" "}
                              {formatRupiah(totalGrup)}
                            </span>
                            {f && f.link && (
                              <a
                                className="dk-link-drive"
                                href={f.link}
                                target="_blank"
                                rel="noreferrer"
                                title="Buka folder di Google Drive"
                              >
                                ↗
                              </a>
                            )}
                          </div>
                          <table className="dk-table dk-table-modal">
                            <thead>
                              <tr>
                                <th>No. SPM</th>
                                {!modalSpm.kode && <th>Kegiatan</th>}
                                <th style={{ textAlign: "center" }}>
                                  Tanggal
                                </th>
                                <th style={{ textAlign: "right" }}>Nilai</th>
                              </tr>
                            </thead>
                            <tbody>
                              {daftar.map((b, i) => (
                                <tr key={`${b.no}-${gi}-${i}`}>
                                  <td>
                                    {b.link ? (
                                      <a
                                        href={b.link}
                                        target="_blank"
                                        rel="noreferrer"
                                        title={b.nama || b.uraian}
                                      >
                                        {formatNoSpm(b.no)}
                                      </a>
                                    ) : (
                                      formatNoSpm(b.no)
                                    )}
                                  </td>
                                  {!modalSpm.kode && (
                                    <td>
                                      <span className="dk-kode">
                                        {b.kode || "—"}
                                      </span>
                                    </td>
                                  )}
                                  <td className="dk-tanggal">
                                    {b.tgl ? isoToTglId(b.tgl) : "—"}
                                  </td>
                                  <td className="dk-num">
                                    {b.nilai == null
                                      ? "—"
                                      : formatRupiah(b.nilai)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      );
                    });
                })()}
              </div>

              {(modalSpm.pdfTanpaTanggal || []).length > 0 && (
                <>
                  <div className="dk-modal-subhead">
                    SPM tanpa tanggal terbaca ({modalSpm.pdfTanpaTanggal.length})
                    — nama berkas tidak mengikuti pola{" "}
                    <code>SPM_no_rekening_ddmmyy_nilai</code>, sehingga bulan
                    terbitnya tidak bisa dipastikan.
                  </div>
                  <div className="dk-modal-scroll">
                    <table className="dk-table dk-table-modal">
                    <thead>
                      <tr>
                        <th>No. SPM</th>
                        <th style={{ textAlign: "right" }}>Nilai</th>
                        <th>Nama berkas</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalSpm.pdfTanpaTanggal.map((b, i) => (
                        <tr key={b.id || i}>
                          <td>
                            <a
                              href={b.webViewLink}
                              target="_blank"
                              rel="noreferrer"
                              title="Buka PDF di Drive"
                            >
                              SPM {formatNoSpm(b.spm.noSpm)}
                            </a>
                          </td>
                          <td className="dk-num">
                            {formatRupiah(b.spm.nilai)}
                          </td>
                          <td>{b.name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </>
              )}

              <div className="dk-modal-total">
                {modalSpm.baris.length > 0 ? (
                  <>
                    <strong>{modalSpm.baris.length} SPM</strong> dari tab
                    spreadsheet <strong>{modalSpm.tab}</strong> · jumlah nilai{" "}
                    <strong>{formatRupiah(modalSpm.total)}</strong>
                  </>
                ) : (
                  <>
                    <strong>{(modalSpm.pdf || []).length} berkas SPM PDF</strong>{" "}
                    di Google Drive
                    {modalSpm.total > 0 && (
                      <>
                        {" "}
                        · jumlah nilai{" "}
                        <strong>{formatRupiah(modalSpm.total)}</strong>
                      </>
                    )}
                  </>
                )}
                <span className="dk-muted">
                  {" "}
                  · sumber: spreadsheet "Rekap SPM kumulatif per bulan" &amp;
                  berkas PDF di Drive
                </span>
              </div>
            </div>
            <div
              className="modal-footer"
              style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
            >
              <button className="btn-cancel" onClick={() => setModalSpm(null)}>
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: tambah data ── */}
      {modalTambah && (
        <div className="modal-overlay" onClick={tutupModalTambah}>
          <div
            className="modal-box"
            style={{ maxWidth: 560 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h4>Tambah Data Kegiatan</h4>
              <button
                className="modal-close-btn"
                onClick={tutupModalTambah}
                disabled={santaiUpload}
              >
                ✕
              </button>
            </div>
            <form onSubmit={handleSimpanTambah}>
              <div className="modal-body">
                {/* Kode kegiatan — diisi satu level per satu */}
                <div className="form-group">
                  <label>Kode *</label>
                  <div className="dk-segbar">
                    {Array.from({ length: jumlahLevel }, (_, i) => {
                      const nilai = formTambah.segmen[i] || "";
                      const saran = prefixSegmen(formTambah.segmen, i);
                      const opsi = saranSegmen.get(saran) || [];
                      const listId = `dk-seg-${i}`;
                      return (
                        <React.Fragment key={listId}>
                          {i > 0 && <span className="dk-segdot">.</span>}
                          <span className="dk-segbox">
                            <input
                              type="text"
                              className="filter-select dk-seginput"
                              list={listId}
                              autoComplete="off"
                              spellCheck={false}
                              placeholder={
                                i === 0 ? "7769" : String(i + 1).padStart(2, "0")
                              }
                              value={nilai}
                              onChange={(e) => ubahSegmen(i, e.target.value)}
                              aria-label={LABEL_SEGMEN[i] || `Level ${i + 1}`}
                            />
                            <datalist id={listId}>
                              {opsi.map((o) => (
                                <option key={o} value={o} />
                              ))}
                            </datalist>
                            <small>
                              {LABEL_SEGMEN[i] || `Level ${i + 1}`}
                            </small>
                          </span>
                        </React.Fragment>
                      );
                    })}
                  </div>
                  <div className="dk-segpreview">
                    Kode lengkap:{" "}
                    <code>{kodeGabung || "— belum ada —"}</code>
                  </div>
                  <p className="dk-seghint">
                    Isi satu per satu (pilih dari daftar atau ketik sendiri).
                    Kosongkan sebuah kotak untuk mengulang level tersebut.
                  </p>
                </div>
                <div className="form-group">
                  <label>Nama Kegiatan *</label>
                  <input
                    type="text"
                    className="filter-select"
                    style={{ width: "100%" }}
                    list="dk-saran-nama"
                    placeholder="Contoh: Peny. Kurmod Pelatihan SDA"
                    value={formTambah.nama}
                    onChange={(e) =>
                      setFormTambah({ ...formTambah, nama: e.target.value })
                    }
                    required
                  />
                  <datalist id="dk-saran-nama">
                    {saranNama.map((n) => (
                      <option key={n} value={n} />
                    ))}
                  </datalist>
                </div>
                {/* Impor folder / bukti laporan — hanya drag & drop, khusus admin */}
                {isAdmin && (
                  <div className="form-group">
                    <label>Tambah folder / bukti laporan (tarik &amp; lepas)</label>
                    <div
                      className={`fm-dropzone${dragTambah ? " fm-dropzone-active" : ""}${
                        analisaTambah ? " fm-dropzone-filled" : ""
                      }`}
                      style={{
                        cursor: santaiUpload || menganalisaTambah ? "not-allowed" : "default",
                        opacity: santaiUpload || menganalisaTambah ? 0.7 : 1,
                      }}
                      role="region"
                      aria-label="Area tarik dan lepas berkas atau folder"
                      onDragOver={handleDragOverTambah}
                      onDragEnter={handleDragOverTambah}
                      onDragLeave={handleDragLeaveTambah}
                      onDrop={handleDropTambah}
                    >
                      {menganalisaTambah ? (
                        <div
                          className="fm-dropzone-selected"
                          style={{
                            justifyContent: "center",
                            display: "flex",
                            alignItems: "center",
                          }}
                        >
                          <span style={{ color: "#2563eb", fontWeight: 700 }}>
                            ⏳ Membaca folder…
                          </span>
                        </div>
                      ) : analisaTambah ? (
                        <div className="fm-dropzone-selected">
                          <svg
                            width="34"
                            height="34"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="#16a34a"
                            strokeWidth="1.6"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M20 20h-8l-2-9h-4l-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h12a2 2 0 0 0 2 2v8a2 2 0 0 1-2 2z" />
                          </svg>
                          <div style={{ flex: 1, overflow: "hidden" }}>
                            <div className="fm-dropzone-filename">
                              {analisaTambah.namaFolder ||
                                (analisaTambah.kode
                                  ? `${analisaTambah.kode}.${analisaTambah.nama || ""}`
                                  : "Berkas baru")}
                            </div>
                            <div className="fm-dropzone-filesize">
                              {analisaTambah.files.length} berkas · {analisaTambah.jumlahPdf} PDF ·{" "}
                              {analisaTambah.jumlahExcel} Excel
                            </div>
                            <div className="fm-dropzone-filesize">
                              Realisasi: {formatRupiah(analisaTambah.totalRealisasi)} ·{" "}
                              {analisaTambah.sumber}
                            </div>
                            <div className="fm-dropzone-filesize" style={{ marginTop: 6, fontWeight: 700 }}>
                              {analisaTambah.files.map((f) => (
                                <div key={kunciPathBerkas(f.path, f.file.name)}>
                                  {f.file.name}
                                </div>
                              ))}
                            </div>
                            {analisaTambah.jumlahPdf === 0 && (
                              <div className="fm-dropzone-filesize">
                                Tanpa bukti PDF — realisasi dibaca dari berkas Excel/CSV.
                              </div>
                            )}
                            {analisaTambah.bulanList &&
                              analisaTambah.bulanList.length > 0 && (
                                <div
                                  style={{
                                    display: "flex",
                                    flexWrap: "wrap",
                                    gap: 6,
                                    marginTop: 8,
                                  }}
                                >
                                  {analisaTambah.bulanList.map((ym) => (
                                    <span
                                      key={ym}
                                      style={{
                                        border: "1px solid #bfdbfe",
                                        background: "#eff6ff",
                                        color: "#1e40af",
                                        borderRadius: 999,
                                        padding: "2px 10px",
                                        fontSize: 12,
                                        fontWeight: 600,
                                      }}
                                    >
                                      {ym} · {formatRupiah(analisaTambah.perBulan[ym])}
                                    </span>
                                  ))}
                                </div>
                              )}
                          </div>
                          <button
                            type="button"
                            className="fm-dropzone-clear"
                            title="Hapus folder/berkas"
                            disabled={santaiUpload}
                            onClick={() => {
                              setAnalisaTambah(null);
                              setStatusUpload(null);
                              setPesanFileTambah("");
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <>
                          <svg
                            width="38"
                            height="38"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke={dragTambah ? "#3b82f6" : "#9ca3af"}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="17 8 12 3 7 8" />
                            <line x1="12" y1="3" x2="12" y2="15" />
                          </svg>
                          <div className="fm-dropzone-text">
                            <strong>Tarik &amp; lepas folder / berkas</strong> ke area ini
                          </div>
                          <div className="fm-dropzone-hint">
                            Folder kegiatan + subfolder · PDF dan/atau Excel/CSV · tanpa bukti PDF
                          </div>
                        </>
                      )}
                    </div>
                    {pesanFileTambah && (
                      <p className="dk-seghint dk-seghint-warn">
                        {pesanFileTambah}
                      </p>
                    )}
                    {!GOOGLE_CLIENT_ID && (
                      <p className="dk-seghint dk-seghint-warn">
                        Unggahan dinonaktifkan: GOOGLE_CLIENT_ID belum diisi di{" "}
                        <code>src/components/DataKegiatan.js</code>.
                      </p>
                    )}
                    {daftarRekening.length > 0 && (
                      <div className="form-group" style={{ marginTop: 8 }}>
                        <label>Simpan ke rekening</label>
                        <select
                          className="filter-select"
                          style={{ width: "100%" }}
                          value={subFolderRekening}
                          disabled={santaiUpload}
                          onChange={(e) => setSubFolderRekening(e.target.value)}
                        >
                          <option value="">— Folder kegiatan (langsung) —</option>
                          {daftarRekening.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.kode} — {namaRekening(r.kode)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    {statusUpload && (
                      <p className="dk-uploadstatus">
                        {santaiUpload ? "⏳ " : ""}
                        {statusUpload}
                      </p>
                    )}
                    <p style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>
                      Data disimpan di browser ini (localStorage); berkasnya ikut
                      diunggah ke Google Drive. Bila kegiatan sudah ada di Drive,
                      gunakan folder-nya agar bukti kerja ikut terambil otomatis.
                    </p>
                  </div>
                )}
              </div>
              <div className="modal-footer" style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button
                  type="button"
                  className="btn-cancel"
                  onClick={tutupModalTambah}
                  disabled={santaiUpload}
                >
                  Batal
                </button>
                <button
                  type="submit"
                  className="btn-submit"
                  disabled={santaiUpload || menganalisaTambah}
                >
                  {santaiUpload ? "Mengunggah…" : "Simpan Data"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export { cocokCari, normalCari };
