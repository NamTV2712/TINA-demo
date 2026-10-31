# TINA production trên OrbStack — 2026-10-30

Đã chuyển stack đang chạy từ Docker Desktop sang OrbStack. Thời gian từ lúc bắt đầu dừng nguồn đến lúc đích healthy và đối chiếu DB: 34,48 giây.

| Cấu hình | Nguồn dự phòng | Production hiện tại |
|---|---|---|
| Docker context | desktop-linux | orbstack |
| Compose project | tina-verify-20261015 | tina-production |
| Trạng thái | Container dừng, giữ dữ liệu | 9 service healthy |
| Compose files | base + override cũ trong /tmp | base + docker-compose.orbstack.yml |

`.env` đã chọn DOCKER_CONTEXT=orbstack, COMPOSE_PROJECT_NAME=tina-production và chuỗi Compose mới nằm trong repository. Credential, các port và endpoint host được giữ nguyên. Không dùng lại hai volume cùng tên project cũ vốn có trên OrbStack; chúng vẫn được giữ riêng.

## Dữ liệu và image

- Copy 13 image, đối chiếu image ID giữa hai daemon: khớp.
- Dừng writer ứng dụng rồi shutdown PostgreSQL/Redis/storage trước khi export.
- Copy 5 volume sang tên tina-production_*; kiểm tra hash của nội dung, path, mode, owner, symlink và xattr trước khi khởi động.
- postgres-data: 1.329 file, 48.806.214 byte; redis-data: 4 file, 127.809 byte; storage-data: 2 file, 21 byte và 2 xattr. Workspace/auth của stack nguồn đều không có file.
- PostgreSQL giữ system_identifier và số bản ghi: meetings=0, transcriptions=0, users=0. Đây là trạng thái của stack nguồn được chuyển; không xác nhận dữ liệu lịch sử từng báo cáo nằm trong stack này. SQLite/audio Desktop trên Mac không thuộc migration này và không bị sửa.
- Imported volumes được khai báo external để Compose không xóa chúng khi down -v. Không chạy cleanup nguồn.

Backup riêng tư: `/Users/jky/Library/Application Support/TINA/backups/orbstack-20261030-111514/`. Thư mục có mode 0700, chứa source.env, target.env, image archive, volume archives, manifests, số liệu DB và evidence. Các env có secret, không đưa vào Git hoặc chia sẻ. Bản dự phòng nguồn không đồng bộ các thay đổi mới sau cutover: rollback sau khi có dữ liệu mới cần copy ngược sau khi dừng writers.

## Kiểm chứng

- make plan: project/context/volume đều trỏ tina-production trên OrbStack.
- make doctor: PASS cho toàn bộ assembly đã chọn.
- Terminal :23000 trả HTML TINA; Gateway :28056, Agent API :28100, Meeting API :28080, Admin API :28057, Runtime :28090 đều trả HTTP 200.
- 9 container healthy; không thấy startup traceback trong 100 log lines cuối của mỗi container.
- Runtime gọi /info qua Docker socket bên trong container và nhận đúng ID daemon OrbStack.
- Từ container OrbStack, host.docker.internal kết nối được các port host 9099, 8057, 18014, 18015.
- Nguồn Docker Desktop không còn container TINA đang chạy. Migration-agent riêng vẫn giữ nguyên; Docker Desktop app chưa được quit.

## Sử dụng

```bash
cd /Users/jky/orca/pre-TINA/TINA
make plan
make doctor
make ps
make logs
```

TINA Terminal: http://127.0.0.1:23000/. `make all` sẽ build/cập nhật trên OrbStack theo `.env`. Native Capture/Desktop và ASR chạy trên host như trước; Settings chọn backend không khởi động backend.

Overlay giữ Flows API/worker và MCP dưới profile automation để khớp assembly nguồn; Discord tắt. Chỉ bật COMPOSE_PROFILES=automation sau khi cấu hình và kiểm chứng các thành phần đó. Dashboard vẫn là profile dashboard như cấu hình base.

Chưa chạy cuộc họp/ASR/agent end-to-end sau migration; healthcheck và kiểm tra dữ liệu không thay thế acceptance. Không xóa container/volume Docker Desktop hoặc hai volume OrbStack cũ, không đổi memory, không publish hoặc commit.
