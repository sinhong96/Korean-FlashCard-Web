"""Unit tests for the pure text-parsing logic in tts_gen.py.

Run: python3 -m unittest test_tts_gen -v
"""

import tempfile
import textwrap
import unittest

from tts_gen import extract_chinese_definition, read_session_rows


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


class ReadSessionRowsTests(unittest.TestCase):
    def _write_csv(self, content):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".csv", encoding="utf-8", delete=False)
        f.write(textwrap.dedent(content))
        f.close()
        return f.name

    def test_skips_rows_with_wrong_language_in_word_or_definition(self):
        path = self._write_csv("""\
            Word,Definition,Sentence
            안목,眼光 (眼目) / [EN] discernment,장기적인 안목이 필요하다.
            打破,创下 (打破) / [EN] To break,他打破了玻璃杯。
        """)
        pairs = read_session_rows(path)
        self.assertEqual(pairs, [("안목", "眼光")])


if __name__ == "__main__":
    unittest.main()
