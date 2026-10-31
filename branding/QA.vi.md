<a id="tina-kit-verification"></a>
# Kiểm chứng bộ nhận diện Tina

[English](QA.md) | [Tiếng Việt](QA.vi.md)

Đã kiểm tra cục bộ ngày 2026-09-28 bằng Chromium qua Omowright và kernel
JavaScript thường trú. Các kiểm tra bao phủ tài sản thương hiệu, không phải
chức năng sản phẩm.

<a id="structural-checks"></a>
## Kiểm tra cấu trúc

- Cả 19 tệp SVG được phân tích bằng bộ phân tích XML của trình duyệt không lỗi:
  sáu biến thể logo, favicon và mười hai biểu tượng.
- Mười hai biểu tượng có viewBox 24px, nét currentColor, độ rộng 1.5px và đầu
  nét/mối nối tròn như tài liệu. Hình học và thuộc tính khớp bảng nội tuyến.
  So sánh chuỗi XML/HTML thô ban đầu thất bại vì cách tuần tự hóa khác nhau;
  so sánh phần tử/thuộc tính chuẩn hóa đạt cho cả mười hai.
- Cả hai giao diện ngữ nghĩa và nhóm font/kiểu chữ/khoảng cách/bo góc khớp giữa
  JSON và CSS. CSS được phân tích qua CSSStyleSheet; JSON qua JSON.parse.
- Cả 21 tham chiếu tài sản/liên kết không phải anchor trong bản xem trước
  chính đều phân giải được cục bộ.
- Bảng biểu tượng có 36 mẫu: mười hai ở 24px, 48px và nghịch đảo 48px.

<a id="contrast"></a>
## Độ tương phản

28 tổ hợp chữ/nền đạt mục tiêu tương phản WCAG: văn bản thường >=4.5:1 và
điều khiển/focus >=3:1. Bao gồm ink/muted trên canvas/surface, muted trên
subtle, nhãn primary thường/hover, cả bốn cặp trạng thái, viền điều khiển trên
surface và focus trên canvas/surface trong cả hai giao diện.

- Tỷ lệ văn bản thấp nhất đã kiểm tra: 5.21:1 (muted sáng trên subtle).
- Tỷ lệ điều khiển thấp nhất đã kiểm tra: 3.65:1 (control-line sáng trên surface).
- Đường phân cách trang trí được chủ ý loại khỏi tiêu chí điều khiển.

<a id="browser-checks"></a>
## Kiểm tra trình duyệt

- Xem bảng chính ở desktop 1440px và giả lập iPhone 14, 390px.
- Kiểm tra ảnh sáng/tối, gồm dấu tiếng Việt, mọi mục, thẻ công việc/footer
  mobile và bảng logo sáng cố định trong chế độ tối.
- Không tràn ngang ở cả hai chiều rộng đã thử. Mọi ảnh bảng chính tải được.
- Nút chuyển giao diện bằng chuột cập nhật giao diện và aria-pressed; Enter
  chuyển sáng sang tối.
- Tab đầu tiên đến liên kết bỏ qua với viền focus liền rõ ràng.
- Bảng biểu tượng ở 390px không tràn ngang; đã kiểm tra trực quan mẫu desktop
  24px/48px/nghịch đảo.
- Logo đơn sắc hiển thị sau khi chuyển chữ T thành vùng cắt mask trong suốt.
- Một ảnh chụp gặp trạng thái vẽ chưa hoàn chỉnh; chờ giải mã ảnh và khung
  hoạt ảnh cho bảng hoàn chỉnh. Không cần thay đổi ứng dụng.

<a id="limits-and-reproduction"></a>
## Giới hạn và tái hiện

Mở trực tiếp `preview.html` và `icons/preview.html`; lặp lại kiểm tra viewport,
giao diện, bàn phím và tài sản nêu trên. Không cần máy chủ hoặc cài đặt.
Ảnh được kiểm tra trong phiên làm việc, không phát hành thành tài sản bổ sung.

Không thể chạy chẩn đoán Biome vì thiếu tệp thực thi đã cấu hình. Không có
framework, pipeline build hoặc bộ kiểm thử ứng dụng; không cài những phần đó
cho bộ tĩnh này. Kiểm tra trình duyệt/bộ phân tích/độ tương phản là các kiểm
tra phù hợp ở đây. `git diff --check` kết thúc thành công, nhưng mọi tệp dự
án khi đó chưa được theo dõi, nên lệnh một mình không bao phủ tài sản mới.
Không thực hiện kiểm tra AWS, triển khai, lượt gọi API trả phí hoặc commit kho mã.
