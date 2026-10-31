# Dashboard: Agent, model dùng chung và cuộc họp → Wiki

Ngày 29/10/2026. Đã triển khai vào Dashboard cục bộ `http://127.0.0.1:13001`, stack `tina-verify-20261015`.

## Cách dùng

- **Meetings → mở cuộc họp → Ask AI**: hỏi theo canonical transcript, chọn thêm tài liệu liên quan, bấm nguồn để đọc nguyên văn/người nói/thời gian và nghe audio khi còn bản ghi phù hợp.
- **Đề xuất cập nhật Wiki → Xác nhận lưu vào Wiki**: tạo trang mới từ câu trả lời và nguồn; không ghi đè trang cũ.
- **Wiki** ở sidebar: đọc các workspace được phép, mở/sửa Markdown riêng tư, lưu với SHA-256 của nội dung đã đọc. Nếu file thay đổi, bản nháp được giữ và server trả conflict.
- **Lưu và ghi phiên bản**: commit đúng file đã chọn trong Git workspace cục bộ, không push. Các file khác đang staged được giữ nguyên. Shared workspace chỉ đọc trong editor này.
- **Quyết định và công việc cần duyệt** trong Ask AI: sửa nội dung trình bày, Duyệt/Bỏ đề xuất/Mở lại. Review có revision riêng và evidence fingerprint; nguồn thay đổi thì review cũ được đánh dấu stale.
- **TINA Agent** ở sidebar: chat theo giao thức hiện tại, chọn cuộc trò chuyện và đọc lại lịch sử server. **Dừng xem** chỉ ngừng nhận phản hồi, không hứa hủy tác vụ server đã nhận.
- **Settings → Model AI dùng chung với Terminal**: xem model của chính tài khoản. Đổi model hoặc ChatGPT connection tại Terminal Settings; Dashboard dùng cùng backend phân giải cấu hình. Compose cung cấp link Terminal theo cổng public.

## Thay đổi kỹ thuật

1. `/api/agent/*` dùng cookie token của người đang đăng nhập → Gateway `/agent/*` → Agent API. Loại bỏ proxy trực tiếp sang Agent API cùng service key và việc đưa bot token vào chat body. Không có cookie thì trả 401; header user do client tự gửi không được chuyển tiếp.
2. POST/PUT/PATCH/DELETE kiểm tra origin theo URL public/Host và cấu hình đăng nhập; localhost/127.0.0.1/IPv6 loopback chỉ tương đương trên cùng cổng. Cross-origin/cổng khác bị từ chối. Request dài có deadline; trạng thái JSON và SSE upstream được giữ lại.
3. Generic chat dùng `prompt/session/turn_id`, SSE `message-delta/tool-call/done/turn-complete`, và chỉ ACK cursor sau frame hoàn chỉnh. Retry giữ nguyên turn nonce, bỏ frame trùng; UTF-8 bị chia chunk không làm mất chữ.
4. Dashboard Ask AI dùng backend meeting-knowledge hiện có và model của owner, không dùng provider/key AI riêng của Dashboard. Citation ID và fingerprint được server kiểm tra. Mỗi câu hỏi vẫn bị giới hạn 40 excerpt / 48.000 ký tự nguồn.
5. Agent API bổ sung `GET/PUT /api/workspace/document`: giới hạn content Markdown riêng tư, expected SHA-256, entity frontmatter validation, workspace write lock và atomic file replacement. Optional commit chỉ chạm file được duyệt; đường dẫn policy/config, traversal và symlink bị chặn.
6. Review fact được lưu riêng tại `.meeting-knowledge/{meeting_id}/reviews/{fact_id}.json`. Có expected review revision, fingerprint và đối chiếu nguyên văn/revision/speaker/timing với canonical. Canonical facts, transcript và audio không bị review ghi đè.
7. Model/settings, source warnings và link quay lại từ Wiki dùng cùng nguồn thẩm quyền với Terminal. Không đổi kiến trúc Capture/HTTP Window ASR.

## Kiểm tra

| Phạm vi | Kết quả |
|---|---|
| Dashboard suite cuối | 215 passed / 25 files |
| Agent suite | 653 passed |
| TypeScript Dashboard | PASS |
| Docker production build Agent API + Dashboard | PASS |
| ESLint cho source mới/sửa thuộc luồng AI/Workspace | 0 errors; 3 warnings về mutable request-sequence ref trong cleanup |
| Graph / dataflow / isolation / README | PASS |
| Dataflow | 126 nodes / 108 edges / 14 carriers; sealed |
| Mã Agent API đang chạy | SHA-256 của meeting_knowledge.py và workspace_documents.py khớp checkout |

Một test URL cũ có tên “non-loopback” nhưng fixture truyền `localhost` và kỳ vọng không đổi hostname, mâu thuẫn với test loopback liền trước. Đã sửa fixture sang `https://api.example.test`; không đổi logic resolver production để né lỗi test.

Smoke với phiên đăng nhập thật:

- Model endpoint trả `gpt-6-luna`, workspace tree trả 23 file; endpoint từng lỗi 500 nay trả 200.
- Ba endpoint Agent tree/models và AI config không có cookie đều trả 401, dù deployment có cấu hình backend.
- Câu hỏi về một câu có thật trong cuộc họp 37: HTTP 200 sau 5.320 ms, trả đúng speaker/segment; đây là một sample latency hỏi–đáp, không phải SLO hay latency ASR.
- Bấm citation mở nguyên văn “HƯỚNG DẪN”, tên người nói, time và revision. Segment này không có audio phù hợp; giao diện báo rõ thay vì hứa playback.
- Duyệt rồi xác nhận lưu Wiki qua UI; mở được trang mới, banner nguồn còn hợp lệ và link quay về đúng Ask AI.
- Sửa một trang smoke qua editor, lưu thành công rồi khôi phục đúng nội dung ban đầu; GET sau đó xác nhận byte content khớp. Không commit Git trên workspace production chỉ để test; selected-path commit và giữ staged file khác được chứng minh trong test cô lập.
- Thử Bỏ đề xuất → Mở lại trên một candidate có sẵn: revision review tăng và trạng thái cuối là pending; không thay canonical transcript. Conflict/fingerprint invalidation dùng fixtures, không sửa transcript thật để test.
- Generic Agent qua UI nhận câu trả lời `OK` đúng yêu cầu, sử dụng SSE hiện tại và xuất hiện trong danh sách session.
- Giữ ví dụ hỏi–đáp tại `wiki/meetings/37/b44885850254464d84bafc5addeb83ab.md`; bản chỉnh thử đã được khôi phục. Không đổi model hay tài khoản ChatGPT của người dùng.

## Triển khai và giới hạn

Chỉ recreate Dashboard và Agent API. PostgreSQL, Valkey, recording storage, workspace/auth volumes và các dịch vụ capture/ASR được giữ lại. Không commit/push checkout, không xuất bản image lên registry và không gửi thông báo ra dịch vụ bên ngoài.

Chưa thực hiện acceptance 45–60 phút hoặc test thiết bị audio. Retrieval vẫn trong một cuộc họp và tài liệu riêng tư liên quan; chưa thêm Hybrid RAG, shared-document Q&A hoặc đồng bộ Desktop SQLite. Review là trạng thái duyệt, không phải hệ thống giao việc, nhắc hạn hay tự thông báo.

File/Wiki và canonical transcript không dùng chung transaction. Kiểm tra freshness và expected SHA/revision ngăn các conflict đã kiểm thử, nhưng không tuyên bố atomic CAS xuyên database/filesystem hoặc chặn mọi external filesystem writer. Source ID hợp lệ cũng không bảo đảm model suy luận đúng. Existing tc-mutable shared-writer advisory vẫn còn ngoài phạm vi thay đổi này.
