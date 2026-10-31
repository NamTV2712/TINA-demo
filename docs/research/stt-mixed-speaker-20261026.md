# Mixed speech versus native headset ASR — 2026-10-26

**Đã hoàn thành thí nghiệm; chưa đủ bằng chứng để chuyển production sang ASR per-speaker.**
Tách headset giúp giảm deletion của từ nằm trong overlap, nhưng substitutions/insertions và
bleed trên kênh không hoạt động làm lợi ích tổng thể chưa đạt điều kiện định trước.
Không triển khai clock/agreement patches, đổi model hoặc sửa boundary heuristic trong vòng này.

## Dữ liệu và thiết kế đã khóa trước inference

Dùng **AMI ES2002a**, recording khác EN2002c của tám regression clips trước. Nguồn chính thức có
[bốn individual headsets và Mix-Headset](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/),
[manual annotations v1.6.2 và CC BY 4.0](https://groups.inf.ed.ac.uk/ami/download/).
`meetings.xml` ánh xạ **A→0, B→1, C→2, D→3**. Đây là scenario meeting với người nói thật;
metadata AMI ghi `seen_type=training`. Không khẳng định audio này chưa có trong training của
Qwen hoặc là independent test corpus của model.

Các WAV gốc mono PCM16/16 kHz có cùng số samples; không resample/time-stretch. Diagnostic
log-RMS 100 ms so với word activity có peak correlation ở lag **0** trong khoảng ±2 s cho cả
bốn kênh, đúng mapping; không dịch audio theo reference. Đây không phải đo phonetic alignment
hoặc hardware drift. SHA-256 nguồn, HTTP metadata, annotation và extracted inputs được lưu.

Chọn **12 windows ×10 s**, 4 mỗi nhóm, cùng một warmup window disjoint. Grid 250 ms; hai cạnh
có ít nhất 100 ms không cắt annotated word; 8–50 raw words/window; starts cách nhau ít nhất 12 s.
Selection dùng annotation, không dùng ASR. Nhóm high/low là tương đối trong recording này:

| Nhóm | Window starts (s) | Annotated overlap /10 s | Normalized reference tokens |
|---|---|---|---:|
| Non-overlap | 254,25; 366,75; 414,5; 454 | 0 | 53 |
| Low overlap | 178,5; 266,25; 331,75; 617,5 | 0,16–0,57 s | 78 |
| High overlap | 294,5; 306,5; 727,25; 1032,75 | 0,99–2,49 s | 103 |

Không gọi nhóm high là majority-overlap. Non-overlap controls chỉ có B/C; không đủ để kết luận
không regression cho mọi người nói, đặc biệt A chỉ có 5 reference tokens ở nhóm high.
Tám clip trước giữ nguyên làm regression, không dùng để tuning hoặc chọn windows mới.

## Các nhánh và điều kiện giữ cố định

- **Controlled mix:** quantize từng original headset với common gain **1/4**, rồi cộng đúng
  integer samples của bốn component. Không clipping/limiter, AGC hay normalization riêng từng kênh.
- **Headset A/B/C/D:** chính các component ở trên, cùng khoảng sample/time. Không dùng algorithmic
  separation. Headset gốc không có nghĩa chỉ chứa duy nhất giọng chủ microphone.
- **Official Mix-Headset:** cùng khoảng thời gian từ official mixed WAV, auxiliary arm giữ gain
  gốc. Không giả định preprocessing của nó giống controlled sum.

Mỗi window có 6 inputs, **3 independent HTTP calls/input**, block theo window/repeat và randomize
arm order bằng seed **20261026**. Tổng **216 scored calls +6 warmup**, không cache model output.
Các lần gọi lại cùng audio là repeatability checks, không phải 216 independent subjects/windows.

Cùng worker **Qwen3-ASR-0.6B + FSMN-VAD/MPS**, PID **87088**, pin model metadata/start time,
runtime file hashes, language `en`, không prompt, wire max-speech=15 s/min-silence=100 ms.
Inputs luôn 10 s; các field wire không được dùng làm bằng chứng cho segmentation nội bộ chưa log.
Không restart/reconfigure backend hoặc Desktop. Worker được kiểm idle trước mỗi call; user
capture sẽ dừng experiment với trạng thái incomplete.

## Quy tắc chấm

Headset nào chấm với reference của đúng speaker đó. Không nối các transcript riêng thành một
chuỗi để chứng minh cải thiện overlap. Primary diagnostic tính tổng lỗi trên **các kênh có ít nhất
một reference word trong window**; đây là oracle hoạt động từ annotation. Cả bốn kênh vẫn được
gửi model, và insertion của kênh không hoạt động được báo riêng, cùng all-channel totals.

Mixed output chỉ có một stream: dùng **oracle interleaving WER** của benchmark, mỗi hypothesis
token chỉ được dùng một lần. Reference orders phải giữ thứ tự từ trong từng speaker và mọi quan
hệ thời gian không overlap; chỉ words overlap được đổi thứ tự giữa speakers. DP chọn minimum
word errors, tie-break E/I/D/S; CER theo whole-word order đã chọn, không phải minimum-CER oracle.
Scorer được kiểm độc lập bằng exhaustive enumeration trên fixture nhỏ, gồm nested intervals.
Toàn bộ 216 stored scores vẫn khớp sau verification này.

Đây **không phải official AMI hoặc cpWER**. Oracle ordering ưu ái mixed arm; headset scoring giữ
speaker labels và phạt cross-channel bleed. Các metric có output contracts khác nhau, nên không
trình bày WER delta là causal effect size tổng quát đã được xác lập.

Mỗi reference token được đánh dấu overlap nếu midpoint nằm trong word activity của speaker khác.
S/D/hits cho nhóm từ này được tách; insertion không có word timestamp để tự gán vào overlap.
Đây là word annotations, không phải independent phonetic/speaker-boundary ground truth.

## Kết quả raw ASR

**72/72 window-input groups** có raw text giống hệt qua cả 3 calls. Bảng là một repeat; không
nhân ba denominator để tạo cảm giác có thêm independent evidence.

| Nhóm / input | S / D / I | Errors / refs | WER | CER |
|---|---:|---:|---:|---:|
| Non-overlap: official mix | 4 / 2 / 4 | 10 /53 | 18,87% | 12,44% |
| Non-overlap: controlled mix | 6 / 2 / 1 | 9 /53 | 16,98% | 9,45% |
| Non-overlap: active headsets | 6 / 3 / 1 | 10 /53 | 18,87% | 12,44% |
| Low: official mix | 15 / 10 / 6 | 31 /78 | 39,74% | 23,95% |
| Low: controlled mix | 14 / 10 / 7 | 31 /78 | 39,74% | 22,46% |
| Low: active headsets | 15 / 4 / 7 | 26 /78 | 33,33% | 17,66% |
| High: official mix | 10 / 17 / 0 | 27 /103 | 26,21% | 20,74% |
| High: controlled mix | 10 / 16 / 0 | 26 /103 | 25,24% | 20,48% |
| High: active headsets | 14 / 7 / 7 | 28 /103 | 27,18% | 19,68% |

Headset WER/CER theo speaker, một repeat:

| Nhóm | Speaker | Ref tokens | S / D / I | WER / CER |
|---|---|---:|---:|---:|
| Non-overlap | B | 45 | 5 / 2 / 1 | 17,78% /12,05% |
| Non-overlap | C | 8 | 1 / 1 / 0 | 25,00% /14,29% |
| Low | A | 26 | 6 / 1 / 2 | 34,62% /24,77% |
| Low | B | 17 | 2 / 0 / 0 | 11,76% /5,33% |
| Low | C | 22 | 3 / 3 / 2 | 36,36% /21,59% |
| Low | D | 13 | 4 / 0 / 3 | 53,85% /14,52% |
| High | A | 5 | 2 / 1 / 4 | 140,00% /116,67% |
| High | B | 77 | 9 / 4 / 1 | 18,18% /13,45% |
| High | D | 21 | 3 / 2 / 2 | 33,33% /19,28% |

WER >100% là hợp lệ khi insertion lớn hơn denominator nhỏ; không loại A sau khi xem kết quả.

Trong **33 reference tokens thực sự có midpoint ở overlap** của nhóm high:

| Input | Hits | S | D |
|---|---:|---:|---:|
| Controlled mix | 17 | 6 | 10 |
| Đúng headset | 24 | 8 | 1 |

Như vậy có tín hiệu per-headset cải thiện overlap-word recall, nhưng không cải thiện net quality
ở nhóm high. Không gọi (S+D)/33 là overlap WER vì chưa gán insertion vào lớp thời gian này.

## Bleed, coverage và H3

Các headset không có reference speech trong window vẫn sinh **15 /10 /7 insertion** tương ứng
high/low/non-overlap mỗi repeat. Có text khớp lời người khác trong window; chưa tách hoàn toàn
actual crosstalk khỏi hallucination. Điều này bác bỏ giả định headset là perfectly isolated voice.

Trên toàn bộ 234 reference tokens, active-headset raw có **64** lỗi, controlled mix **66**; tính
cả bốn headset, raw có **96** lỗi. Do đó không lấy oracle active-channel result làm production
pipeline quality. Sau scratch finalization, all-headset còn **76** lỗi, controlled mix vẫn **66**.

Không có PCM thay đổi/mất; mọi request đủ 160.000 samples, wire hash đúng manifest. **0** reference
word intervals cắt qua outer request edges trong tập đã chọn, nhưng không kết luận H1 luôn bằng 0
trong live pipeline. FSMN-VAD vẫn hoạt động bên trong service: trong 10 overlap deletions của
controlled-mix/high, **8** ở trọn trong returned sentence spans, **2** ngoài/cắt qua spans. Spans
có thể là coarse fallback; không phải log đầy đủ từng decoder input slice. Lượt MPS đầu tiên chưa
có VAD-bypass arm; đối chứng riêng sau đó được báo cáo bên dưới.

Proxy giữ raw response; client text không đổi ở **216/216** scored calls. Scratch one-window
Gmeet finalization dùng recovery filter policy và chỉ chấp nhận byte-identical cached input:
không mismatched input/fault. Có **15** text changes (5 unique inputs), đều do pre-ASR RMS gate
không gửi buffer vào callback; cả 15 đều giảm scored errors, không tìm thấy finalization làm
quality xấu đi trong smoke này. Một input là mic A có 1 reference token nhưng raw đã nhận sai.

H3 **không được loại trừ toàn hệ thống**: smoke không chạy SQLite, delayed worker/CAS, live
multi-window merging, reconnect, attribution updates hoặc UI. Nó chỉ kiểm raw→client→final ở
cùng fixed input. Các bounded recovery/revision tests trước vẫn giữ nguyên.

## Đối chứng FSMN-VAD bật/tắt trên cùng PCM

Sau so sánh mixed/headset, chạy thêm đối chứng trên **đúng 12 mixed windows**, mỗi window 10 giây,
giữ nguyên PCM giữa hai nhánh. Mỗi window/nhánh chạy ba lần: **72 scored HTTP requests**. Cả ba
lần trong từng cặp window/nhánh cho raw transcript giống hệt nhau. Scratch worker dùng Qwen cache
revision `5eb144179a02acc5e5ba31e748d22b0cf3e303b0` và FSMN snapshot `master`, chạy CPU để tránh
tải thêm model lên MPS đang phục vụ production. Đây là thay đổi VAD trong cùng FunASR/Qwen service;
khi bật VAD, decoder nhận các chunk do service tạo ra, còn khi tắt VAD, Qwen nhận cả 10 giây.

| Nhóm | FSMN-VAD bật: S/D/I, lỗi, WER | VAD tắt: S/D/I, lỗi, WER | Chênh tổng lỗi khi tắt |
|---|---:|---:|---:|
| High overlap (103 từ) | 10/17/0, **27**, 26,21% | 9/21/0, **30**, 29,13% | +3 |
| Low overlap (78 từ) | 15/11/7, **33**, 42,31% | 9/12/2, **23**, 29,49% | −10 |
| Không overlap (53 từ) | 6/3/1, **10**, 18,87% | 4/4/0, **8**, 15,09% | −2 |

Trong nhóm high, bỏ VAD làm deletion tăng **17→21** và tổng lỗi tăng 3. Ở low, tổng lỗi giảm
10 chủ yếu nhờ substitutions **15→9** và insertions **7→2**, dù deletion tăng 1. Ở nhóm không
overlap tổng lỗi giảm 2. Vì vậy FSMN-VAD có tác động theo nhóm; dữ liệu này không ủng hộ tắt VAD
toàn cục. Bỏ VAD cũng không xóa lỗi mixed speech: nhánh đó vẫn có 30 lỗi high và 23 lỗi low.

Instrumentation ghi **36 FSMN calls**, **156 Qwen decoder calls** ở nhánh bật VAD, so với **36**
full-window Qwen calls ở nhánh tắt. 72 request khớp hashes của 12 PCM windows đã khóa. Nhánh FSMN/CPU có
27/33/10 lỗi theo thứ tự high/low/non-overlap, so với MPS mixed baseline 26/31/9; chênh 1–2 lỗi
mỗi nhóm cho thấy hướng tương tự nhưng không xóa được khác biệt CPU/MPS.

Có lỗi serializer ở run chấm điểm: 36 hàng FSMN lưu `vad_ranges` rỗng, dù trace xác nhận VAD đã
được gọi và Qwen nhận nhiều chunk. Sau khi sửa parser, chạy lại một trace-only arm trên 12 PCM cũ;
Qwen raw text khớp run chấm điểm **12/12** lần, và ranges được lưu cho cả 12 windows.

| Nhóm | Deletions | Midpoint trong VAD | Phủ ≥90% thời lượng từ | Phủ một phần |
|---|---:|---:|---:|---:|
| High overlap | 17 | 17 | 13 | 4 |
| Low overlap | 11 | 10 | 10 | 1 |
| Không overlap | 3 | 3 | 3 | 0 |
| Tổng | **31** | **30** | **26** | **5** |

Không có deletion nào hoàn toàn nằm ngoài mọi VAD range; một từ ở nhóm low có midpoint ngoài
nhưng chỉ 16,9% thời lượng giao với range. Trace này làm giảm khả năng giải thích chính cho H1
rằng FSMN bỏ hẳn phần lớn từ bị xóa. Nó không chứng minh boundary vô can: năm từ bị cắt phủ một
phần và một số phần đầu/cuối vẫn có thể mất. VAD range chỉ cho biết vùng FSMN trả về; chưa phải
đường bao phonetic độc lập.

Đây là bằng chứng có giới hạn rằng nhánh FSMN/segmenting góp phần vào transcript và giúp recall
deletion ở một số high-overlap windows. Nó chưa tách riêng độ chính xác của boundary khỏi ảnh
hưởng việc chia request, cũng chưa khẳng định Qwen là nguyên nhân duy nhất của lỗi còn lại. Tập
chỉ gồm một cuộc họp tiếng Anh; cùng một CPU worker giảm confound giữa hai arm nhưng không thay
thế kiểm tra trên MPS hoặc cuộc họp độc lập.

## Held-out meeting thứ hai: EN2001b

Để kiểm tra trên người nói và meeting khác, dùng AMI **EN2001b**, một non-scenario meeting ngày
15/02/2005 với bốn participant khác ES2002a; nó có manual word annotations v1.6.2 và Mix-Headset
cùng bốn headset channels riêng. [AMI signal index](https://groups.inf.ed.ac.uk/ami/corpus/signals.shtml) ghi meeting ID,
participant IDs và duration; [AMI download page](https://groups.inf.ed.ac.uk/ami/download/)
xác nhận gói manual annotation v1.6.2/CC BY 4.0. Audio ranges lấy từ
[official EN2001b audio directory](https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/EN2001b/audio/).

Chọn trước inference 12 cửa sổ 10 giây, bốn mỗi strata overlap. Để giảm transfer, chỉ lấy **65
HTTP byte ranges** (warmup + 12 cửa sổ × mix và bốn tracks), kiểm `206 Content-Range`, ETag,
sample offsets và SHA-256 từng range. Các tracks cùng mono PCM16/16 kHz và frame count. Controlled
mix là tổng integer của bốn headset channels sau gain chung 1/4. Plan và range manifest nằm ngoài
Git tại `~/tina-test-rig/stt-mixed-speaker-20261026-followup/en2001b-range-experiment/`.

Chạy cùng Qwen snapshot và FSMN service code trên scratch CPU worker, không gọi model trên MPS
production. Mỗi test window có sáu arm: controlled mix/VAD-on, controlled mix/VAD-off, và bốn
headset/VAD-on; ba repeats cho **216 request**. 72 tổ hợp window/arm đều cho raw text giống hệt
qua ba lần. WER mixed vẫn là annotation-constrained interleaving oracle; headset được chấm với
reference của speaker đó. Inactive headset windows là insertion controls, không nhập vào WER của
active channels.

| Nhóm | Window starts (s) | Annotated overlap /10 s | Reference words |
|---|---|---:|---:|
| Non-overlap | 104; 555,75; 747,5; 2373,75 | 0 | 74 |
| Low overlap | 1115,75; 2278,25; 2652,5; 2739,25 | 0,04–0,26 s | 114 |
| High overlap | 488,5; 2100; 2313,75; 3228 | 1,93–6,26 s | 154 |

| Nhóm | Refs | Mixed/VAD-on S/D/I, WER | Mixed/VAD-off S/D/I, WER | Headsets active S/D/I, WER | Inactive inserts / calls; other-speaker matches |
|---|---:|---:|---:|---:|---:|
| High overlap | 154 | 4/47/0, 33,12% | 6/47/0, 34,42% | 8/14/29, 33,12% | 46 /4; **41** |
| Low overlap | 114 | 7/7/1, 13,16% | 2/12/1, 13,16% | 5/5/21, 27,19% | 50 /8; **36** |
| Không overlap | 74 | 8/4/2, 18,92% | 6/4/0, 13,51% | 7/4/1, 16,22% | 9 /12; **5** |

Qua 342 reference words, mixed/VAD-on có **80 errors** (WER 23,39%); mixed/VAD-off **78**
(22,81%); active-headset channels cộng lại **94** (27,49%). Ở overlap cao, per-headset giảm
deletion **47→14**, nhưng substitutions/insertions tăng **4→37**, nên tổng errors vẫn 51 ở cả
hai nhánh. Low-overlap headset tăng tổng errors **15→31**. Trong inactive-track controls có
**105 insertions** trên 24 inactive requests mỗi repeat; **82** token khớp annotation của speaker
khác theo speaker/time-constrained alignment (high 41/46, low 36/50, non-overlap 5/9). Đây là
evidence về cross-channel speech/bleed trong headset inputs; phần còn lại có thể là bleed chưa
được annotate hoặc hallucination. Cả ba repeats cho cùng kết quả.

Rule đã khóa không đạt trên held-out meeting: high-overlap WER improvement của active headsets là
**0 percentage points**, substitutions tăng và non-overlap regression không xấu. FSMN-on/off cũng
không có winner chung: bật VAD giảm 2 errors ở high, hòa ở low, nhưng tăng 4 errors ở non-overlap.
Điều này củng cố việc **không rollout per-speaker ASR, không tắt VAD toàn cục, không đổi HTTP
Window ASR mặc định**. CPU scratch latency (36 requests/arm) là 13,25/19,44 giây P50/P95 mixed-on,
11,38/14,13 mixed-off; bốn headset streams cộng lại cần 144 requests và khoảng 996 giây serial
HTTP, chưa phải đo parallel production latency.

Đây vẫn là hai AMI meetings tiếng Anh với 120 giây annotated windows mỗi meeting, không phải
microphone E2E, tiếng Việt–Anh, hoặc 49-minute acceptance. Mỗi meeting là sample độc lập; ba repeat
trên cùng PCM chỉ xác nhận tính ổn định của inference.

## Độ trễ và chi phí đo được

Không warmup trong bảng. HTTP timing gồm local upload/service/response; không phải caption lag.

| Input | Requests | Submitted audio | HTTP total | HTTP P50/P95 |
|---|---:|---:|---:|---:|
| Official mix | 36 | 360 s | 65,37 s | 1,43 /4,34 s |
| Controlled mix | 36 | 360 s | 63,78 s | 1,57 /3,38 s |
| Bốn headset, kể cả inactive | 144 | 1440 s | 124,21 s | 0,59 /2,26 s mỗi request |

All-headset có 4× requests, khoảng **1,95×** serial HTTP work so với controlled mix. Tổng HTTP
của bốn kênh trong mỗi case/repeat có P50/P95 **3,27 /7,27 s**. Không so sánh request median
của nhiều kênh inactive với latency hoàn thành cả meeting window. Đây không phải monetary/GPU
cost estimate hoặc benchmark hệ thống parallel. RSS trước/sau calls sampled tối đa khoảng
245 MiB cho process; không phải toàn bộ MPS/Metal allocation hay true peak RAM.

## Quyết định theo rule đã khóa

Rule diagnostic đã định trước cho ES2002a: high-overlap active-headset WER cải thiện ít nhất 10 percentage points
so với controlled-mix oracle WER ở cả 3 repeats; S/D cùng giảm; non-overlap regression ≤2 points.
Rule **không đạt**: high WER xấu đi **1,94 points**, S tăng dù D giảm; non-overlap xấu đi **1,89
points**. Rule này không thay/giảm product quality gate của TINA.

- **H1:** thiếu PCM hoặc outer window cắt annotated words không giải thích các lỗi ở tập fixed
  windows. Trace follow-up cho thấy 30/31 deletion có midpoint trong FSMN ranges, nên việc VAD bỏ
  hẳn các từ đó không phải lời giải thích chính; clipping một phần vẫn cần xem xét.
- **H2:** lỗi còn lại ở nhánh VAD-off tương thích với giới hạn nhận dạng mixed speech trong cùng
  service stack; chưa quy được riêng cho Qwen model hoặc khẳng định per-source ASR có net quality
  tốt hơn. Native headset vẫn có bleed và thí nghiệm trước không đạt rule rollout.
- **H3:** không tìm thấy regression ở fixed-window finalization smoke; chưa kiểm toàn live chain.

Giữ HTTP Window ASR và FSMN-VAD mặc định. Không rollout per-source ASR, tắt VAD toàn cục hay đổi
boundary heuristic theo một recording. Bước nghiên cứu kế tiếp là lặp lại đối chứng trên một cuộc
họp độc lập có track riêng ít bleed; nếu tiếp tục phân tích VAD, trước tiên phải giữ `vad_ranges`
cho từng scored request để có thể đối chiếu deletion với vùng VAD. Không dùng oracle activity
gating như tính năng production.

## Reproduction và trạng thái

Tools: `deploy/transcription/benchmark/mixed_speaker.py`, `mixed_speaker.mjs`,
`prepare_mixed_speaker_ranges.py`,
`prepare_vad_factor.py`, `mixed_speaker_vad.mjs`, `funasr_vad_probe.py`,
`report_vad_factor.py` và các test benchmark tương ứng; dùng dependency đã cài. Source manifests,
audio, plans, raw responses, timing, per-speaker scores, VAD/RMS audits và hashes nằm ở
`~/tina-test-rig/stt-mixed-speaker-20261026/` và `~/tina-test-rig/stt-mixed-speaker-20261026-followup/`,
ngoài Git. Plan/runs/reports không bị overwrite.
Scorer có 7 tests gồm exhaustive valid reference orders; runtime/input hashes được kiểm.

Production Desktop/ASR không restart và không thay config; không ghi journal production, không
Apply transcript, không rebuild cloud images. Tám regression clips không sửa/chạy tuning. Hai
recordings tiếng Anh, 240 s source speech windows tổng cộng; không thay acceptance 49 phút,
VI/EN code-switch hoặc physical mic/clock validation. **Phase 1 vẫn Pending.**
