# Production restart — 2026-10-30

Theo yêu cầu restart production, đã cập nhật/recreate sáu service ứng dụng bằng image source vừa build: admin-api, runtime, meeting-api, agent-api, gateway và terminal.

- Docker context: desktop-linux; project: tina-verify-20261015.
- Giữ chuỗi Compose đang dùng: file gốc và /tmp/tina-canonical-notes-runtime-override.json.
- Không đổi Docker context mặc định của máy (vẫn orbstack); không tác động migration agent.
- PostgreSQL, Redis và object storage giữ nguyên container và volume. Các volume auth/workspace của ứng dụng cũng giữ nguyên.
- Không bật thêm flows-api, flows-worker hoặc mcp; không restart native capture/Desktop hoặc ASR host.

Kiểm chứng sau thao tác:

- Sáu ứng dụng đều dùng image ID đúng với tag vừa build và container mới đều healthy.
- Terminal :23000 và health endpoint Gateway :28056, Agent API :28100, Meeting API :28080, Admin API :28057, Runtime :28090 đều trả HTTP 200.
- Terminal trả HTML chứa TINA; không thấy startup traceback trong log đã kiểm tra.
- meetings, transcriptions và users của PostgreSQL này đều có count 0 trước restart và vẫn 0 sau restart. Không khẳng định đây là dữ liệu lịch sử đầy đủ của người dùng hoặc dữ liệu SQLite Desktop.
- make doctor vẫn trả lỗi cho ba service đang tắt: flows-api, flows-worker, mcp. Đây không phải lỗi health của sáu ứng dụng vừa restart.

Rollback đã chuẩn bị trước khi thay container:

- Image cũ bị thiếu content/manifest trong cache, nên tag/commit không đủ để tạo rollback.
- Đã export filesystem cả sáu ứng dụng và pg_dump PostgreSQL vào thư mục private /tmp/tina-production-restart-20261030-110510; đã kiểm chứng import lại filesystem Terminal thành local rollback image.
- File rollback-compose.json trong thư mục đó chứa cấu hình nhạy cảm và chỉ dành cho owner; không đưa nội dung vào báo cáo này.
- Chi tiết kiểm chứng được lưu trong verification.json cùng thư mục; không publish image hoặc commit source.

Chưa chạy ASR/meeting/agent end-to-end; các gate TTS/README ngoài phạm vi từ báo cáo make-all vẫn chưa được giải quyết trong thao tác restart này.
