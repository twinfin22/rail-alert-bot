"""Read-only KTX search adapter.

Derived from NomaDamas/k-skill@0c1bcdc9288545297897b0eee349d30ab2e1b230.
This adapter intentionally exposes only authentication and search normalization.
"""
from __future__ import annotations
import os
from typing import Any

from korail2 import Korail, TrainType

class KtxSearcher:
    def __init__(self) -> None:
        user = os.environ["KSKILL_KTX_ID"]
        password = os.environ["KSKILL_KTX_PASSWORD"]
        self.client = Korail(user, password)

    def search(self, departure: str, arrival: str, date: str, start_time: str, end_time: str, room: str) -> list[dict[str, Any]]:
        if room not in {"general", "special", "all"}:
            raise ValueError("room must be general, special, or all")
        start = start_time.zfill(6)
        end = end_time.zfill(6)
        trains = self.client.search_train(departure, arrival, date, start, TrainType.KTX, include_no_seats=True)
        normalized = []
        for train in trains:
            if not (start <= train.dep_time <= end):
                continue
            general = bool(train.has_general_seat())
            special = bool(train.has_special_seat())
            normalized.append({"train_no": str(train.train_no), "date": str(train.dep_date), "dep_time": str(train.dep_time), "arr_time": str(train.arr_time), "general_available": general, "special_available": special})
        return normalized


def search(departure: str, arrival: str, date: str, start_time: str, end_time: str, room: str) -> list[dict[str, Any]]:
    return KtxSearcher().search(departure, arrival, date, start_time, end_time, room)
