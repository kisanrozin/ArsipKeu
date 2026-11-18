/* ══════════════════════════════════════════════════════════════
   KETERSEDIAAN ARSIP DIGITAL — DATA KEGIATAN (SPREADSHEET)
   ------------------------------------------------------------
   Sumber: tab kumulatif "Data Kegiatan" pada spreadsheet rekap
   (Jan, Jan-Feb, Jan-Maret, Jan-April, Jan-Mei, dst.) — sheet yang
   sama dengan Data Kegiatan. Tab dipilih sesuai bulan terpilih
   (kumulatif s.d. bulan tersebut).

   Kolom yang dipakai:
     C = Kegiatan/Output/Paket/Akun/Nomor SPM (uraian)
     F = Ketersediaan Arsip Digital

   Setiap baris "Nomor SPM : …" adalah satu entri SPM.
   Status dibaca dari kolom F:
     · "LENGKAP" (teks)  → arsip tersimpan
     · kosong / merah / lainnya → arsip tidak tersimpan

   Dibaca live lewat GVIZ (CORS-friendly, tanpa login).
   ══════════════════════════════════════════════════════════════ */

import { sheetIdAktif } from "./rekapKegiatan";
import { ambilTabSpreadsheet, petaTabRekap } from "./daftarSheet";

const UMUR_CACHE_MS = 5 * 60 * 1000; // 5 menit
const cachePerTab = new Map(); // tabNama -> { waktu, data }
const sedangPerTab = new Map(); // tabNama -> Promise

function parseSpmRows(rows) {
  const hasil = [];
  rows.forEach((sel) => {
    const uraian = String((sel && sel[2] && sel[2].v) || "").trim();
    if (!/nomor\s*spm/i.test(uraian)) return;

    const mNo = uraian.match(/nomor\s*spm\s*:?\s*([A-Za-z0-9-]+)/i);
    const mTgl = uraian.match(/\((\d{1,2})-(\d{1,2})-(\d{4})\)/);
    let tanggal = null;
    let bulan = 0;
    let tahun = 0;
    if (mTgl) {
      const dd = String(mTgl[1]).padStart(2, "0");
      const mm = String(mTgl[2]).padStart(2, "0");
      tahun = Number(mTgl[3]) || 0;
      bulan = Number(mm) || 0;
      tanggal = `${mTgl[3]}-${mm}-${dd}`;
    }

    const statusCell = sel && sel[5] ? sel[5].v : null;
    const status = statusCell == null ? "" : String(statusCell).trim();
    const tersimpan = status.toUpperCase() === "LENGKAP";

    hasil.push({
      noSpm: mNo ? mNo[1] : "—",
      tanggal,
      bulan,
      tahun,
      status,
      tersimpan,
    });
  });
  return hasil;
}

async function fetchGvizTab(sheetId, { gid, tabNama }) {
  const params = new URLSearchParams({
    tqx: "out:json",
    t: String(Date.now()),
  });
  if (gid) params.set("gid", String(gid));
  else if (tabNama) params.set("sheet", String(tabNama));

  const res = await fetch(
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${params.toString()}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const teks = await res.text();
  const awal = teks.indexOf("{");
  const akhir = teks.lastIndexOf("}");
  if (awal === -1 || akhir === -1) throw new Error("Balasan GVIZ tidak valid");
  const json = JSON.parse(teks.slice(awal, akhir + 1));
  const tabel = json && json.table;
  if (!tabel || !Array.isArray(tabel.rows)) return [];
  return tabel.rows.map((r) => (r && r.c) || []);
}

/* Cari tab kumulatif yang sesuai untuk nomor bulan (1-12).
   Mengembalikan { tabNama, gid } atau null. */
async function cariTabUntukBulan(sheetId, nomorBulan, paksa = false) {
  const bulan = Math.max(1, Math.min(12, Number(nomorBulan) || 0));
  const [peta, tabs] = await Promise.all([
    petaTabRekap(sheetId, paksa),
    ambilTabSpreadsheet(sheetId, paksa),
  ]);
  if (!peta || !Object.keys(peta).length) return null;

  // Pilih tab kumulatif terdekat <= bulan terpilih; jika belum ada, pakai terbaru yang ada.
  let targetNomor = bulan;
  while (targetNomor > 0 && !peta[targetNomor]) targetNomor -= 1;
  if (!targetNomor) {
    const tersedia = Object.keys(peta).map(Number).sort((a, b) => b - a)[0];
    targetNomor = tersedia || 0;
  }
  const tabNama = peta[targetNomor];
  if (!tabNama) return null;

  const info = (tabs || []).find((t) => t.nama === tabNama);
  return { tabNama, gid: info ? info.gid : null, nomorTab: targetNomor };
}

async function muatTab(sheetId, tabNama, gid, paksa = false) {
  const kunci = `${sheetId}::${tabNama}`;
  const cached = cachePerTab.get(kunci);
  if (!paksa && cached && Date.now() - cached.waktu < UMUR_CACHE_MS) {
    return cached.data;
  }
  if (sedangPerTab.has(kunci)) return sedangPerTab.get(kunci);

  const kerja = (async () => {
    try {
      const rows = await fetchGvizTab(sheetId, { gid, tabNama });
      const parsed = parseSpmRows(rows);
      const data = {
        rows: parsed,
        total: parsed.length,
        updatedAt: Date.now(),
        sheetId,
        tabNama,
        gid: gid || null,
      };
      cachePerTab.set(kunci, { waktu: Date.now(), data });
      return data;
    } catch (e) {
      console.warn(`Gagal membaca Ketersediaan Arsip Digital (${tabNama}):`, e);
      return cached ? cached.data : null;
    } finally {
      sedangPerTab.delete(kunci);
    }
  })();

  sedangPerTab.set(kunci, kerja);
  return kerja;
}

/* Ambil info tab kumulatif yang sesuai untuk bulan tertentu (tanpa memuat data). */
export async function infoTabKetersediaanBulan(nomorBulan, paksa = false) {
  const sheetId = sheetIdAktif();
  if (!sheetId) return null;
  const tab = await cariTabUntukBulan(sheetId, nomorBulan, paksa);
  if (!tab) return null;
  return { sheetId, tabNama: tab.tabNama, gid: tab.gid || null, nomorTab: tab.nomorTab };
}

/* Ambil data ketersediaan arsip kumulatif s.d. bulan tertentu (1-12).
   Otomatis memilih tab kumulatif yang sesuai (Jan-April, Jan-Mei, dst.). */
export async function ambilKetersediaanArsipBulan(nomorBulan, paksa = false) {
  const sheetId = sheetIdAktif();
  if (!sheetId) return null;
  const tab = await cariTabUntukBulan(sheetId, nomorBulan, paksa);
  if (!tab) return null;
  return muatTab(sheetId, tab.tabNama, tab.gid, paksa);
}

/* Hitung rekap kumulatif s.d. nomor bulan tertentu (1-12).
   Karena data dibaca dari tab kumulatif bulan tersebut, seluruh
   entri di dalamnya sudah mencakup s.d. bulan itu. Jika nomorBulan
   diberikan, tetap batasi berdasarkan bulan tanggal SPM agar aman. */
export function rekapKetersediaanSampai(data, nomorBulan) {
  const rows = (data && data.rows) || [];
  let total = 0;
  let tersimpan = 0;
  let totalTahun = 0;

  rows.forEach((r) => {
    if (!r) return;
    // totalTahun = semua entri SPM pada tab kumulatif (s.d. periode tab).
    totalTahun += 1;
    if (nomorBulan > 0 && r.bulan && r.bulan > nomorBulan) return;
    total += 1;
    if (r.tersimpan) tersimpan += 1;
  });

  return {
    total,
    tersimpan,
    belum: Math.max(0, total - tersimpan),
    totalTahun,
  };
}

