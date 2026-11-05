"""Platform choices are distinct from the mandatory real GPU probes during deployment."""
import unittest
from unittest.mock import patch

from test_make_entrypoint import stack


class DeviceSelectionTests(unittest.TestCase):
    def test_auto_selects_mps_on_apple_silicon_and_cuda_in_linux_or_wsl(self):
        for system, machine, expected in [("Darwin", "arm64", "mps"), ("Linux", "x86_64", "cuda"), ("Linux", "aarch64", "cuda")]:
            with self.subTest(system=system), patch.object(stack.platform, "system", return_value=system), \
                 patch.object(stack.platform, "machine", return_value=machine):
                self.assertEqual(stack.select_viegem_device(True), expected)

    def test_unsupported_host_never_silently_falls_back_to_cpu(self):
        for system, machine in [("Windows", "AMD64"), ("Darwin", "x86_64")]:
            with self.subTest(system=system), patch.object(stack.platform, "system", return_value=system), \
                 patch.object(stack.platform, "machine", return_value=machine), self.assertRaises(stack.StackError):
                stack.select_viegem_device(True)

    def test_cpu_requires_explicit_choice_and_unknown_modes_fail(self):
        self.assertEqual(stack.select_viegem_device(True, "cpu"), "cpu")
        self.assertEqual(stack.select_viegem_device(False), "disabled")
        with self.assertRaises(stack.StackError):
            stack.select_viegem_device(True, "mlx")
