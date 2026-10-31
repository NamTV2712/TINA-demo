# Sửa entrypoint `make all` — 2026-10-30

Đã sửa sáu lỗi trong [review](make-all-review-20261030.md). Thay đổi nằm ở orchestration triển khai; không đổi HTTP Window ASR, capture hoặc canonical transcript.

| Lỗi | Cách sửa |
|---|---|
| Project/volume khác `.env` | Compose tự resolve project; network/workspace dùng cùng tên, có kiểm tra binding. |
| Dry-run chạy Docker | Không trộn Docker với recursive Make trong một recipe line. |
| Admin token mẫu cố định | Bootstrap mint token cho cài mới; giữ credential hợp lệ; từ chối placeholder cũ trong entrypoint và hai API. |
| Bot image chưa nội suy | Kiểm tra image từ cấu hình Compose đã resolve. |
| Báo thành công khi chưa ready/cấp key thất bại | Chờ readiness có timeout, kiểm tra service/oneshot, truyền lỗi provisioning lên. |
| Worker build quá muộn | Build bot/services/worker và tải image hạ tầng trước `up --no-build --pull never`. |

`deploy/compose/bin/stack.py` là entrypoint chung cho build, readiness, access, down, status và probe. Không source/eval dotenv. Có guard chống bỏ sót override hoặc service profile đang chạy. Thay đổi cấu hình có chủ đích dùng `ALLOW_CONFIG_CHANGE=1`, không bật mặc định.

`ENV_FILE` chọn cả biến nội suy và env_file của Runtime/Agent API. Profile dotenv được giữ khi inspect build-only; worker build tag theo đúng AGENT_WORKER_IMAGE của Runtime.

## Sử dụng

```bash
make plan      # xem cấu hình đã resolve, không mutation/secret
make build     # source build, không recreate service
make all       # build → start/wait → readiness → cấp access
make doctor    # kiểm tra image/service hiện tại, chỉ đọc
make ps
make logs
make down      # giữ data volumes
```

Source actions mặc định tag dev; shell/Make argument IMAGE_TAG có thể đổi tag. Direct Compose và status giữ tag trong env file. COMPOSE_FILE, COMPOSE_PROFILES, COMPOSE_PATH_SEPARATOR, PROJECT và ENV_FILE được hỗ trợ. Desktop/Capture, extension, ASR/diarization/alignment vẫn là dịch vụ riêng; không tự bật model hoặc thu âm.

## Kiểm chứng

- 40 tests PASS, 1 skip và 2 subtests PASS: entrypoint, probe wiring, flows wiring. Không gọi fixture stack production.
- Make dry-run với Docker giả: all/build/down/bot/doctor không thực thi Docker.
- Compose CLI thật: project dotenv và PROJECT override; profile Dashboard; file override có khoảng trắng; tag nội suy; ENV_FILE khác không đọc credential mặc định.
- Bootstrap file tạm: token riêng biệt, mode 0600, idempotent; giữ credential hợp lệ kể cả giá trị bắt đầu bằng #; từ chối placeholder mà không rotate secret khác.
- Preflight thật của Admin API và Meeting API từ chối placeholder admin.
- Docker thật trên project tạm: up/wait PASS; doctor PASS khi healthy, FAIL có tên Runtime sau khi stop Runtime; chấp nhận one-shot exit 0. Đã dọn project/volume thử nghiệm.
- Graph, dataflow, contract-version PASS; không thay schema. Shell syntax, Python compile và diff whitespace PASS.

Log test: `/tmp/tina-make-fixes-pytest.log`. Log build ban đầu: `/tmp/tina-make-fixes-build.log`; lượt pin context ban đầu: `/tmp/tina-make-fixes-build-context-pinned.log`; lượt thử flag: `/tmp/tina-make-fixes-build-context-final.log`; lượt hoàn tất PASS: `/tmp/tina-make-fixes-build-complete.log`.

## Deployment hiện có

Đã lưu chuỗi Compose thực tế từ label container vào `.env`: project tina-verify-20261015, file gốc và `/tmp/tina-canonical-notes-runtime-override.json`. Giữ toàn bộ byte cũ, chỉ thêm COMPOSE_FILE/comment; không rotate credential. Override vẫn dùng đường dẫn tạm vốn có, cần file đó khi tái triển khai.

Build thật phát hiện thêm builder ở Docker Desktop nhưng daemon kiểm tra ở OrbStack. Entrypoint nay pin DOCKER_CONTEXT và BUILDX_BUILDER cùng daemon, đồng thời truyền global --context flag cho Compose/Buildx trong một lượt chạy, và full build được kiểm chứng trên desktop-linux, nơi stack đang chạy; không đổi global context. Phát hiện tác vụ migration OrbStack riêng đang chạy nên đã bỏ binding desktop-linux cố định vừa thêm vào dotenv, giữ lựa chọn context cho tác vụ migration; cơ chế pin theo mỗi command vẫn giữ nguyên. Có hai regression tests cho context switch và builder mismatch. Compose/Buildx trên máy còn lỗi khi truyền env BUILDX_BUILDER trùng tên context: đã tái hiện bằng scratch build, bỏ env selector sau khi validate và để --context chọn builtin builder; probe nhỏ đã PASS và image probe đã được xóa.

Doctor bắt được image bot, agent-worker, Flows và MCP còn thiếu trên host. Build-only toàn bộ source đã PASS (exit 0), gồm bot, các service, agent-worker và image hạ tầng; image validation đã PASS trong đúng Docker Desktop daemon. Doctor sau khi pin context đã tìm đủ image và báo chính xác flows-api, flows-worker, mcp chưa chạy. Không tự bật thêm các service đó. Không chạy make all trên production vì whole repo còn gate ngoài phạm vi chưa đóng. Khi cần kiểm tra stack hiện ở Docker Desktop trong lúc global context là OrbStack, dùng DOCKER_CONTEXT=desktop-linux make doctor; không đánh đồng hai daemon.

## Giới hạn

- Config-contract còn lỗi có sẵn: TTS_SERVICE_URL/TTS_API_TOKEN được Meeting API dùng nhưng chưa khai báo.
- README gate còn thiếu README ở clients/terminal/src/app/approval-preview/ và core/agent/contracts/tool-approval.v1/golden/.
- Không khẳng định whole repo green hoặc meeting/ASR acceptance hoàn tất.
- Chưa có atomic release switching: runtime cũ có thể dùng image tag vừa build cho lượt spawn tiếp theo. Bước up chỉ chạy khi mọi image cần thiết đã sẵn sàng.
- Một assertion test ban đầu đã in mapping cấu hình chứa credential vào output của phiên làm việc. Đã sửa assertion không dump mapping và sửa ENV_FILE để test không kéo nhầm dotenv mặc định. Credential hiện hữu chưa được rotate.
