import * as cheerio from "cheerio";

export interface SrtTrain {
  trainNo: string;
  date: string;
  depTime: string;
  arrTime: string;
  generalAvailable: boolean;
  specialAvailable: boolean;
  generalState: string;
  specialState: string;
}

interface Station {
  code: string;
  name: string;
}

const BASE = "https://etk.srail.kr";
const MAIN_PATH = "/main.do?language=EN";
const SCHEDULE_PATH = "/hpg/hra/fr/01/selectScheduleList.do?pageId=TE0101000000";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36";

const STATION_ALIASES: Record<string, string> = {
  "경주": "Gyeongju",
  "곡성": "Gokseong",
  "공주": "Gongju",
  "광주송정": "Gwangju-Songjeong",
  "광명": "Gwangmyeong",
  "구례구": "Guryegu",
  "구포": "Gupo",
  "김천구미": "Gimcheon-Gumi",
  "나주": "Naju",
  "남원": "Namwon",
  "대전": "Daejeon",
  "동대구": "Dongdaegu",
  "동탄": "Dongtan",
  "마산": "Masan",
  "목포": "Mokpo",
  "물금": "Mulgeum",
  "밀양": "Miryang",
  "부산": "Busan",
  "서대구": "Seodaegu",
  "서울": "Seoul",
  "수서": "Suseo",
  "순천": "Suncheon",
  "여수엑스포": "Yeosu-EXPO",
  "여천": "Yeocheon",
  "오송": "Osong",
  "울산": "Ulsan-Tongdosa",
  "울산통도사": "Ulsan-Tongdosa",
  "익산": "Iksan",
  "전주": "Jeonju",
  "정읍": "Jeongeup",
  "진영": "Jinyeong",
  "진주": "Jinju",
  "창원": "Changwon",
  "창원중앙": "ChangwonJungang",
  "천안아산": "CheonanAsan",
  "평택지제": "PyeongtaekJije",
  "포항": "Pohang",
};

export async function searchSrt(query: { departure: string; arrival: string; date: string; start_time: string; end_time: string }): Promise<SrtTrain[]> {
  const start = normalizeTime(query.start_time);
  const end = normalizeTime(query.end_time);
  if (start > end) throw new Error("SRT start_time must be before end_time");
  const client = new SrtClient();
  const stations = await client.loadStations();
  const departure = resolveStation(query.departure, stations);
  const arrival = resolveStation(query.arrival, stations);
  if (departure.code === arrival.code) throw new Error("SRT departure and arrival must differ");
  const html = await client.fetchSchedule(departure, arrival, query.date, start);
  return parseSrtSchedule(html, query.date).filter((train) => start <= normalizeTime(train.depTime) && normalizeTime(train.depTime) <= end);
}

export function parseSrtSchedule(html: string, date: string): SrtTrain[] {
  const $ = cheerio.load(html);
  const pageText = $.text().replace(/\s+/g, " ");
  if (pageText.includes("Input value error")) throw new Error("SRT returned input value error");
  if (pageText.includes("IP") && (pageText.includes("제한") || pageText.toLowerCase().includes("blocked"))) throw new Error("SRT appears to be blocking this IP");
  const rows = $("#search-list tbody tr").toArray();
  if (!rows.length) {
    if (pageText.includes("No results") || pageText.includes("No train")) return [];
    throw new Error("Could not parse SRT schedule rows");
  }
  return rows.flatMap((row) => {
    const cells = $(row).find("td").toArray();
    if (cells.length < 6) return [];
    const hidden = hiddenInputs($, row);
    const trainNo = (hidden.trnNo || trainNumber($(cells[1]).text())).replace(/^0+/, "");
    const depTime = hidden.dptTm || timeFromCell($(cells[2]).text());
    const arrTime = timeFromCell($(cells[3]).text());
    if (!trainNo || !depTime) return [];
    const specialState = cleanText($(cells[4]).text());
    const generalState = cleanText($(cells[5]).text());
    return [{
      trainNo,
      date: hidden.runDt || hidden.dptDt || date,
      depTime,
      arrTime,
      generalAvailable: available(generalState),
      specialAvailable: available(specialState),
      generalState,
      specialState,
    }];
  });
}

class SrtClient {
  private cookie = "";

  async loadStations(): Promise<Map<string, Station>> {
    const html = await this.request("GET", MAIN_PATH);
    const $ = cheerio.load(html);
    const stations = new Map<string, Station>();
    $("select#dptRsStnCd option").each((_, option) => {
      const code = ($(option).attr("value") || "").trim();
      const name = cleanText($(option).text());
      if (code && name) stations.set(stationKey(name), { code, name });
    });
    if (!stations.size) throw new Error("Could not load SRT station codes");
    return stations;
  }

  async fetchSchedule(departure: Station, arrival: Station, date: string, time: string): Promise<string> {
    await this.request("GET", SCHEDULE_PATH);
    const body = new URLSearchParams({
      dptRsStnCd: departure.code,
      arvRsStnCd: arrival.code,
      stlbTrnClsfCd: "05",
      psgNum: "",
      seatAttCd: "",
      isRequest: "Y",
      chtnDvCd: "1",
      trnGpCd: "300",
      dptRsStnCdNm: departure.name,
      arvRsStnCdNm: arrival.name,
      dptDt: date,
      dptTm: time,
      psgInfoPerPrnb1: "1",
      psgInfoPerPrnb5: "0",
      locSeatAttCd1: "000",
      rqSeatAttCd1: "015",
    });
    return this.request("POST", SCHEDULE_PATH, body);
  }

  private async request(method: "GET" | "POST", path: string, body?: URLSearchParams): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${BASE}${SCHEDULE_PATH}`,
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
    const response = await fetch(`${BASE}${path}`, { method, headers, body, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`SRT request failed: ${response.status}`);
    const cookies = response.headers.getSetCookie?.() ?? [];
    if (cookies.length) this.cookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");
    return response.text();
  }
}

function resolveStation(value: string, stations: Map<string, Station>): Station {
  const alias = STATION_ALIASES[stationKey(value)] ?? value;
  const station = stations.get(stationKey(alias));
  if (!station) throw new Error(`Unknown SRT station: ${value}`);
  return station;
}

function hiddenInputs($: cheerio.CheerioAPI, row: any): Record<string, string> {
  const values: Record<string, string> = {};
  $(row).find("input[type=hidden]").each((_, input) => {
    const name = ($(input).attr("name") || "").replace(/\[\d+\]$/, "");
    if (name) values[name] = ($(input).attr("value") || "").trim();
  });
  return values;
}

function normalizeTime(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 4) return `${digits}00`;
  if (digits.length === 6) return digits;
  throw new Error("time must be HHMM or HHMMSS");
}

function timeFromCell(text: string): string {
  const match = text.match(/\b(\d{1,2}):(\d{2})\b/);
  return match ? `${match[1].padStart(2, "0")}${match[2]}00` : "";
}

function trainNumber(text: string): string {
  return text.match(/\b0*(\d{1,5})\b/)?.[1] ?? "";
}

function available(state: string): boolean {
  const text = state.toLowerCase();
  return Boolean(state) && !text.includes("sold-out") && !text.includes("sold out");
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function stationKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^0-9a-z가-힣]/g, "");
}
