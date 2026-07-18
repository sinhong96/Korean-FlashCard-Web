"""Unit tests for the pure text-parsing logic in tts_gen.py.

Run: python3 -m unittest test_tts_gen -v
"""

import unittest

from tts_gen import extract_chinese_definition


class ExtractChineseDefinitionTests(unittest.TestCase):
    def test_plain_definition(self):
        self.assertEqual(extract_chinese_definition("顺利"), "顺利")

    def test_strips_hanja_parenthetical(self):
        self.assertEqual(extract_chinese_definition("顺利 (順利)"), "顺利")

    def test_strips_english_suffix(self):
        self.assertEqual(
            extract_chinese_definition("顺利 (順利) / [EN] To go well"),
            "顺利",
        )

    def test_strips_dash_placeholder(self):
        self.assertEqual(extract_chinese_definition("难过 (---)"), "难过")

    def test_strips_trailing_slash(self):
        self.assertEqual(extract_chinese_definition("顺利/"), "顺利")

    def test_leaves_non_cjk_parenthetical_alone(self):
        self.assertEqual(extract_chinese_definition("顺利 (adj)"), "顺利 (adj)")


if __name__ == "__main__":
    unittest.main()
