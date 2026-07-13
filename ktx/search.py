"""Read-only KTX search adapter.

Derived from NomaDamas/k-skill@0c1bcdc9288545297897b0eee349d30ab2e1b230.
This adapter intentionally exposes only authentication and search normalization.
"""
from __future__ import annotations
import os
from typing import Any

from korail2 import Korail, TrainType

def search(departure: str, arrival: str, date: str, start_time: str, end_time: str, room: str) -> list[dict[str, Any]]:
    user = os.environ["KSKILL_KTX_ID"]
    password = os.environ["KSKILL_KTX_PASSWORD"]
    if room not in {"general", "special", "all"}:
        raise ValueError("room must be general, special, or all")
    client = Korail(user, password)  # one login per poll process
    trains = client.search_train(departure, arrival, date, start_time.zfill(6), TrainType.KTX, include_no_seats=True)
    normalized = []
    for train in trains:
        if not (start_time.zfill(6) <= train.dep_time <= end_time.zfill(6)):
            continue
        general = bool(train.has_general_seat())
        special = bool(train.has_special_seat())
        if room == "general" and not general:
            continue
        if room == "special" and not special:
            continue
        normalized.append({"train_no": str(train.train_no), "date": str(train.dep_date), "dep_time": str(train.dep_time), "arr_time": str(train.arr_time), "general_available": general, "special_available": special})
    return normalized
