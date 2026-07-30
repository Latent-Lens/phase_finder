#!/usr/bin/env python3

import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "tests/e2e/driving_code"))
from test_server import is_hidden_test_path, production_headers, start_test_server


class TestServerIsolationTests(unittest.TestCase):
    def start_server_or_skip(self):
        try:
            return start_test_server(root)
        except RuntimeError as error:
            self.skipTest(f"socket bind unavailable: {error}")

    def test_only_local_autoload_path_is_hidden(self):
        self.assertTrue(is_hidden_test_path("/sessions/phasefinder_local.json?cache=1"))
        self.assertFalse(is_hidden_test_path("/sessions/phasefinder_local.example.json"))

    def test_production_headers_are_applied_from_dist_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "_headers").write_text("/*\n  X-Test: production\n")
            self.assertEqual(dict(production_headers(directory)), {"X-Test": "production"})

    def test_two_servers_hide_local_session_without_mutating_it(self):
        session = root / "sessions/phasefinder_local.json"
        before = session.read_bytes() if session.exists() else None
        servers = [self.start_server_or_skip()]
        try:
            servers.append(self.start_server_or_skip())
            for port, _ in servers:
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/sessions/phasefinder_local.json",
                        timeout=2,
                    )
                self.assertEqual(error.exception.code, 404)
        finally:
            for _, server in servers:
                server.shutdown()
                server.server_close()
        after = session.read_bytes() if session.exists() else None
        self.assertEqual(after, before)

    def test_keyboard_interrupt_needs_no_restoration(self):
        session = root / "sessions/phasefinder_local.json"
        before = session.read_bytes() if session.exists() else None
        port, server = self.start_server_or_skip()
        try:
            raise KeyboardInterrupt
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()
        after = session.read_bytes() if session.exists() else None
        self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
