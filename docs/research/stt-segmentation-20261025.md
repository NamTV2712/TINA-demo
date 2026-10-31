# Segmentation / overlap investigation — 2026-10-25

**Chưa đạt mục tiêu chất lượng; không triển khai candidate.** Đã thử boundary agreement và
phương án kết hợp với clock correction, dùng bốn development clips, hai regression clips và
hai validation clips mới. Source/dist mặc định đã khớp lại baseline; Desktop không restart.

## Evidence trước sửa

Ghi lại argmax classes từ **118** inference windows của Pyannote đã cache trên clip
EN2002c 2340–2400; replay offline tuần tự cùng 100 ms PCM frames, không gọi ASR và không tải
model mới. Có **60** boundary events. Dựng lại smoothing/dedup hiện hữu cho kết quả khớp cả 60
events; **35/60** không có cùng kind trong phạm vi 100 ms ở ít nhất một trong ba inference
windows tiếp theo. **13/60** được emit khi có tối đa 200 ms right context.

Đây là evidence về model predictions còn thay đổi, không phải 35 lỗi diarization đã xác nhận.
Boundary có thể dời hoặc đổi kind khi thêm context; chưa có independent speaker-boundary ground
truth. Không dùng reference để chọn điểm cắt trong runtime.

## Hai candidate có giới hạn rõ ràng

**A — agreement only:** một boundary đóng/chia lượt phải xuất hiện với cùng kind, lệch không quá
100 ms ở hai predictions liên tiếp. Dùng lại tolerance dedup 100 ms hiện hữu, không tuning threshold
từ transcript. Mỗi prior edge chỉ match một current edge; pending list giới hạn trong cửa sổ
model 10 s và được xóa khi reset. Cùng captured classes cho **60 → 35** cuts; không gọi đó là DER
hoặc cải thiện WER. Candidate A giữ nguyên clock cũ để cô lập tác động của agreement.

**B — combined:** agreement cùng sửa frame-start → exclusive-frame-end đã được xác nhận trong
[clock investigation](stt-boundary-20261025.md). Proposal được ghi lại trước khi xem candidate
output trên hai validation clips mới; không thử các ngưỡng khác sau khi xem kết quả.

Test bổ sung phát hiện giữ cả initial onset sẽ làm mất một utterance 1,5 s khi Stop sau một
model pass ở đường không có recovery. Candidate B cho **initial silence→speaker onset** mở
buffer ngay, vì nó chưa cắt một lượt nào; các boundary sau vẫn cần agreement. Test qua actual
ChunkedTranscriber + injected model chứng minh câu Việt ngắn được flush nguyên audio/text mà
không dựa vào Desktop recovery. Đây là sửa regression của candidate trước khi chạy B, không
là tuning theo validation transcript.

Không đổi ASR model, inherited-prompt policy, context padding, RMS/confidence/language guards,
source PCM, revision rules hoặc identity mapping. Không cố gán mixed overlap cho một người.
Agreement có thể thêm một infer cadence khoảng 500 ms và có thể giữ lại genuine boundary;
ít cuts hơn không mặc nhiên là đúng hơn.

## Freeze và cách chấm

- Development: 0840–0900, 0900–0960, 1500–1560, 2340–2400; baseline là bản đã triển khai sau
  [short-recovery fix](stt-deletion-20261025.md), 863 normalized reference tokens.
- Prior regression: 0120–0180, 1620–1680; baseline từ clock investigation, 496 tokens. Hai clip
  đã được xem ở iteration trước nên không gọi chúng là heldout mới.
- New validation: **0480–0540** và **1080–1140**, 489 tokens. Chọn annotated overlap cao/thấp
  nhất trong các 60-second bins còn lại với ít nhất 100 raw words, loại sáu clip trước; freeze
  trước inference. Annotated overlap khoảng **24,09 s / 4,74 s**. Baseline chạy trước build A.

Mỗi candidate replay 8 phút source audio qua scratch Desktop, HTTP Qwen/FSMN, indexed WS PCM,
midpoint reconnect, SQLite, Stop và đợi recovery settle. Source/reference hashes, normalization
và selection giữ nguyên. Baselines khác thời điểm; mỗi arm chạy một lần, nên timing/window
formation vẫn là giới hạn của causal interpretation. Tất cả thuộc cùng một cuộc họp AMI tiếng
Anh, không đại diện domain/người nói mới, không official AMI/cpWER, không acceptance 49 phút.

## Kết quả: không qua gate ở bất kỳ nhóm nào

Trong bảng, D/I/E là deletion / insertion / tổng word errors.

| Nhóm | Baseline D/I/E | A: agreement only | B: combined |
|---|---:|---:|---:|
| Development | 169 / 10 / 304 | 175 / 10 / 300 | 176 / 6 / 304 |
| Prior regression | 100 / 4 / 147 | 102 / 6 / 145 | 98 / 5 / 142 |
| New validation | 105 / 3 / 145 | 104 / 4 / 146 | 84 / 14 / 162 |
| Tổng 1848 tokens | 374 / 17 / 596 | 381 / 20 / 591 | 358 / 25 / 608 |

Gate giữ nguyên: mỗi nhóm cần D giảm, I không tăng, E không tăng. **A và B đều fail.**
Development B có WER **35,23% → 35,23%**; validation B **29,65% → 33,13%**. Tổng deletion B
giảm 16 nhưng substitutions tăng **205 → 225**, insertion tăng 8; không diễn giải như nhận đúng
thêm 16 từ. Các direct 15-second controls có aggregate counts không đổi: **548 lỗi /1848 tokens**.

Candidate B trên development: clip 2340–2400 có D **58 → 72**, gồm **63** overlap deletions ở
candidate. Điều này không chứng minh overlap là nguyên nhân duy nhất, nhưng bác bỏ giả thuyết
chỉ cần ổn định cut và sửa clock là chữa được chất lượng trên mixed speech hiện tại.

## Verification và dữ liệu

Regression model-free thất bại trước agreement và qua sau sửa; kiểm unstable/revised cuts,
speaker changes, overlap onset/offset, silence, one-to-one matching, dedup/reset và short Stop.
Clock test kiểm 9 combinations partial/full/wrapped ring với 50/100/250 ms frames. Full mixed
suite qua cho candidate cuối; TypeScript build và isolation (18 bricks) qua. Test không gọi
model thật và không thay được số liệu quality ở trên.

Candidate B: **4800/4800 ACK**, archive Float32 hash khớp baseline cả tám clip, **88** finalized
IDs trước reconnect được giữ, không duplicate IDs/đổi bounds cho cùng ID hoặc faults. **182**
recovery windows completed. HTTP requests đều 200, PCM source matching unique; short requests
không inherited prompt. Post-stop edit/stale CAS/Restore qua; live edit khi capture active vẫn
bị từ chối như trước. Runtime fingerprints được kiểm trước hoàn nguyên.

Stop-to-settled của B khoảng **1,04–4,98 s**. First-caption và full timing từng clip ở comparison
artifacts; chưa có latency acceptance/pixel measurement. Không dùng tám clips làm production
P50/P95. Chưa chạy lại VI/EN thực hoặc 49 phút vì candidates đã fail và không được rollout.

Artifacts riêng tư: `~/tina-test-rig/stt-segmentation-20261025/` gồm `classes.json`,
`boundary-stability.json`, `agreement-trace.json`, frozen selection/proposal, baseline,
candidate-eight, combined-eight, comparisons, audit, test logs và `combined.patch` cùng test sources.
Patch applies cleanly khi review nhưng **không được apply vào mặc định**.

Chỉ hoàn nguyên diff do iteration này tạo bằng reverse patch sau khi kiểm source hashes; build
mixed dist rồi kiểm source/package/JS hashes khớp snapshot trước task. Các thay đổi có sẵn được
giữ nguyên. Production Desktop **PID 75536**, ASR **PID 87088** không restart; health tốt, idle
sau test. Không ghi vào journal production, không đổi raw/history/audio/checkpoint, không rebuild
cloud images. Không cần architecture/contract seal mới vì không còn runtime change được áp dụng.

## Kết luận còn mở

Mục tiêu giảm deletion mà không tăng insertion/tổng lỗi **chưa đạt**. Không tiếp tục chỉnh
threshold trên tập validation vừa xem. Trước một vòng cut heuristic mới, cần đối chứng mixed
audio với nguồn tách người nói khi có thể, rồi kiểm khả năng nhận hai giọng chồng lấn của ASR.
Nếu mixed single-stream là giới hạn chính, việc tách ASR window khỏi attribution hoặc dùng
audio per-source cần được thiết kế/kiểm riêng; kết quả này chưa xác nhận giải pháp đó.
