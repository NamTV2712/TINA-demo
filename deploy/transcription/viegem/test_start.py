"""Exercise real dotenvx encryption without loading model weights."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("dotenvx"), "dotenvx is not installed")
class EncryptedStartupTests(unittest.TestCase):
    def test_encrypted_token_wins_and_wrong_key_stops_startup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            worker = root / "deploy/transcription/viegem"
            worker.mkdir(parents=True)
            shutil.copy(Path(__file__).with_name("start.sh"), worker / "start.sh")
            python = root / ".venv/viegem/bin/python"
            python.parent.mkdir(parents=True)
            python.write_text('#!/bin/sh\n[ "$TINA_VIEGEM_TOKEN" = "fixture-encrypted-token-0123456789abcdef" ] || exit 9\n[ -z "${UNRELATED_SECRET:-}" ] || exit 10\nprintf started\n')
            python.chmod(0o700)
            env_file = root / ".env.viegem"
            env_file.write_text("TINA_VIEGEM_TOKEN=fixture-encrypted-token-0123456789abcdef\nUNRELATED_SECRET=must-not-reach-worker\n")
            env_file.chmod(0o600)
            env = {k: v for k, v in os.environ.items() if not k.startswith("DOTENV_PRIVATE_KEY")}
            encrypted = subprocess.run(["dotenvx", "encrypt", "-f", str(env_file),
                                        "-fk", str(root / ".env.keys")], env=env, cwd=root, capture_output=True)
            self.assertEqual(encrypted.returncode, 0)
            self.assertIn("encrypted:", env_file.read_text())
            env.update(TINA_VIEGEM_ENV_FILE=str(env_file), TINA_VIEGEM_TOKEN="ambient-wrong-token")
            run = subprocess.run(["sh", str(worker / "start.sh")], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(run.stdout.strip(), "started")
            key_file = root / ".env.keys"
            moved_key = root / "external.keys"
            key_file.rename(moved_key)
            env["TINA_VIEGEM_KEYS_FILE"] = str(moved_key)
            run = subprocess.run(["sh", str(worker / "start.sh")], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            moved_key.unlink()
            env["DOTENV_PRIVATE_KEY_VIEGEM"] = "1" * 64
            failed = subprocess.run(["sh", str(worker / "start.sh")], env=env, capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertNotIn("started", failed.stdout)
