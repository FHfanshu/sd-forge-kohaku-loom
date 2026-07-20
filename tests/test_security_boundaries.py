import base64
import contextlib
import runpy
import sys
import tempfile
import types
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI

from prompt_agent import image_payloads, model_paths
from prompt_agent.reference_image import _reference_image_messages


class SecurityBoundaryTests(unittest.TestCase):
    def test_forge_script_registers_prompt_agent_api(self):
        script = Path(__file__).resolve().parents[1] / "scripts" / "prompt_agent.py"
        source = script.read_text(encoding="utf-8")
        self.assertIn("register_prompt_agent_api(app)", source)
        self.assertIn("script_callbacks.on_app_started", source)

    def test_forge_script_import_and_registration_do_not_create_dot_loom(self):
        root = Path(__file__).resolve().parents[1]
        marker = root / ".loom"
        callbacks = []
        gradio = types.ModuleType("gradio")
        gradio.Blocks = object
        modules = types.ModuleType("modules")
        modules.call_queue = types.SimpleNamespace(queue_lock=contextlib.nullcontext())
        modules.script_callbacks = types.SimpleNamespace(
            on_app_started=lambda callback, name=None: callbacks.append((callback, name))
        )
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            "os.environ",
            {"SD_FORGE_NEO_PROMPT_AGENT_DATA": directory},
            clear=False,
        ), patch.dict(sys.modules, {"gradio": gradio, "modules": modules}):
            self.assertFalse(marker.exists())
            runpy.run_path(str(root / "scripts" / "prompt_agent.py"), run_name="prompt_agent_startup_test")
            self.assertEqual(1, len(callbacks))
            self.assertEqual("prompt-agent-api", callbacks[0][1])
            callbacks[0][0](None, FastAPI())
            self.assertFalse(marker.exists())

    def test_reference_image_messages_import_and_include_image(self):
        image = MagicMock()
        with patch("prompt_agent.reference_image._image_data_url", return_value="data:image/jpeg;base64,AA=="):
            messages = _reference_image_messages(image)
        self.assertEqual("system", messages[0]["role"])
        self.assertEqual("image_url", messages[1]["content"][1]["type"])

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
        with patch.object(model_paths.Path, "is_file") as is_file:
            with self.assertRaisesRegex(RuntimeError, "远程"):
                model_paths.resolve_vision_model_pair("自定义", r"\\attacker\share\model.gguf", "", False)
        is_file.assert_not_called()

    def test_model_paths_reject_directories_as_model_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model_dir = root / "model.gguf"
            mmproj_dir = root / "mmproj-model.gguf"
            model_dir.mkdir()
            mmproj_dir.mkdir()

            with self.assertRaisesRegex(RuntimeError, "找不到"):
                model_paths.resolve_vision_model_pair("自定义", str(model_dir), "", False)
            with self.assertRaisesRegex(RuntimeError, "找不到"):
                model_paths.resolve_vision_model_pair("自定义", str(root / "model.bin"), str(mmproj_dir), False)

    def test_related_mmproj_ignores_directory_named_like_a_model(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            model = root / "model.gguf"
            model.touch()
            (root / "00-mmproj.gguf").mkdir()
            valid = root / "01-mmproj.gguf"
            valid.touch()

            self.assertEqual(str(valid), model_paths._find_related_mmproj(model))

    def test_zip_extraction_rejects_windows_traversal_and_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "payload.zip"
            target = root / "target"
            target.mkdir()
            with zipfile.ZipFile(archive, "w") as zip_file:
                zip_file.writestr(r"..\outside.exe", b"bad")

            with self.assertRaisesRegex(RuntimeError, "可疑路径"):
                model_paths._safe_extract_zip(archive, target)

            with zipfile.ZipFile(archive, "w") as zip_file:
                info = zipfile.ZipInfo("link")
                info.external_attr = (0o120777 << 16) | 0xA0000000
                zip_file.writestr(info, "outside.txt")

            with self.assertRaisesRegex(RuntimeError, "可疑路径"):
                model_paths._safe_extract_zip(archive, target)

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
