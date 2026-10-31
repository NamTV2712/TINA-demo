# Cuộc họp → transcript → Wiki

Ngày: 29/10/2026. Đã triển khai vào stack cục bộ `tina-verify-20261015`, Terminal cổng 23000.

## Cách dùng

1. Mở một cuộc họp trong Terminal.
2. Nhập câu hỏi ở **Hỏi về cuộc họp này**. Mặc định chỉ dùng canonical transcript của cuộc họp đó.
3. Nếu cần, mở **Tài liệu liên quan** và chọn những tài liệu Markdown riêng tư đã được liên kết với cuộc họp.
4. Bấm nguồn dưới câu trả lời để xem nguyên văn, người nói và thời gian. Có audio gốc phù hợp thì có nút phát; thiếu audio được báo rõ.
5. Bấm **Đề xuất cập nhật Wiki**, duyệt nội dung và nguồn, rồi **Xác nhận lưu vào Wiki**.
6. Mở trang Wiki đã lưu. Trang tự kiểm tra nguồn, có đường dẫn trở lại cuộc họp.

Mỗi lần xác nhận tạo một trang mới tại `wiki/meetings/{meeting_id}/{answer_id}.md`. Không tự ghi đè hay ghép vào trang hiện có. Bản nháp/câu trả lời được lưu riêng trong `.meeting-knowledge/{meeting_id}/` của workspace chính, có thể đọc lại sau khi tải lại trang. Giao diện liệt kê 20 câu trả lời gần nhất; trang Wiki có endpoint kiểm tra riêng cho câu trả lời cũ hơn.

## Những phần được bảo vệ

- Gateway phân giải API key, Agent API lấy user từ header được Gateway xác thực; Meeting API kiểm tra chủ cuộc họp trước khi trả canonical transcript.
- Chỉ những tài liệu liên quan trong workspace được phép mới được chọn. Chưa truy vấn xuyên cuộc họp hoặc tự tìm trong tất cả workspace.
- Chọn tối đa 40 excerpt / 48.000 ký tự nguồn cho mỗi câu hỏi. Giao diện báo phạm vi chưa đầy đủ, không tuyên bố đã kiểm tra toàn bộ cuộc họp.
- Model chạy qua CompletionPort trong worker ngắn hạn, không có tool loop hoặc phiên chat công khai. Model dùng cấu hình của chủ cuộc họp.
- Claim chỉ được dùng các source ID đã cấp. Nguyên văn, speaker và timestamp do server cung cấp, không lấy từ lời model tự tạo.
- Fingerprint ràng buộc text, revision, speaker revision, timing và audio references; nguồn tài liệu cũng ràng buộc hash nội dung.
- Sửa, Restore, đổi tên người nói, đổi timing/audio reference hoặc sửa tài liệu nguồn làm answer cũ mất hiệu lực. Apply từ chối nguồn cũ; trang Wiki kiểm tra lại khi mở, focus, nhận correction event và mỗi 15 giây.
- File được xuất bản theo create-only: retry cùng nội dung được chấp nhận, trang đã bị người dùng sửa được giữ nguyên.
- Native Capture, HTTP Window ASR, raw audio, raw ASR và canonical transcript không bị sửa bởi chức năng này.

## Bằng chứng kiểm tra

| Kiểm tra | Kết quả |
|---|---|
| Agent, toàn bộ suite cuối | 649 passed |
| Terminal, toàn bộ suite cuối | 560 passed / 76 files |
| Gateway proxy, gồm JSON status/error và chống giả mạo owner | 13 passed |
| TypeScript và build production | PASS |
| Graph / dataflow / isolation / README gates | PASS |
| Dataflow hiện tại | 125 nodes, 107 edges, 14 carriers; seal hợp lệ |
| Source code trong Agent API và Gateway đang chạy so với checkout | SHA-256 khớp |

Test tự động bao gồm: không ghi Wiki trước Apply; retry; không ghi đè user edit; sửa/Restore/đổi speaker/timestamp; nguồn bị xóa; segment mới không làm hỏng nguồn cũ; sửa tài liệu; source ID giả; đường dẫn/symlink vượt workspace; readonly private dispatch; worker gọi CompletionPort; source dialog; lỗi kiểm tra freshness; banner Wiki trong mounted workspace.

Smoke trên giao diện/API thật của cuộc họp 37:

- Đặt câu hỏi về một câu có sẵn trong transcript; model trả đúng speaker và source segment. Request ở bản cuối trả HTTP 200 sau 4.323 ms. Đây là một sample hỏi–đáp, không phải latency ASR hay SLO.
- Phạm vi được hiện rõ: 40/315 segment. Click nguồn mở nguyên văn cùng speaker/time/revision.
- Thực hiện bước duyệt và xác nhận, mở được trang Wiki; source link quay về cuộc họp. Banner fresh và stale đều đã được quan sát trên UI.
- Một segment khác có recording ở cuộc họp 35 trả HTTP 200, `audio/wav`, 628.844 bytes. Segment dùng cho câu hỏi ở cuộc họp 37 không có recording phù hợp; UI báo thiếu audio. Không bật playback ra thiết bị và không đổi audio device.
- Bản thử trước phát hành đã được dọn sau khi xác nhận nội dung chưa bị sửa. Giữ một ví dụ hiện hành tại `wiki/meetings/37/b0aea435750c45309f132c73835c2757.md`.

Agent API, Gateway và Terminal đã được cập nhật; worker image mới được dùng cho dispatch mới. Các dịch vụ và volume PostgreSQL/Valkey/storage vẫn được giữ lại. Không tạo commit hoặc push source code.

## Giới hạn

Đây là bounded lexical retrieval trong một cuộc họp, không phải Hybrid RAG hoặc tìm kiếm toàn bộ lịch sử. Kiểm tra source ID/fingerprint không chứng minh model suy luận đúng; người dùng vẫn cần đọc nguồn. Chưa tự đồng bộ Desktop SQLite, đọc tài liệu shared workspace cho câu hỏi, merge trang có sẵn hoặc commit Git cho trang vừa tạo.

Meeting API và filesystem không có chung transaction. Apply kiểm tra nguồn ngay trước khi ghi, nhưng không hứa atomic CAS xuyên hai hệ thống; source fingerprint được giữ lại và recheck trên các màn hình. Test revision dùng fixture có kiểm soát, không sửa transcript sản xuất để kiểm thử. Chưa có acceptance trên một cuộc họp mới kéo dài 45–60 phút. Dataflow vẫn có advisory shared-writer tc-mutable đã tồn tại từ trước.
