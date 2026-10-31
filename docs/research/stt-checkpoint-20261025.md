# Stop/reconnect checkpoint — 2026-10-25

Update sau lượt checkpoint: [short-context policy](stt-context-echo-20261025.md) đã giảm echo trong
request ngắn và được kiểm trên cùng bốn clip; báo cáo này giữ nguyên kết quả trước policy đó.

**Đã sửa coverage cho capture mới, triển khai local và kiểm lại bốn clip AMI cố định.**
Gap speech 10,344 giây trước đây chưa được gửi ASR nay được gửi bằng đúng PCM nguồn và
recovery đã commit. Chất lượng nhận dạng và acceptance toàn Phase 1 vẫn chưa đạt.

## Thay đổi

- `TranscriptJournal.finishAsrCapture()` chỉ lập job cho range còn thiếu. Nó không còn đánh dấu
  toàn bộ min/max audio đã nhận là covered/completed. Confirmed ranges và recovery commit thành
  công tiếp tục là đường ghi coverage; lỗi/đang chạy vẫn pending/retry.
- `capture()` ghi PCM và chuyển session completed về pending trong cùng transaction nếu có frame
  mới đến muộn. Lỗi chuyển trạng thái rollback cả PCM trước ACK; retry ghi một lần.
- Mixed `dispose()` chặn audio mới, chờ segmentation đã nhận audio trả callback, rồi flush lượt
  cuối. Các caller đóng đồng thời chờ cùng một task. Confirmation/prompt/model defaults giữ nguyên.
- Replay harness lưu snapshot ngay khi Stop, rồi chờ recovery settle trước khi chấm. Tách
  `stop_response_seconds` khỏi `stop_tail_seconds`; timeout 180 giây là incomplete.

Không đổi schema/wire IDs hay tự động viết lại checkpoint cũ. Audio/raw/history cũ giữ nguyên;
không suy diễn những range lịch sử từng bị blanket-checkpoint là đã thật sự gửi ASR.

## Regression và kiểm tra

Hai regression đã fail trên code trước sửa: Stop ghi completed khi còn một range voiced chưa
xử lý; mixed disposal trả xong trước boundary đang chạy. Bản sửa qua các trường hợp:

- Range thiếu được queue, repeated Stop không checkpoint job retry; commit idempotent.
- Raw PCM, original text và user revision không bị thay đổi khi recovery append segment.
- Quiet tails qua energy gate không tạo text; khoảng PCM thiếu không được bịa thành silence.
- Frame đến muộn mở lại pending; trigger lỗi cập nhật trạng thái chứng minh PCM/state rollback
  cùng nhau trước ACK và retry không ghi trùng.
- Boundary trả muộn vẫn được flush; PCM mới sau Stop không lọt vào request cuối; concurrent close
  hoàn tất chung và chỉ publish một final. Không ép số HTTP call vì LocalAgreement vẫn giữ nguyên.
- Suite Desktop và mixed đều pass, gồm SIGKILL/restart/retry, CAS/Restore và ingest ACK/replay.
  Desktop live fixture cần TINA_TX_KEY/EVAL_CACHE vẫn skipped; thay vào đó bốn clip dưới đây dùng
  HTTP ASR thật, không phải kiểm chứng trình duyệt/mic.

## Replay bản build cuối

Tập audio/reference/selection giữ nguyên như [A/B trước sửa](stt-quality-ab-20261025.md):
bốn clip 60 giây, mixed input, Pyannote thật, 100 ms/frame realtime và reconnect giữa mỗi clip.
Direct vẫn là cửa sổ 15 giây không prompt. Không chọn lại audio theo kết quả.
Các file runtime được hash trước và sau lượt đo, không thay trong lúc chạy; worker Qwen/FSMN
MPS PID 87088 không restart. Đây là diagnostic 240 giây, không phải acceptance 49 phút.

| Clip nguồn | ACK | Final IDs trước reconnect giữ đủ | Recovery windows completed | Stop response | Stop đến settle |
|---|---:|---:|---:|---:|---:|
| 840–900 s | 600/600 | 7/7 | 19 | 0,523 s | 2,531 s |
| 900–960 s | 600/600 | 13/13 | 24 | 0,870 s | 1,881 s |
| 1500–1560 s | 600/600 | 11/11 | 21 | 0,615 s | 1,625 s |
| 2340–2400 s | 600/600 | 14/14 | 31 | 0,855 s | 2,874 s |

Tổng **2.400 frame**, **45 finalized IDs** có trước reconnect giữ đủ, không đổi biên ID hoặc
trùng ID; **95 recovery windows completed, zero pending/retry** khi kết thúc. Không HTTP failure.
Mỗi archive khớp byte/hash Float32 với nguồn và với lần đo trước; Edit/stale CAS/Restore qua.

Gap cũ **[314492, 480000)** samples, tức 19,65575–30,000 s trong clip đầu, được phủ bằng
request recovery **45** có PCM match nguồn. Trong cả bốn clip, không có reference token midpoint
nằm ngoài mọi request đã map duy nhất. Đây là bằng chứng phạm vi audio được gửi; không phải
chứng nhận ASR nhận đúng mọi từ hoặc timestamp phonetic chính xác.

## Chất lượng và giới hạn độ trễ

| Arm | Word errors / reference | WER | CER |
|---|---:|---:|---:|
| Direct HTTP | 275/863 | 31,87% | 23,75% |
| Live + settled recovery | 424/863 | 49,13% | 38,81% |

Live có 139 substitutions, 156 deletions và 129 insertions. Context echo/fragment ngắn vẫn
chưa được sửa. Không tuyên bố WER tốt lên nhờ checkpoint. Lượt trước sửa còn pending và chấm
trước khi settle; so sánh chất lượng với output đầy đủ phải giữ giới hạn này.

Lượt xác minh primary fix trước khi thêm transaction late-frame cũng được giữ nguyên ở
`quality-ab/`: WER 48,90% / CER 38,75%; một Stop response **33,396 s**, settle **37,499 s**.
Live ASR HTTP P95 của clip đó 11,284 s. Không quy toàn bộ độ trễ này cho drain, và không bỏ
outlier chỉ vì lượt build cuối nhanh hơn. Bốn mẫu không đủ xác nhận percentile sản phẩm;
không có thử tải kéo dài hoặc physical mic. Phase 1 vẫn **Pending**.

## Triển khai và gate

Desktop được build/test và graceful restart khi production live_sessions=0, ASR queue idle;
không restart model. SQLite được backup trước. Sau restart vẫn **41 meetings, 216 transcript
records, 103.125 PCM chunks**; hash toàn bộ transcript raw/history, PCM table và asr_coverage
khớp trước/sau. Checkpoint lịch sử không được migrate hoặc decode lại âm thầm.

Architecture description/seal đã cập nhật. Gate toàn repo còn blocker ngoài slice này:
Discord chưa đăng ký trong dataflow; contract-version hiện báo api.v1 và invocation.v1 khác
seal trong worktree vốn đã dirty. Không re-seal các contract đó trong task checkpoint.

Artifacts riêng tư: `~/tina-test-rig/stt-checkpoint-20261025/`. `quality-ab-final/` giữ plan,
requests/events, journal, runtime fingerprints, `report.json`, `REPORT.md` và
`checkpoint-validation.json`. `deployment/` giữ backup và kiểm hash; test logs giữ cả fail
trước sửa và pass sau sửa. Không commit/push hoặc thay dữ liệu ngoài phạm vi.

Tiếp theo: xử lý context echo cho request ngắn bằng phép thử VI/EN có control; sau khi chất lượng
đạt mới replay đủ 49 phút và kiểm mic/ứng dụng họp, drift và dữ liệu phụ thuộc revision.
