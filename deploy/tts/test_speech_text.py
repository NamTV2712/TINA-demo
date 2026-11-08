"""Spoken-copy boundaries and pronunciation isolation; no model inference."""
import unittest

from speech_text import Pronunciations, spoken_text


class SpeechTextTests(unittest.TestCase):
    def test_project_terms_are_explicitly_scoped_without_rewriting_the_display_text(self):
        config = Pronunciations({'default': {'TINA': 'ti na', 'API': 'ây pi ai'},
            'projects': {'alpha': {'ACME': 'ác mi'}, 'beta': {'ACME': 'ác mê'}},
            'meeting_projects': {'14': 'alpha', '25': 'beta'}})
        original = 'TINA gọi API của ACME.'
        self.assertEqual(spoken_text(original, config.for_meeting(14)), 'ti na gọi ây pi ai của ác mi.')
        self.assertEqual(spoken_text(original, config.for_meeting(25)), 'ti na gọi ây pi ai của ác mê.')
        self.assertEqual(spoken_text(original, config.for_meeting(99)), 'ti na gọi ây pi ai của ACME.')
        self.assertEqual(original, 'TINA gọi API của ACME.')

    def test_numeric_spans_use_installed_normalizer_and_preserve_negative_meaning(self):
        self.assertEqual(spoken_text('Hẹn 15:30, chi phí 2,5 triệu đồng.'),
                         'Hẹn mười lăm giờ ba mươi phút, chi phí hai phẩy năm triệu đồng.')
        self.assertEqual(spoken_text('-2,5 triệu đồng; 1.000.000 đồng; 12,5%.'),
                         'âm hai phẩy năm triệu đồng; một triệu đồng; mười hai phẩy năm phần trăm.')
        self.assertEqual(spoken_text('Mã 03/04.'), 'Mã không ba gạch chéo không bốn.')
        self.assertEqual(spoken_text('-100'), 'âm một trăm')
        self.assertEqual(spoken_text('-2.5'), 'âm hai chấm năm')
        self.assertIn('tháng tư', spoken_text('ngày 03/04/2026'))
        self.assertIn('tháng tư', spoken_text('2026-04-03'))
        for text in ['25:61', 'ngày 31/02/2026', 'v2.5', 'TINA_API', 'Tina123', 'retina']:
            self.assertEqual(spoken_text(text), text)

    def test_glossary_does_not_cascade_or_touch_code_urls_email_or_substrings(self):
        glossary = Pronunciations({'default': {'TINA':'ti na', 'API':'ây pi ai', 'SDK':'API'},
                                   'projects':{}, 'meeting_projects':{}}).for_meeting()
        text = 'SDK `TINA 15:30` https://tina.test/API/03/04 tina@example.com đTINA TINA.'
        self.assertEqual(spoken_text(text, glossary),
                         'API `TINA 15:30` https://tina.test/API/03/04 tina@example.com đTINA ti na.')

    def test_untrusted_or_unbounded_pronunciation_settings_fail_before_synthesis(self):
        invalid = [ {'default': {'v2':'version two'}, 'projects':{},'meeting_projects':{}},
                    {'default': {'API':'100 dollars'}, 'projects':{},'meeting_projects':{}},
                    {'default': {},'projects':{},'meeting_projects':{'14':'unknown'}},
                    {'default': {},'projects':{},'meeting_projects':{'14':[]}} ]
        for config in invalid:
            with self.subTest(config=config), self.assertRaises(ValueError): Pronunciations(config)


if __name__ == '__main__': unittest.main()
