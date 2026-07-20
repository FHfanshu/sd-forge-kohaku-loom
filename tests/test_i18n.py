from __future__ import annotations

import unittest

from prompt_agent.i18n import DEFAULT_LOCALE, TRANSLATIONS, forge_locale, locale_metadata, normalize_locale, translation_bundle, tr


class I18nTests(unittest.TestCase):
    def test_supported_locales_have_the_same_keys(self):
        expected = set(TRANSLATIONS[DEFAULT_LOCALE])
        for locale, messages in TRANSLATIONS.items():
            self.assertEqual(expected, set(messages), locale)

    def test_locale_normalization(self):
        self.assertEqual("en", normalize_locale("en-US"))
        self.assertEqual("zh-CN", normalize_locale("zh_CN"))
        self.assertEqual("zh-CN", normalize_locale("zh-TW"))
        self.assertEqual("zh-CN", normalize_locale("zh-Hant"))
        self.assertEqual(DEFAULT_LOCALE, normalize_locale("unknown"))

    def test_forge_default_localization_is_english(self):
        self.assertEqual("en", forge_locale(None))
        self.assertEqual("en", forge_locale("None"))
        self.assertEqual("en", forge_locale(""))
        self.assertEqual("zh-CN", forge_locale("zh_CN"))

    def test_translation_bundle_falls_back_to_selected_locale(self):
        bundle = translation_bundle("en")
        self.assertEqual("en", bundle["locale"])
        self.assertEqual("LLM Assistant", bundle["messages"]["assistant.launcher"])
        self.assertEqual("LLM 助手", tr("assistant.launcher", "zh-CN"))
        self.assertRegex(bundle["content_version"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(bundle["content_version"], bundle["metadata"]["content_version"])

    def test_active_assistant_branding_uses_prompt_agent(self):
        english = TRANSLATIONS["en"]
        chinese = TRANSLATIONS["zh-CN"]
        self.assertEqual("Message Prompt Agent", english["assistant.input.label"])
        self.assertEqual("Open Prompt Agent", english["assistant.open"])
        self.assertEqual("向 Prompt Agent 发送消息", chinese["assistant.input.label"])
        self.assertEqual("打开 Prompt Agent", chinese["assistant.open"])
        self.assertEqual("Powered by KohakuTerrarium", english["profiles.powered_by"])

    def test_python_ui_contract_has_exact_locale_parity_and_metadata_probe_shape(self):
        self.assertEqual(set(TRANSLATIONS["en"]), set(TRANSLATIONS["zh-CN"]))
        metadata = locale_metadata("zh_CN")
        self.assertEqual("zh-CN", metadata["locale"])
        self.assertEqual(["zh-CN", "en"], metadata["supported_locales"])
        self.assertEqual(metadata["content_version"], metadata["metadata"]["content_version"])


if __name__ == "__main__":
    unittest.main()
