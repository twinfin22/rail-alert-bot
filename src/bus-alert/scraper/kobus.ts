import * as cheerio from "cheerio";
import type { Terminal, BusSchedule, ScrapeResult } from "./types.js";

const BASE = "https://www.kobus.co.kr";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36";
const HEADERS_FORM = { "Content-Type": "application/x-www-form-urlencoded" };

/** Fetch all terminals + routes from kobus master data */
export async function getMasterData(): Promise<{
  terminals: Terminal[];
  routes: KobusRoute[];
}> {
  const res = await fetch(`${BASE}/mrs/readRotLinInf.ajax`, {
    method: "POST",
    headers: { ...HEADERS_FORM, "User-Agent": UA },
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`kobus master data failed: ${res.status}`);

  const data = (await res.json()) as KobusMasterData;
  const terminalMap = new Map<string, Terminal>();

  for (const r of data.rotInfList) {
    if (r.deprCd && r.deprNm)
      terminalMap.set(r.deprCd, {
        code: r.deprCd,
        name: r.deprNm,
        areaCode: r.deprArea,
      });
    if (r.arvlCd && r.arvlNm)
      terminalMap.set(r.arvlCd, {
        code: r.arvlCd,
        name: r.arvlNm,
        areaCode: r.arvlArea,
      });
  }

  const routes = data.rotInfList.map((r) => ({
    departureCode: r.deprCd,
    arrivalCode: r.arvlCd,
    takeTime: parseInt(r.takeTime) || null,
  }));

  return {
    terminals: Array.from(terminalMap.values()),
    routes,
  };
}

/** Search terminals by city name (from cached master data) */
export function filterTerminals(
  terminals: Terminal[],
  cityName: string
): Terminal[] {
  return terminals.filter((t) => t.name.includes(cityName));
}

/** Get available destinations from a departure terminal */
export function getDestinations(
  routes: KobusRoute[],
  terminals: Terminal[],
  departureCode: string
): Terminal[] {
  const arrivalCodes = new Set(
    routes
      .filter((r) => r.departureCode === departureCode)
      .map((r) => r.arrivalCode)
  );
  const terminalMap = new Map(terminals.map((t) => [t.code, t]));
  return Array.from(arrivalCodes)
    .map((code) => terminalMap.get(code))
    .filter((t): t is Terminal => t !== undefined);
}

/** Get bus schedule with seat info */
export async function getSchedule(
  departureCode: string,
  departureName: string,
  arrivalCode: string,
  arrivalName: string,
  date: string // YYYYMMDD
): Promise<BusSchedule[]> {
  // Step 1: Get session cookie
  const sessionRes = await fetch(`${BASE}/mrs/rotinf.do`, {
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!sessionRes.ok && sessionRes.status !== 302) {
    throw new Error(`kobus session failed: ${sessionRes.status}`);
  }

  const cookies = sessionRes.headers.getSetCookie?.() ?? [];
  const cookieStr = cookies.map((c) => c.split(";")[0]).join("; ");

  // Step 2: Build form params
  const formatted = formatDate(date);
  const params = new URLSearchParams({
    deprCd: departureCode,
    deprNm: departureName,
    arvlCd: arrivalCode,
    arvlNm: arrivalName,
    pathDvs: "sngl",
    pathStep: "1",
    crchDeprArvlYn: "N",
    deprDtm: date,
    deprDtmAll: formatted,
    arvlDtm: date,
    arvlDtmAll: formatted,
    busClsCd: "0",
    prmmDcYn: "N",
    tfrCd: "",
    tfrNm: "",
    tfrArvlFullNm: "",
    abnrData: "",
  });

  // Step 3: Fetch schedule page
  const res = await fetch(`${BASE}/mrs/alcnSrch.do`, {
    method: "POST",
    headers: {
      ...HEADERS_FORM,
      "User-Agent": UA,
      Referer: `${BASE}/mrs/rotinf.do`,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      Cookie: cookieStr,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`kobus schedule fetch failed: ${res.status}`);

  const html = await res.text();
  return parseScheduleHtml(html);
}

function parseScheduleHtml(html: string): BusSchedule[] {
  const $ = cheerio.load(html);
  const schedules: BusSchedule[] = [];

  $('div.bus_time p[role="row"]').each((_, row) => {
    const $row = $(row);
    const time = $row.find("span.start_time").text().trim().replace(/\s+/g, "");
    const remainText = $row.find("span.remain").text().trim();
    const status = $row.find("span.status").text().trim();
    const grade = $row.find("span.grade").first().text().trim();
    const company = $row.find("span.bus_com span").text().trim();

    if (!time.match(/^\d{2}:\d{2}$/)) return;

    const isSoldOut =
      status.includes("매진") || remainText.includes("0 석");
    const seatMatch = remainText.match(/(\d+)/);
    const remaining = isSoldOut ? 0 : seatMatch ? parseInt(seatMatch[1], 10) : 0;

    schedules.push({
      departureTime: time,
      remainingSeats: remaining,
      totalSeats: 0, // kobus doesn't show total
      busGrade: grade.replace(/\s*경유.*/, "") || "일반",
      busCompany: company || undefined,
    });
  });

  return schedules;
}

/** Full scrape */
export async function scrape(
  departureCode: string,
  departureName: string,
  arrivalCode: string,
  arrivalName: string,
  date: string
): Promise<ScrapeResult> {
  const schedules = await getSchedule(
    departureCode,
    departureName,
    arrivalCode,
    arrivalName,
    date
  );
  return {
    provider: "kobus",
    departure: { code: departureCode, name: departureName },
    arrival: { code: arrivalCode, name: arrivalName },
    date,
    schedules,
    scrapedAt: new Date().toISOString(),
  };
}

function formatDate(ymd: string): string {
  // "20260405" → "2026-04-05"
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

// Internal types
interface KobusMasterData {
  rotInfList: KobusMasterRoute[];
  tfrInfList: KobusMasterRoute[];
}

interface KobusMasterRoute {
  deprCd: string;
  deprNm: string;
  deprArea: string;
  arvlCd: string;
  arvlNm: string;
  arvlArea: string;
  takeTime: string;
  tfrCd?: string;
  tfrNm?: string;
  tfrArea?: string;
  [key: string]: unknown;
}

export interface KobusRoute {
  departureCode: string;
  arrivalCode: string;
  takeTime: number | null;
}
