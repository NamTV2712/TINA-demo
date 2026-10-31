import unittest

from decoder import Decoder, Draft, TokenStreamer, partial_text
from types import SimpleNamespace


class FakeValue:
    def __init__(self, *ids): self.ids = ids
    def reshape(self, *_): return self
    def tolist(self): return list(self.ids)


class TokenTests(unittest.TestCase):
    def test_prefix_rollback_respects_unicode_and_first_chunks(self):
        class Tokenizer:
            def encode(self, *_args, **_kwargs): return list(range(8))
            def decode(self, ids, **_kwargs): return '\ufffd' if len(ids)==3 else 'ab'
        decoder = Decoder.__new__(Decoder)
        decoder.asr = SimpleNamespace(processor=SimpleNamespace(tokenizer=Tokenizer()))
        self.assertEqual(decoder.prefix('previous output', 1), '')
        self.assertEqual(decoder.prefix('previous output', 2), 'ab')

    def test_headers_unicode_and_language_policy(self):
        self.assertIsNone(partial_text('language Vietnam'))
        self.assertIsNone(partial_text('language Vietnamese<asr_te'))
        self.assertEqual(partial_text('language Vietnamese<asr_text>Xin chào'), 'Xin chào')
        self.assertIsNone(partial_text('language English<asr_text>caf\ufffd'))
        self.assertIsNone(partial_text('language Chinese<asr_text>你好'))
        self.assertIsNone(partial_text('language English<asr_text>hello 你'))
        self.assertEqual(partial_text('language None<asr_text>'), '')

    def test_redecode_does_not_shrink_a_matching_prefix(self):
        events = []; draft = Draft(events.append)
        draft.update('Tôi sẽ gửi bản demo')
        draft.update('Tôi sẽ')
        self.assertEqual(len(events), 1)
        draft.update('Tôi sẽ sửa bản demo')
        self.assertEqual(events[-1]['type'], 'replace')
        draft.update('Tôi sẽ sửa', complete=True)
        self.assertEqual(draft.text, 'Tôi sẽ sửa')
        self.assertEqual([event['seq'] for event in events], [1, 2, 3])

    def test_put_emits_before_generate_returns_and_skips_prompt(self):
        events = []; draft = Draft(events.append)
        class Tokenizer:
            def decode(self, ids, **_): return ''.join({1:'language Vietnamese', 2:'<asr_text>', 3:'Xin', 4:' chào'}[i] for i in ids)
        streamer = TokenStreamer(Tokenizer(), '', None, draft, 0, 0, 16000)
        streamer.put(FakeValue(99, 100))
        self.assertEqual(streamer.ids, [])
        streamer.put(FakeValue(1)); streamer.put(FakeValue(2))
        self.assertEqual(events, [])
        streamer.put(FakeValue(3))
        self.assertEqual(events[-1]['delta'], 'Xin')
        self.assertTrue(events[-1]['during_generate'])
        streamer.put(FakeValue(4)); streamer.end()
        self.assertEqual(events[-1]['delta'], ' chào')
        self.assertEqual(draft.text, 'Xin chào')


if __name__ == '__main__': unittest.main()
