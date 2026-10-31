import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import worker


class GuardTests(unittest.TestCase):
    def setUp(self):
        worker.EXPECTED = {}

    def test_live_capture_stops_experiment(self):
        with patch.object(worker.urllib.request, 'urlopen', return_value=io.StringIO(json.dumps({'live_sessions':1}))):
            with self.assertRaises(worker.ExperimentStopped): worker.guard()

    def test_missing_listener_stops_experiment(self):
        with patch.object(worker.urllib.request, 'urlopen', side_effect=OSError('unavailable')):
            with self.assertRaisesRegex(worker.ExperimentStopped, '8056 unavailable'): worker.guard()

    def test_replaced_process_stops_experiment(self):
        worker.EXPECTED = {'8056':{'pid':123,'started':1}}
        with patch.object(worker.urllib.request, 'urlopen', return_value=io.StringIO('{}')), patch.object(worker.psutil, 'pid_exists', return_value=False):
            with self.assertRaisesRegex(worker.ExperimentStopped, 'process 8056 changed'): worker.guard()

    def test_idle_services_and_memory_are_required(self):
        responses = [io.StringIO('{}'),io.StringIO(json.dumps({'queue':{'active':0,'waiting':0}}))]
        with patch.object(worker.urllib.request, 'urlopen', side_effect=responses), patch.object(worker.psutil, 'virtual_memory', return_value=SimpleNamespace(available=1024**3)):
            with self.assertRaisesRegex(worker.ExperimentStopped, '2 GiB'): worker.guard()


if __name__ == '__main__': unittest.main()
