"""Run inside the meeting row transaction, after worker I/O has finished."""
import copy

from .transcript_document import CorrectionConflict

ACTIVE = ('running', 'paused', 'cancelling')


def check_job(previous, job, expected_job_id=None):
    if previous and previous['id'] != job['id']:
        if previous['status'] in ACTIVE or job['status'] != 'running' or expected_job_id != previous['id']:
            raise CorrectionConflict('Background job changed; reload before saving')
    elif previous and previous['status'] not in ACTIVE and job['status'] in ACTIVE:
        raise CorrectionConflict('A completed job cannot resume')


def alignment_commit(data, job):
    saved = copy.deepcopy(job)
    if saved.get('status') == 'completed':
        for item in saved.get('items', []):
            history = (data.get('transcript_edits') or {}).get(item['segment_id'], {}).get('history') or []
            if item.get('state') == 'aligned' and item.get('expected_revision') != len(history):
                item['state'] = 'stale'
                item['reason'] = 'Transcript revision changed during alignment'
                item.pop('words', None)
    return saved
