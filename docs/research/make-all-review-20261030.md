# Review `make all` — 2026-10-30

`make all` vẫn là alias `dev` → `deploy/compose dev`. Lệnh dựng và chạy control plane Compose, build bot và agent worker. Nó chưa phải lệnh dựng/kiểm chứng toàn bộ sản phẩm TINA hiện tại. Chưa sửa Makefile hoặc triển khai lại trong review này.

## Các lỗi cần sửa

### F1 — P1: Project mặc định không theo deployment đang dùng

Vị trí: `deploy/compose/Makefile:6–10`, `docker-compose.yml:203,293`.

Makefile đặt `PROJECT ?= tina-v012` rồi luôn truyền `-p $(PROJECT)`. Trong `.env` của máy, `COMPOSE_PROJECT_NAME=tina-verify-20261015`. `-p` ưu tiên hơn `.env`, nên `make all` chọn project khác, còn các giá trị nội suy network/workspace vẫn theo tên trong `.env`.

Đã đối chiếu bằng `docker compose config --format json`, chỉ in các trường vận hành không chứa secret:

- Không truyền PROJECT: volume Postgres sẽ là `tina-v012_postgres-data`, network Compose là `tina-v012_tina`, nhưng `DOCKER_NETWORK` trong Runtime là `tina-verify-20261015_tina`.
- Project đang chạy thật là `tina-verify-20261015`, volume là `tina-verify-20261015_postgres-data`.
- Cả hai cấu hình dùng port Terminal `23000`, vì cùng đọc `.env`.

Hậu quả: dựng nhầm stack, đụng port, nhìn thấy DB mới thay vì dữ liệu cũ, hoặc bot/worker nối sai network/workspace. Không phải xóa DB cũ, nhưng không phải cập nhật đúng deployment.

Cần một nguồn project duy nhất cho Compose, Runtime, volume và các thao tác `all/down/logs/probe`. Chặn triển khai nếu project không khớp deployment đã chọn. Cũng cần hỗ trợ danh sách override rõ ràng: Makefile hiện chỉ truyền `-f docker-compose.yml`, trong khi deployment đang chạy còn dùng hai override cục bộ. Không tự áp overlay routine vào mọi build: overlay đó là snapshot tạm, cần chọn chế độ source build hay giữ release đã triển khai một cách rõ ràng.

### F2 — P1: `make -n all` vẫn thực thi Docker

Vị trí: `deploy/compose/Makefile:71,76–86`.

Dòng `up -d --build` có `$(MAKE)` trong error handler. Khối shell tiếp theo cũng chứa `$(MAKE)`. Make coi cả recipe line là recursive, nên vẫn chạy line đó khi có `-n`.

Đã tái hiện bằng Makefile copy và Docker/submake giả trong thư mục tạm. Trace ghi nhận `up -d --build` và `build agent-worker` thực sự được gọi khi chạy `make -n dev`.

Trong lần kiểm tra ban đầu, bẫy này cũng kích hoạt Docker build thật. Đã ngắt ngay ở giai đoạn build. Kiểm tra sau đó: không có project/container mới, không recreate/restart container đang chạy, không xóa volume; build cache/image tag `tina/v012-flows:dev` đã được cập nhật từ các layer cache. Không dùng lại dry-run trực tiếp trước khi sửa lỗi này.

Cần tách các recipe có Docker mutation khỏi recipe chứa recursive Make, hoặc đưa orchestration vào script và cung cấp lệnh plan chỉ đọc.

### F3 — P1: Bootstrap giữ admin token mẫu cố định

Vị trí: `deploy/compose/.env.example:63–74`, `mint-dev-env.sh:12–23`; `core/identity/services/admin-api/src/admin_api/config.v1.json:20–35`.

Script mint ba secret nội bộ nhưng bỏ qua `ADMIN_TOKEN`. Template có token mẫu cố định; danh sách `forbidden_values` hiện không chặn literal đó. Token này xác thực admin API và ký MeetingToken.

Đã chạy script với `.env` mới trong thư mục tạm: internal secret được mint, admin token vẫn trùng template và không nằm trong danh sách bị từ chối. Không đọc/in token thật của deployment và không thay credential hiện tại.

Cần mint admin token cho cài mới, từ chối placeholder đã công khai, giữ nguyên secret hợp lệ trên cài đặt cũ. Nếu thay secret hiện hữu phải là migration có chủ đích vì ảnh hưởng chữ ký/token đang dùng.

### F4 — P2: Kiểm tra bot image đọc biến chưa nội suy

Vị trí: `deploy/compose/Makefile:140–153`, `.env.example:33,43`.

`_bot_check` lấy `BROWSER_IMAGE` bằng grep, nên nhận chuỗi `tina/tina-bot:${IMAGE_TAG}` từ template. Docker Compose nội suy được chuỗi đó; `docker image inspect` của shell check thì không. Kiểm tra không dùng cùng cấu hình đã resolve với bước build/up.

Đã tái hiện bằng Docker giả: image `tina/tina-bot:dev` có sẵn, `IMAGE_TAG=dev`, nhưng `_bot_check BOT_CHECK_STRICT=1` vẫn thất bại vì inspect literal `${IMAGE_TAG}`.

Cần lấy image từ cấu hình Compose đã resolve với cùng project, env file, override và image tag. Không dùng `eval` để đọc `.env`.

### F5 — P2: Kết quả thành công chưa chứng minh readiness

Vị trí: `deploy/compose/Makefile:71,76–86,230–254`.

`up -d --build` không có `--wait`. `depends_on: service_healthy` chỉ bảo đảm thứ tự khởi động phụ thuộc, không đợi tất cả service cuối cùng sẵn sàng. `_access` chỉ thử admin API, rồi vẫn in `TINA is up` và exit 0 khi không cấp được API key. Khối orchestration cũng không ghi lỗi `_access` vào biến `fail`.

Hai phép tái hiện cô lập:

- Provision-token giả luôn thất bại: `_access` trả 0 và in `TINA is up`.
- Submake `_access` trả 9: target `dev` vẫn trả 0 khi hai kiểm tra image/build khác thành công.

Cần readiness có timeout cho mọi service đã chọn; lỗi bước bắt buộc phải được truyền lên. Báo capability ASR/model thiếu là trạng thái riêng, không khẳng định có transcript/chat chỉ vì HTTP health trả 200. Không tự chạy meeting probe có tác dụng phụ khi người dùng chỉ yêu cầu review.

### F6 — P2: Agent worker được build sau khi Runtime nhận việc

Vị trí: `deploy/compose/Makefile:70–77`; `docker-compose.yml:225–234`.

Worker thuộc profile `build-only`, không được build bởi `up` mặc định. Runtime/Agent API được bật trước, worker mới build sau. Trên cài mới, request có thể spawn khi image chưa tồn tại; trên upgrade, routine khôi phục hoặc người dùng có thể chạy worker tag cũ trong khoảng build. Build thất bại để lại control plane mới cùng worker cũ/thiếu.

Cần build và kiểm tra bot/worker cùng các image service trước bước kích hoạt deployment. Không triển khai/khởi động scheduler trước khi đủ image bắt buộc. Đây là nhận xét từ thứ tự recipe, chưa thực hiện fault injection vào scheduler production.

## Phạm vi hiện có và phần chưa được orchestration

| Thành phần | `make all` hiện tại |
|---|---|
| PostgreSQL, Valkey, object storage và storage-init | Có |
| Admin API, Runtime, Meeting API, Gateway, Agent API | Có |
| Flows API/worker, MCP, Terminal | Có |
| Meeting bot image | Build riêng trước `up` |
| Agent worker image | Build riêng sau `up` |
| Dashboard | Profile `dashboard`; không có trong cấu hình mặc định đã resolve trên máy |
| Discord, mailbox | Profile tùy chọn; cần cấu hình riêng |
| Host Desktop, SQLite/audio local | Không build/start/restart |
| TINA Capture native và AEC | Không build/cài/chạy |
| Browser extension | Không build/cập nhật |
| FunASR/Qwen, Sherpa, Gipformer, MLX | Không start; chỉ tham chiếu endpoint đã cấu hình |
| Diarization, MFA alignment worker | Không start; chỉ truyền URL/token nếu có |
| Test/gates/meeting acceptance | Không chạy |

ASR và native capture nằm ngoài Compose là lựa chọn hợp lệ, nhất là Metal trên macOS. Cần ghi rõ và có target theo môi trường thay vì ép mọi worker/model chạy cùng lúc. Gợi ý phân biệt `plan`, `build`, `up`, `doctor`, `verify`, và target host/Desktop tùy chọn. Dashboard nên có lựa chọn profile được lưu rõ cho deployment đang sử dụng nó.

Thông báo `_creds_check` cũng đã cũ: chỉ xem credential trong `.env`, chưa đọc lựa chọn STT/model và ChatGPT subscription theo user. README nói bot vẫn record khi thiếu STT, trong khi cấu hình `TRANSCRIBE_ENABLED=true` có thể làm default bot request bị từ chối nếu không có backend. Nên báo capability dựa trên cấu hình hiệu lực, không chỉ grep.

## Kiểm chứng và giới hạn

- Compose config: hợp lệ, xác nhận project/volume/network mismatch và danh sách profile mặc định.
- Harness cô lập: tái hiện F2, F3, F4 và hai nhánh F5; không dùng DB thật.
- `gate:graph`: PASS.
- `gate:dataflow`: PASS, 127 nodes / 109 edges / 14 carriers; còn advisory về shared writer/attribution.
- `gate:readme`: FAIL ở `clients/terminal/src/app/approval-preview/` và `core/agent/contracts/tool-approval.v1/golden/`.
- Typecheck Terminal bình thường gặp generated `.next/types` còn tham chiếu route approval-preview đã không tồn tại. Kiểm tra source bằng config tạm loại `.next/types` đã PASS ở lần cuối. Source được sửa đồng thời trong phiên review; lần trước có lỗi export tạm thời rồi biến mất. Không kết luận production build đang hỏng dựa trên cache `.next`.
- Không hoàn tất full Docker build, không chạy full repo tests, không chạy meeting bot hoặc audio acceptance.
- Container production được đọc trạng thái lại và vẫn healthy ở các service đã kiểm tra; không recreate service hay thay dữ liệu meeting trong review.

Ưu tiên sửa: project/override → bootstrap secret và dry-run safety → build trước activation → image checks/readiness → target host và capability status. Sau đó mới chạy build/acceptance trên project cô lập trước khi cập nhật deployment đang dùng.
