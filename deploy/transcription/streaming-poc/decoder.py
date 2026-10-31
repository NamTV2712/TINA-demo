"""Experimental decoder-token callbacks, using the already installed Qwen Transformers runtime."""
from __future__ import annotations

import re
import time

RATE = 16000
MAX_SAMPLES = RATE * 15
TAG = '<asr_text>'


def partial_text(raw, forced=None):
    """Do not expose language/control headers or half-decoded UTF-8 to a caption consumer."""
    if forced:
        language, text = forced, raw
    elif TAG in raw:
        metadata, text = raw.split(TAG, 1)
        language = metadata.strip().removeprefix('language ').strip()
    else:
        return None
    languages = {part.strip().casefold() for part in language.split(',') if part.strip()}
    if not languages <= {'vietnamese', 'english', 'none'} or '\ufffd' in text or re.search(r'[\u3400-\u9fff\uf900-\ufaff]', text):
        return None
    return text.lstrip()


class Draft:
    def __init__(self, emit):
        self.text, self.sequence, self.replacements = '', 0, 0
        self.emit = emit

    def update(self, text, *, complete=False, **metadata):
        if text is None or text == self.text or (not complete and self.text.startswith(text)):
            return
        event = {'type': 'delta', 'delta': text[len(self.text):]} if text.startswith(self.text) else {'type': 'replace'}
        if event['type'] == 'replace':
            self.replacements += 1
        self.sequence += 1
        self.text = text
        self.emit({**metadata, **event, 'seq': self.sequence, 'text': text})


class TokenStreamer:
    """The generate() streamer protocol; put() runs before model.generate() returns."""
    def __init__(self, tokenizer, prefix, forced, draft, started, chunk, sample_end):
        self.tokenizer, self.prefix, self.forced, self.draft = tokenizer, prefix, forced, draft
        self.started, self.chunk, self.sample_end = started, chunk, sample_end
        self.ids, self.times, self.prompt = [], [], True

    def put(self, value):
        if self.prompt:
            self.prompt = False
            return
        self.ids.extend(value.reshape(-1).tolist())
        elapsed = time.perf_counter() - self.started
        self.times.append(elapsed)
        raw = self.prefix + self.tokenizer.decode(self.ids, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        self.draft.update(partial_text(raw, self.forced), chunk=self.chunk, source_end_sample=self.sample_end,
                          token=len(self.ids), decode_s=elapsed, during_generate=True)

    def end(self):
        pass


class Decoder:
    def __init__(self, checkpoint):
        import torch
        from qwen_asr import Qwen3ASRModel

        if not torch.backends.mps.is_available():
            raise RuntimeError('This PoC requires MPS; no automatic CPU fallback')
        torch.set_num_threads(2)
        torch.mps.set_per_process_memory_fraction(.25)
        self.torch = torch
        self.asr = Qwen3ASRModel.from_pretrained(str(checkpoint), dtype=torch.bfloat16, device_map='mps',
            local_files_only=True, max_new_tokens=256, max_inference_batch_size=1)
        self.asr.model.eval()
        if not all(parameter.device.type == 'mps' for parameter in self.asr.model.parameters()):
            raise RuntimeError('ASR parameters are not all on MPS')

    def prefix(self, raw, chunk):
        if chunk < 2:
            return ''
        tokenizer = self.asr.processor.tokenizer
        ids = tokenizer.encode(raw, add_special_tokens=False)
        for rollback in range(5, len(ids) + 6):
            prefix = tokenizer.decode(ids[:max(0, len(ids)-rollback)], skip_special_tokens=True)
            if '\ufffd' not in prefix:
                return prefix
        return ''

    def decode(self, audio, draft, *, chunk=0, prefix='', stream=True, guard=lambda: None):
        import numpy as np
        from transformers import StoppingCriteria, StoppingCriteriaList
        from qwen_asr import parse_asr_output

        if audio.ndim != 1 or not 0 < len(audio) <= MAX_SAMPLES or not np.isfinite(audio).all():
            raise ValueError('Use finite mono PCM16k, at most 15 seconds')
        guard()
        torch = self.torch
        torch.mps.synchronize()
        started = time.perf_counter()
        # shortcut: pinned qwen-asr 0.0.6 private prompt API; replace with a versioned adapter before production.
        prompt = self.asr._build_text_prompt(context='', force_language=None) + prefix
        inputs = self.asr.processor(text=[prompt], audio=[audio], return_tensors='pt', padding=True)
        inputs = inputs.to(self.asr.model.device).to(self.asr.model.dtype)
        streamer = TokenStreamer(self.asr.processor.tokenizer, prefix, None, draft, started, chunk, len(audio))
        cancelled = []

        class Stop(StoppingCriteria):
            checked = started

            def __call__(self, *_args, **_kwargs):
                if time.perf_counter() - self.checked >= .5:
                    self.checked = time.perf_counter()
                    try:
                        guard()
                    except Exception as error:
                        cancelled.append(error)
                return bool(cancelled)

        options = {'streamer': streamer} if stream else {}
        with torch.inference_mode():
            output = self.asr.model.generate(**inputs, max_new_tokens=256, do_sample=False,
                stopping_criteria=StoppingCriteriaList([Stop()]), **options)
        torch.mps.synchronize()
        elapsed = time.perf_counter() - started
        if cancelled:
            raise cancelled[0]
        ids = output.sequences[0, inputs['input_ids'].shape[1]:].tolist()
        if not ids or ids[-1] not in self.asr.model.generation_config.eos_token_id:
            raise RuntimeError('Generation did not finish with EOS; result is not final')
        raw = prefix + self.asr.processor.tokenizer.decode(ids, skip_special_tokens=True, clean_up_tokenization_spaces=False)
        language, text = parse_asr_output(raw)
        if not TAG in raw or '\ufffd' in text:
            raise RuntimeError('Incomplete ASR protocol or Unicode output')
        safe = partial_text(raw)
        draft.update(text if safe is not None else None, complete=True, chunk=chunk, source_end_sample=len(audio),
                     decode_s=elapsed, during_generate=False)
        return {'raw': raw, 'language': language, 'text': text, 'eligible': safe is not None,
                'generation_s': elapsed, 'first_token_s': streamer.times[0] if streamer.times else None,
                'first_token_clock': started + streamer.times[0] if streamer.times else None,
                'tokens': len(ids), 'token_callbacks': len(streamer.times),
                'mps_allocated_mib': torch.mps.current_allocated_memory()/1024**2,
                'mps_driver_mib': torch.mps.driver_allocated_memory()/1024**2}
