# Context echo ở request ngắn — 2026-10-25

**Đã triển khai local:** live windows ngắn hơn hai giây không gửi text của câu trước làm
continuity prompt. Bốn clip AMI cố định có WER giảm **49,13% → 35,46%**, CER
**38,81% → 26,65%**. Đây là diagnostic 240 giây, không phải acceptance 49 phút.

## Sửa ở đường gửi request

`continuityPrompt(previousText, pcm, sampleRate)` là helper chung của shared ASR module.
Mixed/Pyannote, Gmeet và Teams CSRC đều dùng actual sample count để chọn context:

- Dưới 2 s: transcribe audio ngay theo lịch hiện hữu, không inherited prompt.
- Từ 2 s: giữ context/cap hiện hữu của caller. Không thêm thời gian đợi hay merge lượt nói.
- Helper không đổi PCM, timestamp, confirmation/recovery hoặc text response. Không thêm bước
  xoá chữ theo trùng prompt. Các bộ lọc hiện hữu vẫn có giới hạn riêng của chúng.
- Explicit prompt truyền trực tiếp cho TranscriptionClient, gồm vocabulary của refinement được
  review/Apply, vẫn được giữ. Không tự sửa tên riêng hay nội dung raw/canonical lịch sử.
- `vi-en` vẫn hold kết quả ngôn ngữ/script ngoài phạm vi và giữ original audio/text. Khi không
  truyền inherited context thì optional forced retry không còn diacritic hint cũ và mặc định
  English; đó chỉ là suggestion chờ review, không được tự đưa vào canonical.

Continuous-buffer eval dùng cùng selector; cache key thêm prompt digest để không đọc lại kết quả
của policy cũ cho cùng audio window. HTTP Window ASR/Qwen/FSMN vẫn là mặc định.

## Request-level comparison trước rollout

Plan được cố định trước inference từ [checkpoint replay](stt-checkpoint-20261025.md): mọi request
live unique dưới 2 s có prompt, một control 2–5 s mỗi clip, 15 utterance VI/EN TTS sẵn có,
6 short TTS controls khai báo trước và 3 negative controls. Tổng **125 cases / 232 HTTP requests**.
WAV/source PCM hashes được kiểm; chỉ thay prompt. Các request có tham số giống nhau share một
decode, có flag `shared_decode`, không trình bày như hai mẫu độc lập.

| Nhóm | Số case | Unconditional context | Candidate |
|---|---:|---|---|
| AMI <2 s | 97 | 651 word errors / 392 reference tokens | 239 / 392 |
| AMI 2–5 s | 4 | Giữ context | Tham số như cũ, shared decode |
| Synthetic meeting VI/EN | 15 | WER 1,89%, CER 0,79% | Không đổi; 14 long cases share decode |
| Short repeat/negation/name TTS | 6 | 0/14 word errors | 2/14 word errors, đều ở tên riêng |
| Silence/noise/residue | 3 | Empty output | Empty output |

WER diagnostic của AMI fragments là **166,07% → 60,97%**; số >100% do insertion. Các range rất
ngắn có thể cắt giữa phones và chứa overlap; reference theo word midpoint, không phải ground truth
phonetic của fragment. Chúng được dùng để tìm cơ chế echo, không đại diện WER cả cuộc họp.

Ngưỡng 1 s được tính từ cùng paired responses: 294 lỗi /392 tokens (75,00%), còn ngưỡng 2 s là
239/392 (60,97%). Có echo lớn ở audio 1,01/1,52/1,57 s, nên chỉ chặn dưới 1 s là chưa đủ trên tập này.
Đây không phải một E2E độc lập cho threshold 1 s hay held-out evaluation.

Case khoảng 340 ms trước đây sinh 20 tokens câu trước; candidate trả “What.”. Reference midpoint
là “work with”: echo đã giảm, nhưng fragment vẫn chưa nhận đúng. Candidate giữ đủ “vâng, vâng”,
“không, không”, “yes, yes”, “no, no” trong các controls. Hai lỗi tên riêng còn lại: **Minh → Mình**
và **Minh → min**. Prompt baseline của các controls lặp/tên chứa chính cụm được nói lại, nên
không dùng điểm baseline đó làm ước lượng nhận dạng không được gợi ý.

VI/EN controls dùng macOS synthetic voices; không có bằng chứng mới về mic thực, natural
code-switching hoặc độ chính xác tên riêng trên người thật.

## Replay liên tục trên cùng bốn clip

Source/reference/normalization/selection giữ nguyên; runtime file hashes không đổi trong lúc chạy,
ASR worker MPS PID 87088 không restart. Cả trước và sau đều dùng checkpoint fix và đợi recovery
settle, nên không ghép kết quả cũ còn pending vào so sánh này. Các clip là diagnostic extremes đã
được dùng để chọn policy, không phải held-out corpus hay một ước lượng production tổng quát.

| Chỉ số live + settled recovery | Trước | Sau |
|---|---:|---:|
| WER (863 reference tokens) | 49,13% | **35,46%** |
| CER | 38,81% | **26,65%** |
| Substitution | 139 | 118 |
| Deletion | 156 | 178 |
| Insertion | 129 | **10** |
| Tổng word errors | 424 | 306 |

Direct 15 s/no-prompt control vẫn **31,87% WER / 23,75% CER**. Tính tổng lỗi/reference từng clip
riêng, không align xuyên biên clip. Echo/insertion giảm mạnh nhưng deletion tăng 22; không tuyên bố
nhận dạng đã hoàn chỉnh hay không còn bỏ sót lời nói. Tuning context cho input dài/ít speech vẫn mở.

| Clip | WER sau | CER sau | Short HTTP requests không context | Stop → recovery settle |
|---|---:|---:|---:|---:|
| 840–900 s | 23,00% | 17,25% | 30 | 2,567 s |
| 900–960 s | 38,12% | 32,24% | 54 | 1,866 s |
| 1500–1560 s | 34,76% | 21,54% | 29 | 1,583 s |
| 2340–2400 s | 44,58% | 33,76% | 78 | 2,175 s |

Proxy chứng minh **191/191 short requests không có prompt trên wire**, trong khi 58 long requests
vẫn có context. 2.400/2.400 frame ACK; archive hashes khớp trước/sau; giữ đủ 55 finalized IDs có
trước reconnect trong run mới, không đổi biên/trùng ID, zero pending/retry và zero HTTP failure.
Edit/stale CAS/Restore qua. Không reference-token midpoint nào nằm ngoài tất cả request đã map
nguồn; coverage không đồng nghĩa nhận dạng đúng. Không lấy bốn Stop samples để chứng nhận P95.

## Kiểm tra, triển khai và giới hạn

- Regression mixed trước sửa fail vì request 0,5 s nhận sentence trước. Sau sửa, VI/EN repeated
  utterances trong context không bị helper xoá; long prompt và source duration giữ nguyên.
- Gmeet forced short flush và exact 2 s edge qua; shared helper test kiểm sample rate, PCM/text,
  explicit refinement prompt và held unexpected-language result.
- Suite shared Whisper, Gmeet, mixed và Desktop đều pass. Package isolation qua. False positive
  của Gmeet isolation với `node:test` được sửa bằng exact builtin match, có negative tests vẫn
  từ chối builtin giả và undeclared dependency. Không mở rộng quyền import tùy ý.
- Desktop graceful restart khi không capture/refinement, ASR queue idle. Sau update vẫn 41 meetings,
  216 transcript records, 103.125 PCM chunks; hash toàn bộ raw/history, PCM và coverage khớp backup.
- Source cho cloud Bot đã dùng cùng helper, nhưng chưa rebuild/deploy Bot image trong task local này.
  Không thay image khác khi gate toàn repo còn Discord unregistered và api.v1/invocation.v1 khác seal.

Artifacts riêng tư: `~/tina-test-rig/stt-context-echo-20261025/`: frozen `request-plan.json`,
`request-results/results.json`, `request-score.json`, test logs; `quality-ab/` có raw requests,
events, PCM journals, runtime fingerprints, quality report và `context-validation.json`;
`deployment/` có backup và kiểm hash. Không overwrite dữ liệu lịch sử hoặc push/commit.

**Phase 1 vẫn Pending.** Tiếp theo cần xử lý mất từ/fragment boundaries và kiểm VI/EN người thật;
sau khi chất lượng đạt ngưỡng mới chạy lại 49 phút, physical capture/drift và toàn bộ revision chain.
