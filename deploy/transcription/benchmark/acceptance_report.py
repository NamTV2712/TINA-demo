"""Score one frozen real-time replay; hardware/VI acceptance cannot be inferred from AMI."""
from __future__ import annotations
import json
import statistics
import sqlite3
from pathlib import Path
import sys

import jiwer
from metrics import normalize, percentile, score


def memory_trend(samples, key):
    rows=[(s['at']/60,s[key]/1024**2) for s in samples if s['at']>=600]
    if len(rows)<6:
        return {'status':'insufficient-post-warmup-samples'}
    base=statistics.median(v for _,v in rows[:6]);last=statistics.median(v for _,v in rows[-6:])
    mean_t=statistics.mean(t for t,_ in rows);mean_v=statistics.mean(v for _,v in rows)
    denom=sum((t-mean_t)**2 for t,_ in rows)
    return {'status':'measured','post_warmup_samples':len(rows),'initial_minute_median_mib':base,
            'last_minute_median_mib':last,'growth_mib':last-base,'peak_mib':max(s[key]/1024**2 for s in samples),
            'linear_slope_mib_per_minute':sum((t-mean_t)*(v-mean_v) for t,v in rows)/denom if denom else None}


def latency(values):
    return {'samples':len(values),'p50_s':percentile(values,.5),'p95_s':percentile(values,.95),
            'min_s':min(values) if values else None,'max_s':max(values) if values else None,
            'negative_samples':sum(v<0 for v in values)}


def after_close_document(root, meeting_key):
    """Read the committed authority after the recorder/worker process has closed; no jobs start."""
    with sqlite3.connect(f'file:{root}/journal/transcripts.sqlite?mode=ro',uri=True) as db:
        row=db.execute('SELECT document FROM meetings WHERE key=?',(meeting_key,)).fetchone()
        assert row,'Missing replay meeting'
        meeting=json.loads(row[0])
        records={sid:(raw,json.loads(history)) for sid,raw,history in db.execute('SELECT segment,raw,history FROM transcript_records WHERE meeting=?',(meeting_key,))}
        segments=[]
        for s in meeting['segments']:
            raw,history=records[s['segment_id']]
            segments.append({'segment_id':s['segment_id'],'start_ms':s['start']*1000,'end_ms':s['end']*1000,
                             'speaker':s['speaker'],'raw_text':raw,'text':history[-1]['text'] if history else s['text'],'revision':len(history)})
        pending=db.execute("SELECT COUNT(*) FROM asr_windows WHERE state IN ('queued','running','retry')").fetchone()[0]
    return {'segments':segments,'pending_recovery_windows':pending}


def main(directory):
    root=Path(directory)
    read=lambda name:json.loads((root/name).read_text())
    summary,runtime,manifest,capture_doc=map(read,['summary.json','runtime.json','manifest.json','document.json'])
    assert summary['status']=='complete','Never score an interrupted replay as complete'
    doc=after_close_document(root,'zoom/public-'+manifest['meeting_id'])
    (root/'document-after-close.json').write_text(json.dumps(doc,ensure_ascii=False,indent=2)+'\n')
    reference=json.loads(Path(manifest['reference_path']).read_text())['words']
    segments=sorted(doc['segments'],key=lambda s:(s['start_ms'],s['segment_id']))
    events=[json.loads(line) for line in (root/'events.jsonl').read_text().splitlines()]
    samples=[json.loads(line) for line in (root/'progress.jsonl').read_text().splitlines()]
    first={}
    for e in events:
        for s in e.get('confirmed',[]):
            key=(s['segment_id'],normalize(s.get('text','')))
            first.setdefault(key,e['at'])
    operational=[]
    for s in segments:
        at=first.get((s['segment_id'],normalize(s['text'])))
        if at is not None:operational.append(at-(s['end_ms']-runtime['source_origin_ms'])/1000)
    result=score(' '.join(w['text'] for w in reference),' '.join(s['text'] for s in segments))
    result['wer']=result['word_errors']/result['ref_words'];result['cer']=result['char_errors']/result['ref_chars']
    # Alignment of text strings is diagnostic only; timestamps still come from human reference.
    ref_tokens=[(token,w) for w in reference for token in normalize(w['text']).split()]
    hyp_tokens=[(token,s) for s in segments for token in normalize(s['text']).split()]
    alignment=jiwer.process_words(' '.join(t for t,_ in ref_tokens),' '.join(t for t,_ in hyp_tokens))
    word_lags=[]; matched={}
    for block in alignment.alignments[0]:
        if block.type!='equal':continue
        for ri,hi in zip(range(block.ref_start_idx,block.ref_end_idx),range(block.hyp_start_idx,block.hyp_end_idx)):
            matched[ri]=hi
            s=hyp_tokens[hi][1];at=first.get((s['segment_id'],normalize(s['text'])))
            if at is not None:word_lags.append(at-ref_tokens[ri][1]['end'])
    utterance_file=Path(manifest['reference_path']).parent/'utterances.json'
    reference_word_tokens=[];cursor=0
    for w in reference:
        size=len(normalize(w['text']).split());reference_word_tokens.append(list(range(cursor,cursor+size)));cursor+=size
    utterance_lags=[];utterances=json.loads(utterance_file.read_text())['utterances'] if utterance_file.exists() else []
    for u in utterances:
        indices=[i for wi in u['reference_word_indices'] for i in reference_word_tokens[wi]]
        if not indices or any(i not in matched for i in indices):continue
        observed=[]
        for i in indices:
            s=hyp_tokens[matched[i]][1];at=first.get((s['segment_id'],normalize(s['text'])))
            left=(s['start_ms']-runtime['source_origin_ms'])/1000;right=(s['end_ms']-runtime['source_origin_ms'])/1000
            if at is None or ref_tokens[i][1]['end']<left-1 or ref_tokens[i][1]['start']>right+1:break
            observed.append(at)
        if len(observed)==len(indices):utterance_lags.append(max(observed)-u['end'])
    first_speech=min(w['start'] for w in reference)
    controls=[json.loads(line) for line in (root/'controls.jsonl').read_text().splitlines()]
    reconnect=next(c['at'] for c in controls if c['kind']=='disconnect-reconnect')
    pre_reconnect={s['segment_id'] for e in events if e['at'] is not None and e['at']<reconnect for s in e.get('confirmed',[])}
    missing_pre_reconnect=sorted(pre_reconnect-{s['segment_id'] for s in segments})
    recovery=read('recovery-status.json')
    unfinished=[w for w in recovery['windows'] if w['state'] not in ('completed','superseded')]
    worker_file=root/'worker-samples.jsonl'
    worker_rows=[json.loads(line) for line in worker_file.read_text().splitlines()] if worker_file.exists() else []
    warm_worker={r['request_id']:r for r in worker_rows if r['at_ms']>=runtime['source_origin_ms']+600000}
    worker_stages={key:{'samples':sum(isinstance(r.get(key),(int,float)) for r in warm_worker.values()),
                       'p50_ms':percentile([r.get(key) for r in warm_worker.values()],.5),
                       'p95_ms':percentile([r.get(key) for r in warm_worker.values()],.95)}
                   for key in ('audio_ms','queue_ms','inference_ms','total_ms')}
    report={'kind':'public-recording-replay-report','source':manifest['meeting_id'],'source_seconds':summary['source_seconds'],
            'recognized_segments':len(segments),'segments_at_capture_snapshot':len(capture_doc['segments']),'quality':result,
            'latency':{'first_text_from_recording_start_s':summary['first_text_seconds'],
                       'first_text_after_first_reference_onset_s':summary['first_text_seconds']-first_speech,
                       'confirmed_publication_from_emitted_source_end':latency(operational),
                       'matched_word_end_to_confirmed_publication_diagnostic':latency(word_lags),
                       'matched_reference_word_coverage':alignment.hits/len(ref_tokens) if ref_tokens else None,
                       'fully_matched_reference_utterance_end_to_confirmed_publication':latency(utterance_lags),
                       'reference_utterances':len(utterances),'measured_reference_utterance_coverage':len(utterance_lags)/len(utterances) if utterances else None,
                       'stop_tail_seconds':summary['stop_tail_seconds']},
            'memory':{'desktop_replay_process':memory_trend(samples,'node_rss_bytes'),'asr_worker_rss':memory_trend(samples,'asr_rss_bytes')},
            'worker_after_minute_10':{'unique_samples':len(warm_worker),'failed_requests':sum(r['http_status']>=400 for r in warm_worker.values()),
                                      'stages':worker_stages,'scope':'Shared backend samples after source minute 10; excludes startup. No silent exclusion of failed requests.'},
            'integrity':{**{k:summary[k] for k in ['sent_frames','acked_frames','segment_id_bound_changes','archive_float32_sha256','reconnected','faults','revision_checks','live_edit']},
                         'confirmed_ids_before_reconnect':len(pre_reconnect),'missing_confirmed_ids_after_reconnect':missing_pre_reconnect,
                         'unfinished_recovery_windows_at_capture_snapshot':len(unfinished),
                         'unfinished_recovery_windows_after_process_close':doc['pending_recovery_windows']},
            'acceptance':{'software_checks':'failed' if summary['segment_id_bound_changes'] or missing_pre_reconnect or doc['pending_recovery_windows'] else ('passed-with-recovered-worker-faults' if summary['faults'] else 'passed-capture-scope'),'product_thresholds':'proposed, not signed off',
                          'clean_english_quality_gate':'not evaluated on this mixed-overlap input',
                          'ami_mixed_quality_gate_provisional':'pass' if result['wer']<=.25 and result['cer']<=.15 else 'fail',
                          'real_mic_and_meeting_transport':'not measured','physical_clock_drift':'not measured',
                          'vietnamese_and_code_switching':'not measured','ui_pixel_presentation':'not measured',
                          'phase_1':'pending'},
            'limits':['Chronologically ordered mixed-stream AMI word reference; overlapping speech affects this descriptive WER. Not an official AMI/cpWER score.',
                      'Publication lag uses source timestamps emitted by the pipeline, not independent utterance-end ground truth.',
                      'Matched-word latency excludes errors/unmatched words, includes within-sentence wait and is not the final-caption-after-utterance metric.',
                      'Reference-utterance latency includes only fully text-matched utterances consistent with emitted source bounds; its coverage is selective and cannot certify latency for failed/missing recognition.',
                      'A single first-caption observation has no population p50/p95. No partial/negative timing samples are silently clamped.',
                      'RSS is per process on a shared host, not total Metal/unified memory. Do not add it to GPU driver allocations.',
                      'Pending recovery or worker errors remain failures even if all source PCM is retained.']}
    (root/'scored.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    rows=['# AMI real-time replay — descriptive result','',f"Source: {report['source']}, {report['source_seconds']:.3f}s, {len(segments)} segments.",
          '',f"WER: {result['wer']*100:.2f}%; CER: {result['cer']*100:.2f}%. Raw scoring fields retained in scored.json.",
          '',f"Phase 1 acceptance: **Pending**. Software verdict after close: **{report['acceptance']['software_checks']}**.",
          '', '```json',json.dumps({k:v for k,v in report.items() if k!='quality'},ensure_ascii=False,indent=2),'```']
    (root/'REPORT.md').write_text('\n'.join(rows)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('quality','limits')},ensure_ascii=False))


if __name__=='__main__':main(sys.argv[1])
