import * as cheerio from "cheerio";
import type { Terminal, BusSchedule, ScrapeResult } from "./types.js";

const BASE = "https://txbus.t-money.co.kr";
const HEADERS: Record<string, string> = {
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** Search terminals by city name */
export async function searchTerminals(
  cityName: string,
  direction: "departure" | "arrival",
  preTerminalCode?: string
): Promise<Terminal[]> {
  const rtnGbn = direction === "departure" ? "01" : "02";
  const params = new URLSearchParams({
    cty_Bus_Area_Cd: "",
    trml_Nm: cityName,
    pre_Trml_Cd: preTerminalCode ?? "",
    rtnGbn,
  });

  const res = await fetch(`${BASE}/otck/readTrmlList.do`, {
    method: "POST",
    headers: HEADERS,
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`txbus terminal search failed: ${res.status}`);

  const data = (await res.json()) as TxbusTerminal[];
  return data.map((t) => ({
    code: t.trml_Cd,
    name: t.trml_Nm,
    areaCode: t.cty_Bus_Area_Cd,
    areaName: t.cty_Bus_Area_Nm,
  }));
}

/** Get bus schedule (seat availability) for a route */
export async function getSchedule(
  departureCode: string,
  arrivalCode: string,
  date: string // YYYYMMDD
): Promise<BusSchedule[]> {
  const params = new URLSearchParams({
    depr_Trml_Cd: departureCode,
    arvl_Trml_Cd: arrivalCode,
    depr_Dt: date,
    depr_Time: "000000",
    bef_Aft_Dvs: "D",
    req_Rec_Num: "100",
  });

  const res = await fetch(`${BASE}/otck/readAlcnList.do`, {
    method: "POST",
    headers: HEADERS,
    body: params.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`txbus schedule fetch failed: ${res.status}`);

  const html = await res.text();
  return parseScheduleHtml(html);
}

function parseScheduleHtml(html: string): BusSchedule[] {
  const $ = cheerio.load(html);
  const schedules: BusSchedule[] = [];

  // Use mobile table (class "accordian_table mobile_ver") — cleaner 4-col layout:
  // col0: time, col1: company(grade)estimatedTime, col2: adultFare, col3: seats
  $(".accordian_table.mobile_ver table tbody tr").each((_, row) => {
    const cells: string[] = [];
    $(row)
      .find("td")
      .each((_, td) => {
        cells.push($(td).text().trim());
      });

    if (cells.length < 4) return;
    if (cells[0].includes("예매 가능한 내역이 없습니다")) return;
    if (cells[0].includes("노선정보")) return;

    const time = cells[0]; // "06:32"
    if (!time.match(/^\d{2}:\d{2}$/)) return;

    // cells[1]: "동해상사고속(일반)2:20 소요 예상"
    const infoText = cells[1];
    const gradeMatch = infoText.match(/\((일반|우등|프리미엄)\)/);
    const grade = gradeMatch?.[1] ?? "일반";
    const company = infoText.split("(")[0].trim();
    const estMatch = infoText.match(/(\d+:\d+\s*소요\s*예상)/);
    const estimatedTime = estMatch?.[1];

    // cells[2]: "17,200원"
    const adultFare = parseInt(cells[2].replace(/[^0-9]/g, "") || "0", 10);

    // cells[3]: "5석/총28석" or "매진"
    const seatText = cells[3];
    const seatMatch = seatText.match(/(\d+)\s*석.*?총\s*(\d+)\s*석/);
    const remaining = seatMatch ? parseInt(seatMatch[1], 10) : 0;
    const total = seatMatch ? parseInt(seatMatch[2], 10) : 0;

    schedules.push({
      departureTime: time,
      remainingSeats: remaining,
      totalSeats: total,
      busGrade: grade,
      busCompany: company || undefined,
      estimatedTime,
      adultFare,
    });
  });

  return schedules;
}

/** Full scrape: terminals + schedule */
export async function scrape(
  departureCode: string,
  arrivalCode: string,
  date: string,
  departureName?: string,
  arrivalName?: string
): Promise<ScrapeResult> {
  const schedules = await getSchedule(departureCode, arrivalCode, date);
  return {
    provider: "txbus",
    departure: { code: departureCode, name: departureName ?? departureCode },
    arrival: { code: arrivalCode, name: arrivalName ?? arrivalCode },
    date,
    schedules,
    scrapedAt: new Date().toISOString(),
  };
}

// Internal txbus JSON response type
interface TxbusTerminal {
  trml_Cd: string;
  trml_Nm: string;
  cty_Bus_Area_Cd: string;
  cty_Bus_Area_Nm: string;
  hmpg_Tisu_Psb_Yn: string;
  [key: string]: unknown;
}
