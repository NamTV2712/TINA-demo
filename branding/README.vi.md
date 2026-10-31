<a id="tina-brand-kit"></a>
# Bộ nhận diện thương hiệu Tina

[English](README.md) | [Tiếng Việt](README.vi.md)

Tina là người bạn đồng hành chú tâm trong cuộc họp, thể hiện qua xanh teal dịu,
nền giấy ấm, biểu tượng nét tròn và kiểu chữ Việt/Anh rõ ràng. Người dùng đã
xác nhận tên và hướng màu sắc; logo, kiểu chữ và khẩu hiệu đề xuất là cách
diễn giải thiết kế của bộ nhận diện này.

<a id="open-and-use"></a>
## Mở và sử dụng

Mở trực tiếp [preview.html](preview.html) trong trình duyệt. Giữ nguyên thư
mục: bộ nhận diện hoạt động ngoại tuyến, không cần máy chủ, cài gói hoặc
font bên ngoài. Nút giao diện chuyển sáng/tối; giao diện ban đầu theo hệ thống.
Xem [bảng biểu tượng](icons/preview.html) với mẫu 24px gốc, 48px gấp đôi và
mẫu nghịch đảo.

| Tài sản | Tệp |
|---|---|
| Logo chính, nền sáng | [tina-primary.svg](logos/tina-primary.svg) |
| Logo nghịch đảo, nền tối | [tina-inverse.svg](logos/tina-inverse.svg) |
| Đơn sắc tối / sáng | [tối](logos/tina-mono-dark.svg) / [sáng](logos/tina-mono-light.svg) |
| Dấu hiệu độc lập | [chính](logos/tina-mark.svg) / [nghịch đảo](logos/tina-mark-inverse.svg) |
| Biểu tượng trình duyệt | [favicon.svg](favicon.svg) |
| Màu ngữ nghĩa, kiểu chữ và khoảng cách | [tokens.json](tokens.json) / [tokens.css](tokens.css) |
| Mười hai biểu tượng có thể chỉnh sửa | [icons/](icons/) / [style-spec.json](icons/style-spec.json) |

<a id="logo"></a>
## Logo

Khung hội thoại và chữ T biểu thị lắng nghe, không phải phê duyệt công việc.
Chữ là hình học vector có thể chỉnh sửa, không yêu cầu font cụ thể. Giữ tỷ lệ.
Dùng khoảng trống ít nhất 16px ở chiều cao artboard 112px, co giãn tương ứng.
Kích thước tối thiểu khuyến nghị: logo đầy đủ rộng 104px; dấu hiệu độc lập
rộng 24px. Favicon là ngoại lệ kích thước nhỏ; không dùng toàn bộ wordmark ở
16px. Không kéo méo, viền hóa, xoay, thêm hiệu ứng hoặc đổi màu từng chữ.
Dùng bản chính trên nền sáng, nghịch đảo trên nền tối và đơn sắc khi chỉ cần
một màu mực.

<a id="typography-and-voice"></a>
## Kiểu chữ và giọng văn

UI: Segoe UI, system-ui, sans-serif. Tiêu đề: Georgia, serif.
Đây là chuỗi font cục bộ; không phân phối lại tệp font. Noto Sans / Noto Serif
với tập ký tự tiếng Việt là phương án đa nền tảng tương lai được ghi nhận,
không phải phụ thuộc đóng gói. Nội dung 16px/1.65, nhãn 14px/1.5; chừa chỗ
cho dấu thanh. Giữ tiếng Việt và tiếng Anh dễ đọc như nhau, kể cả khi trộn
ngôn ngữ.

Khẩu hiệu đề xuất: **Lắng nghe rõ. Cùng làm đúng.** /
**Listen clearly. Act together.**

Viết bình tĩnh, chính xác. Dùng “Bản nháp / Draft” và “Chờ xác nhận / Awaiting
confirmation”, không dùng “Done” trước quyết định của con người. Tina đề xuất;
người review phê duyệt một revision trước khi người được giao xác nhận trách
nhiệm. Không ngụ ý phiên âm hoàn hảo hoặc tự động cam kết.

<a id="tokens-and-icons"></a>
## Token và biểu tượng

Nạp `tokens.css`; đặt `data-theme="dark"` trên phần tử gốc để dùng giao diện
tối. Dùng tên ngữ nghĩa như `--ink`, `--surface`, `--brand` thay vì mã màu
cố định. Teal là màu thương hiệu; trạng thái công việc dùng cặp màu chữ/nền
riêng kèm nhãn tường minh. `--line` trang trí không phải ranh giới điều khiển;
dùng `--control-line` cho điều khiển.

Biểu tượng: viewBox 24px, nét 1.5px, đầu nét/mối nối tròn, `currentColor`.
SVG nội tuyến kế thừa màu chữ CSS; SVG nạp qua `<img>` không kế thừa `color`
của phần tử cha. SVG trang trí nội tuyến cần `aria-hidden="true"`; nút chỉ có
biểu tượng cần tên truy cập được trên nút. Không dùng biểu tượng hoặc màu
làm cách giải thích trạng thái công việc duy nhất.

Mọi tệp là tài sản nguồn có thể chỉnh sửa. Bản xem trước minh họa thương hiệu,
không phải ứng dụng cuộc họp hoạt động. Không thêm backend, tài nguyên AWS
hoặc framework ứng dụng.
