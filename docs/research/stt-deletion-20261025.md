# Deletion audit và batch recovery — 2026-10-25

**Đã áp dụng vào Desktop local.** Batch recovery dùng policy media/repetition đã có của mixed
lane, thay vì loại lời nói chỉ vì một từ ngắn. HTTP Window ASR, Qwen/FSMN, ring, source clocks,
CAS và dữ liệu lịch sử giữ nguyên. Trên cùng bốn clip AMI, deletion **178 → 169**, insertion
**10 → 10**, substitution **118 → 125**. Tổng lỗi chỉ giảm **306 → 304**; không diễn giải
deletion giảm 9 là khôi phục đúng thêm 9 từ. Phase 1 vẫn **Pending**.

## Truy vết trước khi sửa

`deletion_audit.py` dùng cùng normalization/jiwer như quality report, nối từng deletion với
annotation, exact source/sample ranges của HTTP request, raw response và final transcript.
Tất cả 178 midpoint có request; không tìm thấy source loss ở các midpoint này.

| Clip AMI | Deletion | Không có exact raw match | Raw match thiếu ở final | Overlap | Chưa có request chứa toàn word interval |
|---|---:|---:|---:|---:|---:|
| 0840–0900 | 28 | 28 | 0 | 9 | 5 |
| 0900–0960 | 58 | 55 | 3 | 52 | 23 |
| 1500–1560 | 28 | 27 | 1 | 13 | 5 |
| 2340–2400 | 64 | 62 | 2 | 56 | 26 |
| Tổng | 178 | 172 | 6 | 130 | 59 |

11 deletion là filler. Các nhóm giao nhau. Word intervals là annotation AMI, không phải đo biên
phone độc lập. Raw match thiếu final có thể là hypothesis cũ được revise hoặc alignment mơ hồ
khi overlap/lặp từ; không quy cả 6 trường hợp thành lỗi pipeline.

Trường hợp xác định được: **“Insane.”** ở clip 0900–0960 xuất hiện trong hai raw responses,
nhưng batch recovery loại nó bởi `isHallucination` coi single word dưới 10 ký tự là junk.
Final sau sửa có lại câu này. Ngược lại, “Why.” mới ở clip 0840–0900 chuyển một deletion thành
substitution, không cải thiện số lỗi của clip đó.

## Phạm vi code

- `SpeakerStreamManager` nhận `config.hallucinationFilter`; cả sáu nhánh confirm/trim/flush dùng
  cùng policy. Default `isHallucination` của live Gmeet giữ nguyên.
- Desktop `AsrRecovery` truyền `hallucinationRule` có sẵn từ mixed module qua hook của host;
  không tạo dependency giữa hai pipeline modules. Áp dụng cho cả mixed và channel recovery.
- Existing media/pattern/repetition, RMS, ASR confidence và language-review guards vẫn áp dụng.
  Existing `TINA_MIXED_HALLUCINATION_GATE=off` vẫn là off switch của policy được tái sử dụng.
- Không đổi request audio, segment bounds, wire schema, authority, revision hoặc speaker identity.
  Không tự chạy lại jobs đã completed hay sửa checkpoint/raw/history cũ.

## Thử audio context ở biên: không bật mặc định

Probe cố định 12 short requests chứa clipped deleted word: ba range đầu đủ điều kiện mỗi clip,
không dùng file edges. So cùng PCM với **200 ms trái + 350 ms phải** từ source gốc, không text
prompt, luân phiên thứ tự baseline/candidate. Chỉ diagnostic; không publish đoạn transcript nào.

Target exact match **0/12 → 2/12**; nhưng **6/12** responses chứa từ thuộc padding ngoài original
range theo annotation/alignment. Ví dụ `You know.` thành `There's you know ten documents.`;
`documents` nằm ở context. Backend không có word timestamps để xác nhận ownership và trim text.
Không chấp nhận cách cắt timestamp rồi gán toàn text cho range cũ. Existing close padding giữ nguyên.

## Replay sau sửa

Cùng source/reference hashes và bốn clip đã đóng băng từ checkpoint investigation; 240 giây,
863 normalized reference words, chronological mixed overlap scoring. Cả hai arm đợi recovery
settle. Runtime hashes không đổi trong khi chạy, Qwen/FSMN MPS PID 87088 không restart.

| Live + settled recovery | Trước | Sau |
|---|---:|---:|
| WER | 35,46% | 35,23% |
| CER | 26,65% | 26,44% |
| Substitutions | 118 | 125 |
| Deletions | 178 | 169 |
| Insertions | 10 | 10 |
| Tổng word errors | 306 | 304 |

Deletion từng clip: **28→27, 58→56, 28→28, 64→58**; insertion từng clip giữ **1/3/5/1**.
Direct 15-second no-prompt control vẫn 275 lỗi, WER/CER **31,87%/23,75%**.
Sau sửa, 164/169 deletion không có exact raw match, 5 còn lại raw-match-not-final; phần lớn vấn đề
vẫn ở nhận dạng/overlap/window boundaries. Đây là diagnostic đã dùng phát triển, không held-out
estimate, không official AMI/cpWER và không bằng chứng cải thiện production tổng quát.

Kiểm integrity sau run:

- **2400/2400** exact-range ACK; archive Float32 hashes khớp baseline ở cả bốn clip.
- **55** finalized IDs trước reconnect còn nguyên; không duplicate segment IDs hay đổi bounds.
- **109** recovery windows completed, không pending/error; 292 HTTP requests đều 200, unique
  PCM source match (gồm 16 direct controls). 195 short live-path requests không inherited prompt.
- Post-stop edit, stale CAS 409 và Restore đều qua. Sửa khi capture active vẫn chưa hỗ trợ.
- Stop response và recovery settle được tách; settled tail lần này khoảng **1,50–2,50 s**.
  Không dùng bốn mẫu này làm latency percentile hay xoá outlier của các run trước.

## Controls và verification

Sáu short VI/EN TTS controls chạy lại qua actual `AsrRecovery` + SQLite + HTTP Qwen/FSMN:
output khớp request-level candidate trước đó; giữ `vâng vâng`, `không không`, `yes yes`, `no no`.
Hai lỗi tên riêng **Minh→Mình/min** vẫn còn. Ba silence/noise/residue controls không sinh chữ.
PCM giữ nguyên, timestamps trong source bounds, sessions completed và không fault. Synthetic
voices không thay natural VI/EN code-switching hoặc mic acceptance.

Regression mới trước sửa thất bại ở short speech; sau sửa qua cho Zoom/Teams/Gmeet recovery,
media phrase, repetition loop và low-confidence rejection. Full Gmeet/Desktop suites, build,
19 Python benchmark tests, JS quality harness test và syntax check probe qua. Isolation kiểm
18 bricks và architecture graph qua; architecture seal cập nhật.

Whole-repo gates chưa xanh: dataflow còn Discord chưa đăng ký; contract-version còn api.v1 và
invocation.v1 đã thay seal ngoài task; readme gate còn nhiều thư mục ngoài scope, gồm generated
Rust build targets. Không re-seal contracts hoặc tạo hàng loạt README để che các blocker này.

## Local rollout và dữ liệu

Chỉ restart Desktop khi live capture và ASR queue idle, không refinement job active; tạo SQLite
backup trước đó. PID Desktop **63091 → 75536**, health tốt. Trước/sau đều **44 meetings /
232 transcript records /119.727 PCM chunks**; hashes toàn bảng transcript raw/history,
audio_chunks, asr_coverage và refinement_jobs khớp. Không restart ASR hay rebuild cloud images.

Artifacts riêng tư: `~/tina-test-rig/stt-deletion-20261025/` gồm audit-before/after, frozen context
probe, quality-ab, integrity.json, recovery-controls.json, test/gate logs và deployment backup/hashes.
Chưa chạy lại 49 phút, hardware mic, natural VI/EN hoặc speaker-aware acceptance. Bước tiếp theo
là điều tra request boundaries/overlap còn lại với audio ownership có thể kiểm chứng, rồi chạy
acceptance dài; không mở rộng padding đại trà hoặc chuyển Streaming ASR từ kết quả này.
