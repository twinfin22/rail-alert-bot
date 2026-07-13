import importlib
import os
import sys
import types
import unittest
from pathlib import Path


class FakeTrain:
    train_no = "101"
    dep_date = "20990101"
    dep_time = "070000"
    arr_time = "093000"

    def has_general_seat(self):
        return True

    def has_special_seat(self):
        return False


class FakeKorail:
    instances = 0
    calls = []

    def __init__(self, user, password):
        type(self).instances += 1
        self.user = user
        self.password = password

    def search_train(self, *args, **kwargs):
        type(self).calls.append((args, kwargs))
        return [FakeTrain()]


class SearchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        fake = types.ModuleType("korail2")
        fake.Korail = FakeKorail
        fake.TrainType = types.SimpleNamespace(KTX="KTX")
        sys.modules["korail2"] = fake
        sys.path.insert(0, str(Path(__file__).parent))
        cls.search = importlib.import_module("search")
        cls.observe = importlib.import_module("observe")

    def setUp(self):
        FakeKorail.instances = 0
        FakeKorail.calls = []
        os.environ["KSKILL_KTX_ID"] = "test-id"
        os.environ["KSKILL_KTX_PASSWORD"] = "test-password"

    def test_one_client_normalizes_ktx_search(self):
        searcher = self.search.KtxSearcher()
        trains = searcher.search("서울", "부산", "20990101", "0600", "0800", "all")
        self.assertEqual(FakeKorail.instances, 1)
        self.assertEqual(len(FakeKorail.calls), 1)
        self.assertEqual(trains, [{"train_no": "101", "date": "20990101", "dep_time": "070000", "arr_time": "093000", "general_available": True, "special_available": False}])

    def test_room_filter_emits_requested_seats_only(self):
        trains = [{"train_no": "101", "date": "20990101", "dep_time": "070000", "general_available": True, "special_available": False}]
        self.assertEqual([seat["key"].split("|")[-1] for seat in self.observe.seats_for("q", trains, "general")["seats"]], ["general"])
        self.assertEqual([seat["key"].split("|")[-1] for seat in self.observe.seats_for("q", trains, "special")["seats"]], ["special"])
