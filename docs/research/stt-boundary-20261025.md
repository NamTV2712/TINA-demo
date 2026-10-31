# Audio boundary investigation — 2026-10-25

**Candidate không đạt quality gate; chưa triển khai.** HTTP Window ASR và bản Desktop local
đang chạy giữ nguyên. Đã thực hiện audit, một bản sửa clock nhỏ, regression test model-free,
full mixed suite và replay cả bốn development clips cùng hai clip mới. Không tự bật padding,
đổi model, thêm whitelist từ reference hoặc nới gate để đưa candidate lên mặc định.

## Lỗi xác nhận được

`ChunkedTranscriber.feedAudio(pcm, tsMs)` định nghĩa `tsMs` là thời điểm sample đầu; ring và
`latestAudioMs = tsMs + pcm.length / 16` dùng đúng quy ước đó. `PyannoteTurnSource.onAudio`
truyền nguyên timestamp vào `PyannoteSegmenter.appendFrame`.

`appendFrame` hiện gọi `runInference(tsMs)`, trong khi phép map model frames bên trong lấy
`windowStartMs = latestTsMs - realAudioDurationMs`. Do đó dùng frame start như frame end làm
boundary sớm đúng một frame. Với replay 100 ms là 100 ms; không phải hằng số hiệu chỉnh cho mic.
Đây là lỗi mapping, độc lập với độ chính xác phân loại của Pyannote.

Candidate duy nhất là gọi inference với exclusive end `tsMs + frame.length / sampleRate * 1000`.
Không thay PCM, class smoothing, prompt, padding, speaker hints, xác nhận hoặc recovery policy.
Caller trực tiếp của appendFrame chỉ có PyannoteTurnSource; Teams CSRC và Gmeet không dùng nó.

Regression dùng fixed model logits và injected processor, không download model, kiểm cả partial,
full và wrapped 10-second rings, frame 50/100/250 ms, boundary/overlap/reset và epoch timestamp.
Trước sửa, onset 500 ms bị đặt ở 400 ms với frame 100 ms; sau sửa qua cả 9 combinations.
Full mixed suite và TypeScript build của candidate đều qua. Test này chứng minh arithmetic,
không chứng minh phonetic boundaries hoặc hardware clock drift.

## Truy các ca không overlap

Ở clip 0840–0900, annotation có `there's` từ 42,54–42,73 s. Request cũ kết thúc 42,619 s,
request kế bắt đầu đúng 42,619 s và chỉ dài 475 ms: cả hai đều cắt giữa từ. Raw trả `says that.`
và `You know.`; không có `there's`. Các ca khác gồm `suppose` và từ ngang reconnect 30 s.
Không dùng annotation để dời cut trong runtime; một số deletion khác có cả word trong request
và đủ context nhưng ASR vẫn nhận sai, nên không quy tất cả cho điểm cắt.

Phân nhóm theo annotation: deletion không overlap trên bốn development clips **47 → 44**.
Tuy nhiên deletion overlap **122 → 128**. Lợi ích ở nhóm một người nói không đủ để phát hành
khi tổng deletion/insertion tăng.

## Freeze và replay

Development giữ nguyên EN2002c 0840–0900, 0900–0960, 1500–1560, 2340–2400; baseline là bản
recovery đã triển khai trong [deletion audit](stt-deletion-20261025.md).

Hai clip mới chọn **trước inference và trước sửa code**, theo annotated overlap thấp/cao nhất
trong các 60-second bins còn lại, ít nhất 100 raw reference words, loại bốn clip cũ; không chọn
theo chất lượng ASR:

- **0120–0180**: 175 raw reference words, khoảng 3,76 s annotated overlap.
- **1620–1680**: 307 raw reference words, khoảng 24,59 s annotated overlap.

Hai clip được replay baseline trước khi build candidate. Candidate đóng băng cho cả sáu clip;
không chỉnh threshold sau khi xem heldout. Sau normalize, bộ mới có 496 reference tokens.
Đây là heldout trong iteration này, vẫn cùng cuộc họp AMI; không đại diện người nói/domain mới.

| Nhóm / chỉ số live + settled recovery | Baseline | Candidate |
|---|---:|---:|
| Development: substitutions | 125 | 114 |
| Development: deletions | 169 | 172 |
| Development: insertions | 10 | 13 |
| Development: tổng lỗi / 863 tokens | 304 | 299 |
| Development: WER | 35,23% | 34,65% |
| Development: CER | 26,44% | 26,17% |
| Heldout: substitutions | 43 | 51 |
| Heldout: deletions | 100 | 95 |
| Heldout: insertions | 4 | 4 |
| Heldout: tổng lỗi / 496 tokens | 147 | 150 |
| Heldout: WER | 29,64% | 30,24% |
| Heldout: CER | 22,76% | 20,84% |

Development từng clip S/D/I: **20/22/4**, **26/56/2**, **29/25/6**, **39/69/1**.
Clip 2340–2400 làm D xấu đi **58 → 69**; cần xử lý overlap/segmentation thay vì khẳng định
clock fix đã chữa deletion. Heldout non-overlap D **20 → 17**, nhưng substitutions tăng.

Gate yêu cầu mỗi nhóm D giảm, I không tăng, tổng lỗi không tăng: **cả hai nhóm đều fail**.
WER development giảm không thay được gate này. Direct 15-second controls có aggregate counts
không đổi: development 275 lỗi; heldout 144 lỗi. Không gọi đây là official AMI/cpWER hoặc
acceptance 49 phút. Mỗi arm chỉ chạy một lần; timing của streaming pipeline có thể ảnh hưởng
window formation, nên các delta nhỏ không phải effect size đã xác lập độc lập.

## Integrity và kết thúc an toàn

Candidate sáu clip: **3600/3600 ACK**, full archive Float32 hash khớp baseline từng clip,
**79** finalized IDs trước reconnect còn nguyên, không đổi bounds cho cùng ID, không duplicate
IDs, không fault; **153** recovery windows completed. Requests đều HTTP 200 và uniquely matched
source PCM; short requests vẫn không inherited prompt. Edit/stale CAS/Restore sau Stop qua.
Stop-to-settled lần này 1,84–6,67 s, không dùng làm latency percentile hoặc acceptance.

Runtime hashes được kiểm trước khôi phục. Candidate patch, regression source, before/after logs,
frozen manifests, proxy raw requests, comparison và integrity reports giữ ở
`~/tina-test-rig/stt-boundary-20261025/` (`candidate.patch`, `segmenter-clock.test.ts`).

Sau khi gate fail, chỉ hoàn nguyên đúng clock edit/test/package hook của iteration này và rebuild
mixed dist; hash JS khớp baseline đã dựng lại từ phép sửa ngược chính xác. Các thay đổi có sẵn
khác, kể cả TINA_SEG_DEBUG rename, được giữ nguyên. Patch candidate vẫn có thể review và áp dụng
trong scratch checkout; không để nó tự kích hoạt ở lần restart Desktop tiếp theo.

Production Desktop PID **75536** không restart, health tốt; ASR PID **87088** không restart.
Không sửa dữ liệu production, không thay raw/history/audio/checkpoints, không rebuild cloud images.
Không chạy thêm VI/EN acceptance vì candidate đã fail và không được triển khai; full mixed tests
có các controls model-free hiện hữu. Hardware mic và acceptance dài vẫn Pending.

## Phần còn phải làm

Chưa đạt mục tiêu giảm deletion mà giữ insertion/tổng lỗi. Clock candidate cần được kết hợp với
một phương án xử lý segmentation/overlap có evidence trước rollout. Chưa có bằng chứng rằng
tăng padding hoặc chỉnh một threshold sẽ giải quyết được; không tuning thêm trên hai clip
heldout vừa xem. Cần giữ chúng làm regression, dùng một tập mới để xác nhận phương án tiếp theo.
