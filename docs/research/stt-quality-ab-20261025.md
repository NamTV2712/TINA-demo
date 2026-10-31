# STT quality A/B — 2026-10-25

Update cùng ngày: [bản sửa checkpoint](stt-checkpoint-20261025.md) đã qua regression và replay
bốn clip trên build cuối. Báo cáo này giữ nguyên số liệu chẩn đoán trước sửa; context echo và
quality gate vẫn mở.

**Kết luận:** live mixed pipeline làm tăng lỗi trên tập chẩn đoán đã cố định. Có bằng chứng
riêng cho context echo ở request quá ngắn và speech chưa được gửi tới ASR dù range đã được
checkpoint covered. Chưa thay policy, model hoặc dữ liệu production trong lượt đo này.

## Tập thử và cách đo

Tái sử dụng AMI EN2002c và reference v1.6.2 từ
[corpus chính thức](https://groups.inf.ed.ac.uk/ami/download/) (CC BY 4.0).
SHA-256 audio `a057708b3adb553f709fcde97d2af8e0455076bc3f88c250975227433d6e0270`;
reference JSON `ec316d48086431c2122980a345f5200bea1556718649d076e6cdc46a08478c4c`.

Chọn trước inference: chia thành bin 60 giây không chồng nhau, giữ bin có ít nhất 100 reference
words, lấy hai bin có overlap thấp nhất và hai bin cao nhất; tie-break theo source start.
Overlap tính theo số speaker hoạt động khác nhau, không đếm hai từ cùng speaker là overlap.
Đây là bốn trường hợp cực trị chẩn đoán, **không phải mẫu đại diện của cả corpus**.

- Direct: cửa sổ liên tiếp 15 giây, không continuity prompt.
- Live: capture.v1 → scratch Desktop → Pyannote/ChunkedTranscriber → cùng Qwen/FSMN HTTP,
  frame 100 ms realtime, reconnect giữa mỗi clip, Stop, SQLite và recovery hiện có.
- Cả hai dùng TranscriptionClient hiện hữu, PCM conversion, model `custom`, language `en`,
  max speech 15 giây và FSMN silence mặc định giống nhau. ASR worker/PID không đổi.
- Proxy loopback chuyển nguyên body request và lưu hash PCM, sample range khớp với nguồn,
  prompt và raw response ngoài Git. Tất cả 184 request live đều khớp một range nguồn duy nhất;
  không có HTTP failure. Không có cơ sở quy kết đường capture đã làm hỏng PCM trong tập này.
- Reference lấy từ annotation có midpoint nằm trong clip. Có 1/1/2/5 từ cắt qua biên của bốn
  clip; quy tắc cố định giống nhau cho cả hai arm. Không dùng annotation làm input cho ASR.

## Kết quả

| Source interval | Overlap | Direct WER | Live WER |
|---|---:|---:|---:|
| 840–900 s | 2,68 s | 19,25% | 49,30% |
| 900–960 s | 26,71 s | 32,74% | 41,26% |
| 1500–1560 s | 3,39 s | 30,48% | 34,76% |
| 2340–2400 s | 30,11 s | 43,33% | 65,83% |
| **Tổng có trọng số, 863 reference tokens** | | **31,87%** | **48,67%** |

CER tổng: **23,75% direct / 37,71% live**. Tính tổng lỗi và số reference của từng clip riêng;
không cho phép alignment chạy xuyên biên các clip không liên tục. Các số tổng sơ bộ khi nối
text (31,75%/48,55%) đã được thay bằng cách chấm độc lập này; audio và selection không đổi.

| Loại lỗi | Direct | Live | Chênh lệch live − direct |
|---|---:|---:|---:|
| Substitution | 102 | 194 | +92 |
| Deletion | 167 | 164 | −3 |
| Insertion | 6 | 62 | +56 |
| Tổng word errors | 275 | 420 | +145 |

Phần tăng trong phép đo tổng chủ yếu nằm ở substitution/insertion. Direct vẫn sai đáng kể,
đặc biệt ở overlap; không thể giải quyết toàn bộ bằng một thay đổi confirmation. Các arm khác
window/context/reconnect, nên không coi chênh lệch WER là ước lượng nhân quả cho một component.

## Hai vấn đề đã khoanh vùng

### 1. Context có thể lấn át audio rất ngắn

`quality_prompt_probe.mjs` cố định selection theo metadata request: hai request đầu tiên dưới
một giây có prompt và một control 2–5 giây mỗi clip. Không chọn theo nội dung response. Tổng
12 cases (8 short, 4 controls), cùng PCM hash/language/model/VAD, chỉ thay có/không prompt;
đảo thứ tự gọi giữa các case. Rerun có prompt khớp text gốc ở cả 12/12 cases.

Ở case khoảng 340 ms của clip 1500–1560 s, có prompt trả lại **20 tokens** của câu trước; bỏ prompt
chỉ trả **“What.”**. Reference midpoint của range là **“work with”**. Như vậy, bỏ prompt tái hiện
việc giảm context echo, **chưa chứng minh nhận dạng đúng** cho fragment này. Các case ngắn khác
vẫn có text thiếu/sai hoặc rỗng khi bỏ prompt. Không suy ra tần suất trên production từ 8 cases.

Source liên quan: mixed `submitTurn()` luôn đưa tail của lastConfirmedText vào transcribe;
nhánh closing chấp nhận cửa sổ từ 250 ms. Kiểm prompt echo hiện chỉ bỏ segment nếu toàn bộ
segment nằm trong prompt; biến thể nối thêm từ có thể vượt guard. Tuning prompt và chính sách
gom context audio phải được thử riêng, gồm VI/EN và lời lặp thật, trước rollout.

### 2. Có speech không nằm trong request, nhưng range đã được checkpoint covered

Trong clip 840–900 s, range **19,656–30,000 s** (10,344 s trước reconnect) không xuất hiện trong
bất kỳ request live/recovery đã quan sát. SQLite lại có coverage **0–658.324 samples** bao trùm
range này. Session cuối run còn pending vì các job khác; không gọi cả session là completed.
RMS nguồn **0,00605**, cao hơn floor 0,0001 của mixed
lane; annotation có **40 reference words** ở khoảng này. PCM vẫn đủ ACK/archive. Ba clip còn
lại có 4/0/4 reference tokens nằm ngoài các range request; string matching không phải đo
phonetic accuracy và không dùng để chứng nhận tất cả từ còn lại được nhận dạng đúng.

Không được diễn giải đây là ASR nghe rồi nhận sai: vùng này chưa hề được gửi. `request-coverage.json`
lưu các gap, sample bounds, RMS và reference; `*-requests.jsonl` giữ chứng cứ từng request.
RMS thấp hơn floor ở gap không có từ của clip 1500–1560 s được ghi riêng, không tính là mất lời.

Code Desktop `finish()` gọi `journal.finishAsrCapture()` khi không có exception/archive error.
Hàm này checkpoint toàn bộ min/max audio đã capture, trong khi chưa chứng minh lane đã xét hết
audio. Vì vậy coverage/completed không đủ làm bằng chứng mọi range đã tới ASR. Cần sửa hợp đồng
checkpoint theo range đã được xử lý hoặc queue phần còn lại; không được suy diễn từ việc PCM
đã được ACK. Chưa quy toàn bộ gap cho teardown: boundary detection, in-flight segmentation và
reconnect cần có regression riêng. `dispose()` hiện đánh dấu disposed trước khi drain segmenter,
nên callback tới muộn cũng là một nhánh cần tái hiện có kiểm soát. Kết quả recovery-only trước
đó chứng minh queue đã drain, không độc lập chứng minh các range vốn được checkpoint là đã
thực sự gửi ASR. T1.4 cần mở lại phần semantic coverage này, ngoài integrity của PCM/ID đã đo.

## Việc tiếp theo đã có căn cứ

1. Bổ sung regression cho speech-tail trước Stop/reconnect, segmenter trả boundary muộn và quiet
   tail. Sau đó sửa checkpoint: không đánh dấu một range speech là đã xử lý chỉ vì nó được capture.
   Giữ source offsets, retry/CAS, không gán danh tính cho phần mixed chưa xác định.
2. Chạy candidate xử lý request quá ngắn/context echo trên các PCM đã lưu và tập VI/EN riêng;
   giữ control không prompt để phân biệt context echo với lỗi cắt mất âm tiết. Không merge lượt
   nhiều người tùy tiện hoặc bỏ chữ chỉ để hạ WER.
3. Chạy lại chính bốn clip, rồi acceptance 49 phút nếu candidate đạt. Sau đó mới kiểm mic thực,
   Việt–Anh, drift và chuỗi dữ liệu phụ thuộc revision. Phase 1 vẫn **Pending**.

## Bằng chứng và kiểm tra

Artifacts riêng tư: `~/tina-test-rig/stt-quality-ab-20261025-02/`: `plan.json`, manifests/WAV,
`report.json`, `REPORT.md`, `request-coverage.json`, `prompt-probe-plan.json`,
`prompt-probe.json`, `prompt-probe-scored.json`, per-clip events/requests/SQLite và logs.
Lần harness đầu dừng trước capture do biến proxy endpoint bị shadow; đã sửa tên biến và giữ
nguyên artifact incomplete ở `stt-quality-ab-20261025/`. Lần 02 dùng cùng bốn source/hash.

Năm Python tests kiểm selection/overlap, error counts, request-vs-final coverage và aggregate
không align xuyên clip; một Node test đối chiếu PCM conversion với TranscriptionClient thật và
guard ambiguous/missing input. Các live runs cũng kiểm ACK, byte-exact archive, ID bounds,
Edit/stale CAS/Restore. Không restart Desktop/ASR production, không thay default hay dữ liệu họp.
Whole-repo dataflow blocker Discord và acceptance mic/VI/EN vẫn ngoài phép đo này.
