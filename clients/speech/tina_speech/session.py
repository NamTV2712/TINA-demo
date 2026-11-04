"""Participant boundary: own API key only; capture continues while room grant is pending."""
from concurrent.futures import ThreadPoolExecutor
import os
from queue import Queue
import threading
import time
from uuid import uuid4

import httpx

from .capture import QuestionCapture, SileroVad
from .wakeword import SherpaKws, WakeDetector


class RoomClient:
    def __init__(self, url, key, *, http=None):
        parsed = httpx.URL(url)
        if (not key or parsed.userinfo or parsed.query or parsed.scheme not in ('http', 'https')
                or parsed.scheme == 'http' and parsed.host not in ('localhost', '127.0.0.1', '::1')):
            raise ValueError("Use your own private API key and HTTPS (HTTP only on loopback)")
        self.url = url.rstrip('/')
        self.http = http or httpx.Client(headers={'X-API-Key': key}, timeout=8,
                                        follow_redirects=False, trust_env=False)
        self.http.headers['X-API-Key'] = key

    def call(self, method, identifier, suffix='', **kwargs):
        response = self.http.request(method, self.url + '/turns/' + identifier + suffix, **kwargs)
        response.raise_for_status()
        state = response.json()
        if state.get('request_id') != identifier:
            raise ValueError("Mismatched turn response")
        return state

    def reserve(self, identifier):
        state = self.call('POST', identifier)
        if state['state'] != 'CAPTURING':
            raise ValueError("Turn grant is not fresh")
        return state

    def submit(self, identifier, audio, stopped, notify):
        self.call('PUT', identifier, '/audio', content=audio, headers={'Content-Type': 'audio/wav'})
        deadline = time.monotonic() + 330
        while time.monotonic() < deadline and not stopped.is_set():
            state = self.call('GET', identifier)
            notify(state['state'])
            if state['state'] in ('COMPLETED', 'FAILED', 'STOPPED', 'ERROR'):
                return state['state']
            stopped.wait(.2)
        if stopped.is_set():
            return 'STOPPED'
        raise TimeoutError("Turn status unavailable; dispatch remains disarmed")

    def cancel(self, identifier):
        return self.call('DELETE', identifier, timeout=15)


class SpeechSession:
    def __init__(self, directory, client, emit, *, detector=None, vad_factory=None):
        self.detector = detector or WakeDetector(SherpaKws(directory))
        self.vad_factory = vad_factory or (lambda: SileroVad(directory))
        self.client, self.emit = client, emit
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='tina-speech-http')
        self.messages = Queue(maxsize=8)
        self.stopped = threading.Event()
        self.state = 'ARMED'
        self.identifier = None
        self.capture = None
        self.audio = None
        self.future = None
        self.emit({'event': 'turn', 'state': self.state})

    def transition(self, state):
        if self.state != state:
            self.state = state
            self.emit({'event': 'turn', 'state': state, 'request_id': self.identifier})

    def notice(self, state):
        # Only terminal/meaningful transitions need UI delivery, never one per poll.
        if state == 'SPEAKING' and self.messages.empty():
            self.messages.put_nowait(state)

    def tick(self):
        while not self.messages.empty():
            state = self.messages.get_nowait()
            if self.state in ('WAITING', 'SPEAKING'): self.transition(state)
        if not self.future or not self.future.done(): return
        future, self.future = self.future, None
        try:
            result = future.result()
            if self.state == 'CAPTURING':
                self.future = future  # keep the successful grant until bounded capture finishes
                if self.audio is not None:
                    self.transition('WAITING')
                    audio, self.audio = self.audio, None
                    self.future = self.pool.submit(self.client.submit, self.identifier, audio, self.stopped, self.notice)
                return
            if isinstance(result, dict): result = result.get('state')
            if result not in ('COMPLETED', 'FAILED', 'STOPPED'):
                self.transition('ERROR')
            else:
                self.rearm()
        except Exception:
            self.transition('ERROR')

    def rearm(self):
        self.capture, self.audio = None, None
        self.detector.kws.reset()
        self.detector.ring.clear()
        self.detector.armed = True
        self.identifier = None
        self.transition('ARMED')

    def feed(self, block):
        self.tick()
        if self.state == 'ARMED':
            event = self.detector.feed(block)
            if event:
                try:
                    self.capture = QuestionCapture(event, self.vad_factory())
                except ValueError:
                    self.transition('ERROR')
                    return
                self.identifier = str(uuid4())
                self.transition('CAPTURING')
                self.future = self.pool.submit(self.client.reserve, self.identifier)
        elif self.state == 'CAPTURING' and self.audio is None:
            try:
                self.audio = self.capture.feed(block)
            except ValueError:
                # Cancel the grant after any in-flight reservation, never submit a partial question.
                self.future = self.pool.submit(self.client.cancel, self.identifier)
                self.transition('WAITING')
        self.tick()
        return None

    def close(self):
        self.stopped.set()
        self.detector.close()
        self.capture, self.audio = None, None
        self.pool.shutdown(wait=False, cancel_futures=True)
        if self.identifier:
            try: self.client.cancel(self.identifier)
            except Exception: self.transition('ERROR')
        self.client.http.close()
        self.transition('OFF')


def configured_client():
    return RoomClient(os.environ.get('TINA_SPEECH_COORDINATOR_URL', 'http://127.0.0.1:18005'),
                      os.environ.get('TINA_SPEECH_USER_KEY', ''))
