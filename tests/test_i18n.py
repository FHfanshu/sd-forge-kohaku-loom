from __future__ import annotations

import unittest

from kohaku_loom.i18n import DEFAULT_LOCALE, TRANSLATIONS, forge_locale, normalize_locale, translation_bundle, tr


class I18nTests(unittest.TestCase):
    def test_supported_locales_have_the_same_keys(self):
        expected = set(TRANSLATIONS[DEFAULT_LOCALE])
        for locale, messages in TRANSLATIONS.items():
            self.assertEqual(expected, set(messages), locale)

    def test_locale_normalization(self):
        self.assertEqual("en", normalize_locale("en-US"))
        self.assertEqual("zh-CN", normalize_locale("zh_CN"))
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


if __name__ == "__main__":
    unittest.main()
