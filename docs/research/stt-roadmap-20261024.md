# TINA STT — roadmap sau T1.1–T1.5

Trạng thái ngày 2026-10-24:

| Phạm vi | Trạng thái |
|---|---|
| STT Foundation | **Verified in bounded tests — PASS trong test scope** |
| AMI EN2002c replay 49 phút 32 giây | **Đã chạy — chưa đạt chất lượng và recovery ở baseline** |
| Recovery trên bản sao sau sửa fragment ngắn | **Đã chạy hết, không còn job chờ; chưa phải replay acceptance mới** |
| Quality A/B ngày 25/10 | **Đã đo; live WER 48,67% so với direct 31,87% trên 4 clip chẩn đoán** |
| Stop/reconnect coverage fix ngày 25/10 | **Đã triển khai local; 4 clip/2.400 ACK, gap cũ được xử lý, zero pending ở cuối run** |
| Short-context echo fix ngày 25/10 | **Đã triển khai local; trên 4 clip WER 49,13% → 35,46%, CER 38,81% → 26,65%** |
| Real-meeting acceptance | **Pending** |
| Speaker-aware integration | **Next, sau acceptance và điều tra latency** |
| Hybrid Meeting RAG, pgvector | **Deferred** |

Số liệu foundation trong [báo cáo](stt-foundation-20261024.md) là bằng chứng của các bài thử
đã ghi lại; không phải chứng nhận production hay đánh giá độc lập. Giữ HTTP Window ASR,
ring 30 giây/source, SQLite/PostgreSQL theo authority, CAS và durable replay. Không viết lại
capture, VAD, ASR, archive, canonical hoặc các worker hậu kỳ đã có.

## Thứ tự thực hiện

| Task | Công việc | Gate |
|---|---|---|
| T1.6 — Real-Meeting Acceptance | Replay liên tục một cuộc họp công khai 45–60 phút có audio và transcript tham chiếu; sau đó thu thực qua mic/ứng dụng họp. Theo dõi reconnect, ACK, revision, PCM, bộ nhớ, chất lượng và timestamp. | Replay và physical capture là hai trạng thái riêng. Không ghép/lặp clip ngắn để đạt thời lượng. |
| T1.7 — Caption Latency Investigation | Gắn từng request với source window; phân biệt thời điểm submit, kết quả, draft, confirm, close và UI. Đo lịch timer, min audio, agreement và silence trước khi tuning. | Có nguyên nhân được tái hiện và phép so sánh cùng input; không trừ P50/P95 của hai metric khác mốc. |
| T2.1 — Desktop ↔ Meeting API Integration | Nối source references với job hậu kỳ qua authority hiện hữu và hợp đồng sync. | Không có hai canonical writer; cập nhật sai revision bị từ chối. |
| T2.2 — Batch Speaker Diarization | Tái sử dụng worker và registry; phân biệt acoustic cluster với danh tính được xác nhận. | Đo confusion/miss/overlap; không lấy channel attribution làm diarization accuracy. |
| T2.3 — Vietnamese Alignment Integration | Job revision-safe, nguồn có hash, fallback không gán giờ cho từ chưa aligned. | Đo riêng VI/EN; không gọi coverage là timestamp accuracy. |
| T2.4 — Speaker-Aware Canonical Transcript | Hoàn thiện attribution/identity và invalidation của toàn bộ dữ liệu phụ thuộc. | Edit/Restore/rename cập nhật evidence; job cũ không tái gắn annotation lỗi thời. |

## Ngưỡng sản phẩm đề xuất — chưa phải tiêu chí đã được phê duyệt

Các ngưỡng dưới đây là mục tiêu ban đầu cho cuộc họp 3 người trên cấu hình máy hiện tại.
Chưa thay mặc định của sản phẩm để cố đạt mục tiêu. Kết quả phải ghi số mẫu, khoảng đo và
coverage; trường hợp không đo được ghi **Not measured**, không ghi Pass.

| Chỉ số | Mục tiêu đề xuất | Cách đo |
|---|---|---|
| Caption đầu tiên của lượt nói | P50 ≤ 3 s; P95 ≤ 4 s | Từ onset lời nói đã gán nhãn đến chữ đọc được đầu tiên; báo riêng WS và UI. Leading silence không tính là ASR latency. |
| Caption ổn định/chốt câu | P50 ≤ 3 s; P95 ≤ 5 s | Từ cuối phát ngôn tham chiếu đến final tương ứng; không thay bằng end offset do chính ASR đoán. |
| Final flush khi Stop | P95 ≤ 3 s | Từ Stop đến final response và không còn pending/recovery chưa xử lý; báo riêng thời gian recovery. |
| WER/CER tiếng Việt, lời nói rõ | WER ≤ 12%; CER ≤ 8% | Unicode NFC, giữ dấu; WER theo token cách nhau bởi khoảng trắng, không coi là word segmentation tiếng Việt. |
| WER/CER tiếng Anh, lời nói rõ | WER ≤ 15%; CER ≤ 8% | Cùng normalization đã công bố. Disfluency, overlap và lỗi reference phải có quy tắc cố định trước khi chấm. |
| English mixed/overlap kiểu AMI | WER ≤ 25%; CER ≤ 15% | Gate thử nghiệm riêng cho mixed stream, công bố overlap; không dùng thay gate lời nói rõ. |
| Code-switching Việt–Anh | WER ≤ 20%; CER ≤ 10% | Audio người thật nói xen kẽ, không dùng ghép TTS hay AMI tiếng Anh để xác nhận. |
| Tên riêng, số, phủ định quan trọng | ≥ 95% đúng trên tập kiểm tay | Báo rõ số occurrence, lỗi trọng yếu và nguồn audio. Không suy ra từ WER tổng. |
| Mất/trùng source frame đã ACK | 0 | Replay/reconnect/crash so với receipt và archive; kiểm byte toàn nguồn. |
| Mất/va chạm ID finalized | 0 | So sánh ID, nguồn và khoảng thời gian trước/sau reconnect, restart, rename. Lỗi nhận dạng/mất từ chấm riêng qua WER. |
| Revision safety | 100% stale writes bị từ chối | Kiểm user edit, Restore, nguồn/giờ/audio, alignment, attribution, evidence và delayed job. |
| Biên phát ngôn | P95 sai lệch ≤ 500 ms | Đối chiếu biên utterance được kiểm tay; đây không phải word-boundary MAE. |
| Physical cumulative clock drift | ≤ 200 ms/giờ/source | Cần marker hoặc nguồn thời gian độc lập đầu/cuối. Source-clock replay chỉ kiểm mapping, không chứng minh ADC/cross-host drift. |
| Tăng RSS sau warmup | ≤ 200 MiB từ phút 10 đến phút cuối | Đo từng process; có đồ thị và kiểm xu hướng, không cộng RSS với Metal allocation như hai vùng RAM độc lập. |
| Pipeline/worker lỗi chưa xử lý | 0 khi kết thúc | Lỗi transient, số retry, audio giữ lại và job pending phải được công bố. Không gọi run complete là acceptance Pass. |

AMI overlap được báo riêng. WER trên mixed stream theo thứ tự thời gian là chỉ số mô tả,
không phải official AMI ASR hoặc cpWER. Một mình bài replay tiếng Anh không đủ đóng gate VI,
code-switching, mic, browser paint hoặc physical clock drift.

## Dataset đã chọn cho bước replay

AMI **EN2002c**, một cuộc họp tự nhiên liên tục với ba participant A/B/C, có annotation word-level
v1.6.2. File Mix-Headset tải từ mirror chính thức dài **2972.256 giây (49 phút 32.256 giây)**,
mono PCM16 16 kHz; 10.595 reference words. Metadata cuộc họp ghi duration 2972.33 giây;
thời lượng WAV là giá trị dùng để pace replay, không lấy metadata thay sample count.
Các khoảng word activity chồng lấn khoảng 630.46 giây; số này mô tả annotation, không phải DER.

Nguồn: [AMI download và CC BY 4.0](https://groups.inf.ed.ac.uk/ami/download/),
[audio EN2002c](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/EN2002c/audio/EN2002c.Mix-Headset.wav).
SHA-256, annotation hash, manifest, tiến độ và kết quả riêng tư nằm ngoài Git:
`~/tina-test-rig/stt-acceptance-20261024/`. Không sử dụng audio của người dùng để thay dữ liệu test.

Baseline: 29.723/29.723 audio ranges được ACK và khớp toàn bộ PCM; reconnect giữ đủ 621 finalized
IDs có trước đó. WER/CER **39,43%/31,22%**; 33 job đã lập còn chờ tại thời điểm đóng process.
Sau sửa lỗi FunASR với fragment quá ngắn, recovery trên bản sao chạy hết 639 windows với 571
request mới không lỗi, giữ nguyên audio và transcript/history cũ. WER/CER của bản sao sau recovery
vẫn **38,99%/30,68%**, chưa đạt ngưỡng đề xuất. Kết quả này không thay baseline bằng một lần
acceptance mới. Xem [điều tra và bằng chứng](caption-latency-investigation-20261024.md).

## Giới hạn cần quyết định trước gate chính thức

Desktop hiện từ chối PATCH trong khi capture của chính meeting còn active. Bài thử không được
bỏ guard này để tạo một kết quả Pass. Hiện có thể kiểm edit sau Stop khi worker hậu kỳ còn chạy,
và kiểm stale worker bằng các test riêng. Cho phép sửa đoạn đã finalized trong khi phần sau vẫn
đang thu là một thay đổi hành vi sản phẩm cần thiết kế riêng; hiện chưa được khẳng định hỗ trợ.

Whole-repo dataflow còn theo dõi riêng module Discord chưa đăng ký. Đây không phải lỗi ASR,
nhưng không được bỏ qua khi dùng gate toàn repo cho release. Không khởi động Phase 2, RAG,
Stateful Streaming hoặc tự động chạy job AI chỉ vì software foundation đã qua bounded tests.

Update 25/10: [quality A/B](stt-quality-ab-20261025.md) đã tìm thấy context echo trên request
340 ms và một gap speech 10,344 s chưa gửi ASR dù range được checkpoint covered.
Coverage cho Stop/reconnect đã được [sửa và kiểm lại](stt-checkpoint-20261025.md), có thêm guard
atomic cho frame đến muộn. [Short-context fix](stt-context-echo-20261025.md) bỏ inherited prompt
dưới 2 giây; WER/CER còn 35,46%/26,65% trên bốn clip. Insertion giảm nhưng deletion/tên riêng
vẫn cần xử lý. Đây là diagnostic, không thay kết quả acceptance 49 phút hoặc gate VI/EN.
Checkpoint lịch sử giữ nguyên; không coi chúng là bằng chứng ASR coverage.

[Deletion audit và recovery fix](stt-deletion-20261025.md): batch recovery không còn loại speech
chỉ vì single word ngắn; tái sử dụng mixed media/repetition policy, live Gmeet default giữ nguyên.
Cùng bốn clip: D **178→169**, I **10→10**, S **118→125**, WER/CER **35,23%/26,44%**.
Tổng lỗi chỉ giảm 2; chưa đóng quality gate. Thử context audio ở biên không bật mặc định vì có
neighbor-word leakage và thiếu word timestamps. Local Desktop đã cập nhật, raw/history/audio
và checkpoint hashes được giữ nguyên. Acceptance dài, natural VI/EN và hardware vẫn Pending.

[Boundary investigation](stt-boundary-20261025.md) đã xác nhận legacy Pyannote dùng frame-start
như frame-end (sớm một frame). Candidate sửa clock qua regression/full mixed suite, nhưng fail
quality gate trên bốn clip cũ và hai clip mới. Development D/I **169/10→172/13**; heldout tổng
lỗi **147→150**. Candidate được lưu riêng rồi hoàn nguyên khỏi source/dist mặc định, không
restart Desktop. Chưa đạt mục tiêu giảm deletion an toàn; không coi clock correctness test là
bằng chứng cải thiện ASR hoặc thay kết quả acceptance.

[Segmentation/overlap investigation](stt-segmentation-20261025.md) đã thử agreement hai model
predictions và phương án kết hợp clock, gồm hai validation clips mới. Cả hai fail gate từng nhóm.
Combined trên 8 clips: D **374→358**, I **17→25**, tổng lỗi **596→608**; không rollout dù recall
tăng. Source/dist đã hoàn nguyên đúng snapshot, production không restart. Cần đối chứng mixed
với audio per-source trước khi tiếp tục cut heuristics; Phase 1 và hardware acceptance vẫn Pending.

[Mixed-vs-native-headset experiment](stt-mixed-speaker-20261026.md): 12 windows mới của ES2002a,
3 repeats, official mix/controlled sum/4 original mics. High-overlap raw WER controlled mix
**25,24%**, active-headset **27,18%**; overlap-word D **10/33→1/33** nhưng S/I và inactive-channel
bleed tăng. Chưa đạt rule net-quality để chuyển per-source ASR. Fixed input/finalization smoke
không thấy quality regression. Không thay runtime, không rollout patches, không chạy lại acceptance
49 phút.

Paired FSMN-VAD on/off trên cùng 12 mixed windows cũng hoàn tất: high-overlap có 27 lỗi khi VAD bật
so với 30 khi tắt; low-overlap 33 so với 23; non-overlap 10 so với 8. Trace-only replay khớp raw
text 12/12 và cho thấy 30/31 deletions có midpoint trong FSMN ranges; 26/31 từ được phủ ít nhất
90%, nên cắt bỏ toàn từ bởi VAD không phải nguyên nhân chính ở mẫu này.

Held-out **EN2001b** dùng 12 cửa sổ mới, bốn headset tracks và ba repeats. High-overlap mixed/VAD-on
và headsets active đều có 51 lỗi; headset giảm D **47→14** nhưng S/I tăng **4→37**. Low-overlap
headsets có 31 lỗi so với mixed 15. Inactive tracks tạo 105 insertions, 82 token khớp annotation
của speaker khác. Rule per-source không đạt, và VAD on/off cũng đổi theo strata. Giữ HTTP Window
ASR + FSMN-VAD mặc định; không rollout per-source hay heuristic mới. Full live H3, VI/EN, mic thật
và acceptance 49 phút vẫn Pending.
