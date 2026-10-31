# Sửa vòng đời /routine

Ngày: 29/10/2026. Đã cập nhật Runtime, Agent API và Terminal của stack cục bộ `tina-verify-20261015`.

## Sáu lỗi đã xử lý

1. **Symlink vượt workspace:** đọc file và các thành phần thư mục bằng descriptor với `O_NOFOLLOW`; liệt kê bỏ qua symlink. File/thư mục routine không còn là đường tắt để đọc hoặc sửa routine của owner khác. Ghi file bằng atomic replacement, không ghi xuyên liên kết. README hướng dẫn không được coi là routine.
2. **Workspace gắn thêm bị bỏ qua:** listing, mutation và reconcile cùng dùng các private mount đang active. ID gồm owner/workspace/file; hai file cùng tên ở hai workspace không đè nhau. Scheduled invocation giữ source-workspace reference; worker dùng CWD của source, và từ chối khi workspace không còn được mount. Shared workspace không tự cấp quyền chạy lịch.
3. **Xóa rồi chạy lại:** Delete xóa file nguồn trước, sau đó reconcile để hủy các job tương ứng. File đã disabled vẫn xóa được. Mutation/reconcile được serialize theo owner để tránh thread nền khôi phục job từ snapshot trước Delete. Nguồn SHA bảo vệ thao tác từ card cũ.
4. **Sai múi giờ:** file/routine/schedule có IANA timezone; lệnh tạo routine mới đưa múi giờ browser vào yêu cầu authoring. Legacy không khai báo timezone giữ UTC. UI hiển thị zone và next-run. Cron dùng local wall time; không bắt model tự dịch giờ sang UTC. Spring-DST slot không tồn tại được bỏ qua; fall-DST slot mơ hồ chạy một lần ở fold đầu.
5. **Edit không lưu:** card có Save/Cancel, sửa display name/cron/timezone/prompt thật qua PATCH và expected source SHA. Display name không đổi filename hoặc ID. Client chỉ gửi editable fields, tránh lỗi 422 khi gửi cả card. Conflict giữ draft; các nút dùng stable ID, không dùng tên hiển thị.
6. **Hủy khi dispatch vẫn rearm:** Redis transaction bảo vệ claim và completion/retry/next-cron cùng cancellation tombstone. Cancel xử lý executing job; completion không tạo retry/recurrence nếu đã bị hủy. Nếu snapshot cũ đã completed và successor đã được tạo, cancel theo next-job link. Listing pending/executing cũng lấy snapshot trong transaction để tránh reconcile thấy khoảng trống giả.

Tắt/xóa ngăn các lượt chạy tiếp theo, không hứa giết một agent hoặc HTTP request đã được nhận.

## Bằng chứng

| Phạm vi | Kết quả |
|---|---|
| Agent routine, source safety, API lifecycle và source-workspace binding | 19 passed |
| Runtime toàn bộ suite sau khi bổ sung image fixture alpine cần cho Docker test | 188 passed, 1 skipped |
| Terminal toàn bộ suite cuối | 568 passed, 78 files |
| TypeScript routine changes | PASS |
| routine.v1 và schedule.v1 | 3 goldens mỗi contract, gồm timezone; seal/version gate PASS |
| Graph và isolation | PASS |
| Diff whitespace | PASS |
| Real Redis tích hợp API/TestClient + Scheduler | PASS trong Valkey container tạm riêng, không dùng Redis production |

Real Redis test chứng minh: disable ngay trong dispatch → không retry/next cron; edit và enable lại → 09:00 Việt Nam = 02:00 UTC ở năm 2026; delete và reconcile lại → không file/job. Test đồng hồ tổng hợp có cả DST và legacy UTC.

Smoke trên giao diện Terminal production:

- Tạo một file thử disabled, tên ngẫu nhiên, trong private attached workspace `workspace-1` của owner đang đăng nhập. Listing tìm thấy đúng workspace và stable ID.
- Edit tên thành “Routine verification — Vietnam”, cron thành `15 9 1 1 *`, giữ `Asia/Ho_Chi_Minh`. Save lưu thành công, ID/filename không đổi.
- Enable cho next run **01/01/2027 09:15 Việt Nam**. Lịch đặt xa để không thực thi agent thử.
- Disable rồi Delete qua UI. File biến mất, scheduler về 0 job; reconcile lại vẫn không phục hồi file/job. Toàn bộ source thử đã được dọn, không có thông báo hoặc tác vụ bên ngoài được gửi.
- Source hashes của deployed workspace_routines.py, routines.py, scheduler.py, routines.tsx và routinesApi.ts khớp bản sửa.

## Gate ngoài phạm vi

Whole Agent suite tại thời điểm kiểm tra có **672 passed, 5 failed**; năm lỗi là mock trong `test_workspace_membership.py` chưa nhận tham số `gated_mcp_servers` của nhánh MCP đang sửa, ngoài routine. Sau đó các test routine bổ sung được chạy riêng và pass như bảng trên.

Whole-repo dataflow/README chưa xanh vì `core/agent/contracts/tool-approval.v1` đang có trên đĩa nhưng chưa đăng ký trong architecture và thiếu README ở thư mục golden. Không sửa hoặc xóa phần việc MCP đó để làm gate xanh.

Build Terminal từ toàn checkout cũng gặp caller đang thiếu `searchQuery/speakerFilter` trong phần UI cuộc họp đang sửa. Vì vậy release routine được dựng từ source/image đang chạy, chỉ ghép các phần routine; build này PASS. Agent API được ghép riêng class/routes routine và resolver CWD, không đưa code MCP dang dở vào runtime. Runtime dùng source đang chạy và thay scheduler. Không thay UI cuộc họp trong bản routine này.

## Triển khai

Các image cục bộ đang chạy:

- `tina/v012-runtime:routines-20261029`
- `tina/v012-agent-api:routines-20261029`
- `tina/v012-terminal:routines-20261029`

Overlay tái sử dụng: `deploy/compose/docker-compose.routine-fixes.yml` (thêm sau các compose override của máy). Image chỉ tồn tại cục bộ, không được push lên registry. Docker restart giữ nguyên image đang dùng; khi dựng lại toàn bộ từ checkout, cần đóng các gate MCP/UI ngoài phạm vi kể trên trước.

Trước cập nhật, scheduler không có pending/executing job; routine files trên máy chỉ là các README hướng dẫn. Chỉ recreate ba dịch vụ; PostgreSQL, Valkey, storage, auth/workspace volumes, audio và transcript được giữ nguyên. Không commit/push source checkout.

## Giới hạn

Chưa chạy một routine AI kéo dài nhiều chu kỳ trên dữ liệu thật. Tests/smoke xác nhận quản lý lịch và admission/cancellation, không đo chất lượng model làm công việc trong prompt. Các file routine vẫn là config do agent/người dùng viết; SHA checks bảo vệ UI mutations nhưng không phải transaction phân tán với mọi filesystem writer khác. Không chuyển giờ các routine legacy sang múi giờ mới một cách ngầm định.
