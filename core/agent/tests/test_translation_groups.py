from shared.translation_groups import phrases


def segment(sid, text, start=0, end=1000, speaker='nam'):
    return {'segment_id': sid, 'text': text, 'start_ms': start, 'end_ms': end,
            'speaker_id': speaker, 'speaker_name': speaker}


def test_joins_asr_fragments_into_one_complete_sentence_with_source_members():
    rows = [segment('a', 'Mục tiêu', 0, 800), segment('b', 'cuộc họp là tối ưu', 850, 2200),
            segment('c', 'các mô hình học máy.', 2300, 4000)]
    groups = phrases(rows, tail_ready=False)
    assert len(groups) == 1 and groups[0]['ready']
    assert groups[0]['source_text'] == 'Mục tiêu cuộc họp là tối ưu các mô hình học máy.'
    assert [member['segment_id'] for member in groups[0]['members']] == ['a', 'b', 'c']
    assert groups[0]['start_ms'] == 0 and groups[0]['end_ms'] == 4000


def test_short_asr_fragments_and_artificial_punctuation_are_buffered():
    rows = [segment('a', 'Mục tiêu.'), segment('b', 'cuộc họp', 1050, 2000)]
    group, = phrases(rows, tail_ready=False)
    assert not group['ready'] and len(group['members']) == 2
    assert phrases(rows, tail_ready=True)[0]['ready']


def test_different_speaker_ids_are_never_joined_even_with_the_same_name():
    rows = [segment('a', 'Tôi sẽ gửi.', speaker='p1'), segment('b', 'Cảm ơn.', 1100, 2000, 'p2')]
    for row in rows: row['speaker_name'] = 'Nam'
    groups = phrases(rows, tail_ready=False)
    assert len(groups) == 2 and groups[0]['ready'] and not groups[1]['ready']


def test_long_pause_closes_the_previous_phrase():
    groups = phrases([segment('a', 'Xin chào.'), segment('b', 'Hẹn gặp.', 4100, 5000)], tail_ready=False)
    assert len(groups) == 2 and groups[0]['ready'] and not groups[1]['ready']


def test_limits_flush_continuous_speech_without_dropping_or_duplicating_fragments():
    rows = [segment(str(i), 'nội dung đang nói', i * 1000, (i + 1) * 1000) for i in range(40)]
    groups = phrases(rows, tail_ready=False)
    assert len(groups) >= 3 and groups[0]['ready']
    assert [m['segment_id'] for g in groups for m in g['members']] == [r['segment_id'] for r in rows]


def test_existing_closed_groups_stay_stable_when_a_live_tail_grows():
    rows = [segment('a', 'Hôm nay chúng ta sẽ họp về tối ưu.'), segment('b', 'Tiếp theo', 1100, 2000)]
    first = phrases(rows, tail_ready=False)
    rows.append(segment('c', 'là mô hình mới', 2100, 3000))
    second = phrases(rows, tail_ready=False)
    assert first[0] == second[0]
    assert first[1]['group_id'] == second[1]['group_id']
    assert second[1]['source_text'] == 'Tiếp theo là mô hình mới'


def test_long_individual_source_segment_is_preserved_whole():
    row = segment('long', 'word ' * 100)
    group, = phrases([row], tail_ready=False)
    assert group['ready'] and group['source_text'] == row['text'].strip()
    assert group['members'][0]['source_text'] == row['text']
