from __future__ import annotations

import json
import sys
from typing import Any

from search import KtxSearcher


def seats_for(query_key: str, trains: list[dict[str, Any]], room: str) -> dict[str, Any]:
    seats: list[dict[str, Any]] = []
    for train in trains:
        base = f"ktx|{train['train_no']}|{train['date']}|{train['dep_time']}"
        if room in {"general", "all"}:
            seats.append({
                "key": f"{base}|general",
                "available": bool(train["general_available"]),
                "label": f"KTX {train['train_no']} {train['dep_time']} general",
            })
        if room in {"special", "all"}:
            seats.append({
                "key": f"{base}|special",
                "available": bool(train["special_available"]),
                "label": f"KTX {train['train_no']} {train['dep_time']} special",
            })
    return {"query_key": query_key, "seats": seats}


def main() -> int:
    payload = json.load(sys.stdin)
    searcher = KtxSearcher()
    observations = []
    for item in payload:
        query = item["query"]
        trains = searcher.search(
            query["departure"],
            query["arrival"],
            query["date"],
            query["start_time"],
            query["end_time"],
            query["room"],
        )
        observations.append(seats_for(item["query_key"], trains, query["room"]))
    print(json.dumps(observations, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
