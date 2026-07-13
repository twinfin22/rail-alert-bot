export interface Terminal {
  code: string;
  name: string;
  areaCode?: string;
  areaName?: string;
}

export interface BusSchedule {
  departureTime: string; // "HH:MM"
  remainingSeats: number;
  totalSeats: number;
  busGrade: string; // "일반", "우등", "프리미엄"
  busCompany?: string;
  estimatedTime?: string; // "2:20 소요 예상"
  adultFare?: number;
}

export type BusProvider = "txbus" | "kobus";

export interface ScrapeResult {
  provider: BusProvider;
  departure: Terminal;
  arrival: Terminal;
  date: string; // YYYYMMDD
  schedules: BusSchedule[];
  scrapedAt: string; // ISO
}
