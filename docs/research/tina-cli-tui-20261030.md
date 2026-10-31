# TINA CLI/TUI local — 2026-10-30

Đã cài `tina` vào `~/.local/bin/tina` bằng symlink tới `deploy/compose/bin/tina.py` của checkout này. Chạy từ thư mục bất kỳ; không tạo credential/profile store mới, không publish hoặc commit.

## Phạm vi bản đầu

- `tina` mở TUI khi stdin/stdout là TTY; không TTY thì trả trạng thái JSON, không chờ nhập.
- Các lệnh: status, doctor, plan, build, deploy, up, restart [service], down, logs [service], open terminal/dashboard, tui.
- TUI dùng arrow/j/k, Enter, refresh r, Esc/q; chọn service cho logs/restart. TUI gọi cùng dispatcher CLI.
- CLI/TUI tái sử dụng Stack, plan_data, build, activate, image checks, readiness và guard hiện có trong stack.py. Make vẫn dùng entrypoint cũ, cùng lớp xử lý. Không thêm dependency Python.
- Đọc deployment hiện tại từ .env/Compose: OrbStack, tina-production, external data volumes. Không đổi cấu hình production trong task này.

```bash
tina
tina status
tina doctor --json
tina plan
tina deploy --dry-run
tina logs runtime --tail 50
tina logs runtime --follow
tina restart terminal --dry-run
tina open terminal
```

Các mutation cần `--yes` hoặc xác nhận trong TTY. TUI hiển thị context/project và tác động trước thao tác. Không có xóa volume trong CLI. Build cập nhật image tag, up dùng image có sẵn và có thể recreate khi tag/config đổi, restart chỉ restart container có sẵn và giữ image/container ID, deploy build rồi activate và verify access như make all.

## Output

- Terminal: bảng trạng thái hoặc nội dung đọc được; pipe/--json: một JSON envelope với ok, data/error, meta.schema_version=1 và cli_version=0.1.0.
- Build/progress/follow logs đi vào stderr; stdout dành cho kết quả cuối.
- Redact known configured secrets, credential fields, Authorization headers và URL credential. Không bảo đảm mọi chuỗi bí mật không có nhãn trong app logs đều nhận diện được; cần xem lại trước khi chia sẻ.
- Exit code: 0 thành công, 1 lỗi thực thi/readiness, 2 lỗi input/xác nhận/TTY, 130 hủy.
- Deploy vẫn tạo scoped API key để verify access như make all, nhưng không in key; không đánh dấu mutation là tự động retryable. Các lệnh đọc không mint key.

## Kiểm chứng

- `uv run --project deploy/compose/tests pytest ...`: 60 tests PASS, 1 skip, 7 subtests PASS. Gồm entrypoint cũ, CLI/TUI mới, probe/flows wiring.
- Test CLI: dry-run mọi mutation không bootstrap/build/up/down/open; invalid service không thể trở thành Compose flag; non-TTY không chờ confirmation; từ chối restart container thiếu; không implicit up; JSON/error envelope; không cấp key ở lệnh đọc; known secrets bị redact kể cả split output.
- Installer idempotent, giữ nguyên executable khác và chạy được symlink ngoài repo.
- Installed CLI real Docker trên project tina-cli-check-* riêng: deploy dry-run không tạo container; up/doctor/status/logs/restart/down PASS. Restart giữ container ID/image, đổi StartedAt của service chọn, không đổi StartedAt service khác. Down giữ volume; cuối bài dọn volume của project tạm. Container ID production giữ nguyên.
- TUI qua PTY: menu hiển thị orbstack/tina-production, thao tác status và quay lại menu, quit exit 0; khôi phục terminal modes. Test bỏ qua bit PENDIN tạm thời của kernel macOS, vẫn kiểm tra các thuộc tính terminal còn lại.
- logs --follow stream trước khi process kết thúc; Ctrl-C trả JSON cancelled, exit 130.
- Installed tina doctor --json trên production PASS; 9 long-running service healthy, storage-init exit 0.
- Python compile/diff whitespace PASS; graph/dataflow/contract-version PASS. Description deploy trong CALM cập nhật, seal và views tái tạo.

Evidence cục bộ: /tmp/tina-cli-tests.log, /tmp/tina-cli-isolated-check.log, /tmp/tina-cli-final-doctor.json và /tmp/tina-tui-pty-output.bin. Các harness thực tế ở /tmp/tina-cli-isolated-check.py, /tmp/tina-tui-pty-check.py, /tmp/tina-cli-follow-check.py.

## Giới hạn

- README gate còn hai lỗi có sẵn: clients/terminal/src/app/approval-preview/ và core/agent/contracts/tool-approval.v1/golden/.
- Chưa chạy full repo tests hoặc meeting/audio/agent acceptance; không build/deploy/restart production cho task CLI.
- Desktop/Capture/ASR/diarization/alignment không được quản lý hoặc suy ra trạng thái trong bản này; CLI nêu rõ chưa kiểm tra.
- Chưa có CLI meeting/transcript/routine/backup. TUI chỉ hỗ trợ macOS/Linux terminal có curses; chưa có Windows TUI.
- Ctrl-C của Docker client không hứa rollback mutation đã được daemon nhận; cần xem tina status sau khi hủy.

Hướng dẫn đầy đủ: [deploy/compose/bin/README.md](../../deploy/compose/bin/README.md#local-tina-cli--tui).

## English and TINA green theme — CLI 0.1.1

- All CLI/TUI labels, confirmation prompts, impact descriptions and cancellation messages are now English.
- Added tina_style.py, reading the existing dark palette from branding/tokens.json. Deep green canvas,
  mint brand accent, full-width green selection, separated header/footer and selected-action hints.
- Interactive CLI status tables have colored headings and health indicators; completed one-shot jobs
  are labeled completed. JSON and pipes remain plain; NO_COLOR and limited terminals are supported.
- Programmable curses palettes restore original color entries on exit; fixed 256/8-color terminals
  use approximations and monochrome terminals retain a visible reverse-video selection.
- 66 tests passed, 1 skipped, 9 subtests passed. Installed TUI PTY check verified English labels,
  colored selection, status action, return to menu, quit and terminal mode restoration. Installed
  doctor JSON still passes without ANSI sequences. Evidence: /tmp/tina-cli-theme-tests.log and
  /tmp/tina-tui-pty-output.bin. Production was inspected read-only, with no restart or deployment.
