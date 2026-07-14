import base64
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from lib_qwen3vl_prompt_tools import image_payloads, model_paths


class SecurityBoundaryTests(unittest.TestCase):
    def test_llama_server_path_must_be_server_configured(self):
        with tempfile.TemporaryDirectory() as directory:
            trusted = Path(directory) / "trusted.exe"
            untrusted = Path(directory) / "untrusted.exe"
            trusted.touch()
            untrusted.touch()
            with patch.dict("os.environ", {"LLAMA_SERVER_EXE": str(trusted)}, clear=False):
                self.assertEqual(str(trusted.resolve()), model_paths.resolve_llama_server(str(trusted)))
                with self.assertRaisesRegex(RuntimeError, "未受信任"):
                    model_paths.resolve_llama_server(str(untrusted))

    def test_llama_server_rejects_unc_before_filesystem_access(self):
        with patch.object(model_paths.Path, "is_file") as is_file:
            with self.assertRaisesRegex(RuntimeError, "远程"):
                model_paths.resolve_llama_server(r"\\attacker\share\payload.exe")
        is_file.assert_not_called()

    def test_model_paths_reject_unc_before_filesystem_access(self):
        with patch.object(model_paths.Path, "exists") as exists:
            with self.assertRaisesRegex(RuntimeError, "远程"):
                model_paths.resolve_vision_model_pair("自定义", r"\\attacker\share\model.gguf", "", False)
        exists.assert_not_called()

    def test_inline_image_rejects_decoded_payload_over_limit(self):
        raw = base64.b64encode(b"123456789").decode("ascii")
        with patch.object(image_payloads, "MAX_IMAGE_BYTES", 8):
            with self.assertRaisesRegex(RuntimeError, "too large"):
                image_payloads._data_url_inline_data("data:image/png;base64," + raw)

    def test_image_dimensions_are_checked_before_conversion(self):
        fake = MagicMock()
        fake.size = (5000, 5000)
        with patch.object(image_payloads.Image, "open", return_value=fake):
            with self.assertRaisesRegex(RuntimeError, "dimensions"):
                image_payloads._image_from_data_url("data:image/png;base64," + base64.b64encode(b"png").decode("ascii"))
        fake.convert.assert_not_called()


if __name__ == "__main__":
    unittest.main()
