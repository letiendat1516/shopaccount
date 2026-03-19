# VietQR Payment Integration - Hướng Dẫn Cấu Hình

## 📋 Tổng Quan

VietQR là một phương thức thanh toán phổ biến ở Việt Nam sử dụng mã QR ngân hàng theo chuẩn NAPAS. Tích hợp này cho phép khách hàng thanh toán bằng cách quét mã QR trên điện thoại.

## ✅ Yêu Cầu Cài Đặt

### 1. **Dependencies (Đã cài sẵn)**
```bash
npm install qrcode axios
```

### 2. **Files Đã Thêm**
- `/utils/vietqr.js` - Module xử lý VietQR
- `/views/checkout-vietqr.ejs` - Trang thanh toán VietQR
- Routes trong `app.js`:
  - `POST /checkout/vietqr` - Khởi tạo thanh toán
  - `GET /checkout/vietqr/verify/:snapshotId` - Xác minh thanh toán
  - `POST /checkout/vietqr/webhook` - Webhook handler

## 🔧 Cấu Hình VietQR

### Bước 1: Cấu Hình Thông Tin Tài Khoản Ngân Hàng

Thêm vào `settingsModel.js` hoặc cấu hình qua Staff Panel:

```javascript
settings.paymentMethods = {
  // ... other payment methods
  vietqr: {
    enabled: true,
    bankCode: "970436", // Mã ngân hàng (VietcomBank = 970436)
    accountNumber: "0123456789", // Số tài khoản
    accountName: "COMPANY NAME",  // Tên chủ tài khoản
    accountType: 0 // 0 = Tài khoản thường, 1 = Tài khoản kinh doanh
  }
};
```

### Bước 2: Mã Ngân Hàng Phổ Biến

| Tên Ngân Hàng | Mã Ngân Hàng |
|---|---|
| Vietcombank | 970436 |
| BIDV | 970418 |
| Techcombank | 970407 |
| VietinBank | 970405 |
| ACB | 970416 |
| MB Bank | 970422 |
| TPBank | 970423 |
| SHB | 970443 |
| Agribank | 970405 |
| DongA Bank | 970406 |
| HDBank | 970441 |

**Lưu ý:** Kiểm tra mã ngân hàng tại https://api.vietqr.io/ hoặc trong tài liệu ngân hàng của bạn

### Bước 3: Cấu Hình Thông Qua Staff Panel (Khuyến Nghị)

1. Đăng nhập vào **Staff Panel**
2. Đi tới **Settings > Payment Methods**
3. Tìm phần **VietQR**
4. Nhập các thông tin:
   - **Enable VietQR**: Bật/Tắt
   - **Bank Code**: Mã ngân hàng
   - **Account Number**: Số tài khoản (không dấu cách)
   - **Account Name**: Tên chủ tài khoản (viết hoa)
5. **Lưu** cấu hình

## 🎯 Cách Thức Hoạt Động

### Quy Trình Thanh Toán

```
1. Khách hàng thêm sản phẩm vào giỏ
   ↓
2. Nhấn nút "Checkout with VietQR"
   ↓
3. Hệ thống tạo mã QR từ VietQR API
   ↓
4. Hiển thị mã QR + Thông tin thanh toán
   ↓
5. Khách hàng quét mã = chuyển khoản qua app ngân hàng
   ↓
6. Hệ thống kiểm tra trạng thái thanh toán (polling)
   ↓
7. Khi xác nhận → Tạo invoice + Cấp quyền sản phẩm
```

### Thông Tin Hiển Thị Trên Giao Diện

- **Số tài khoản**: Có nút Copy
- **Tên chủ tài khoản**
- **Số tiền cần thanh toán**: Tính từ giỏ hàng + tax + discount
- **Mã tham chiếu**: ID snapshot (8 ký tự đầu)
- **Mã QR**: Được tạo từ VietQR API

## 📱 Hỗ Trợ Ngân Hàng

VietQR hoạt động với tất cả các ngân hàng Việt Nam hỗ trợ chuẩn NAPAS:

✅ **Hỗ Trợ QR:**
- Vietcombank, BIDV, Techcombank, VietinBank
- ACB, MB Bank, TPBank, SHB
- Agribank, DongA Bank, HDBank
- Và các ngân hàng khác

✅ **Các ứng dụng hỗ trợ quét:**
- Ứng dụng ngân hàng (Vietcombank, BIDV, etc.)
- Ứng dụng ví điện tử (Momo, ZaloPay, etc.)
- Google Pay, Apple Pay
- Bất kỳ ứng dụng quét QR nào

## 🔐 Bảo Mật & Lưu Ý

### ✅ Điểm Mạnh
- Không cần API key phức tạp
- Khách hàng quán lý chính quyền
- Dễ dàng xác minh (khi có webhook từ ngân hàng)
- Chi phí thấp (gần như miễn phí)

### ⚠️ Hạn Chế
- **Xác minh thủ công:** VietQR không cung cấp webhook trực tiếp
- **Giải pháp hiện tại:** Polling (kiểm tra mỗi 1 giây) trong 5 phút
- **Nâng cao:** Tích hợp với Ngân hàng API hoặc Accounting Software

## 💡 Tích Hợp Webhook (Nâng Cao)

Để tự động xác nhận thanh toán, bạn cần tích hợp với:

1. **Ngân Hàng API** (ví dụ: Vietcombank Connect, BIDV API)
2. **Accounting Software** (như Zapy, iKomerce, etc.)
3. **Third-party Service** (như VietQR premium, Paysera)

### Ví Dụ Webhook Handler

```javascript
app.post('/checkout/vietqr/webhook', express.json(), async (req, res) => {
  try {
    // Xác minh từ ngân hàng hoặc dịch vụ thứ ba
    const { snapshotId, transactionId, amount, status } = req.body;
    
    if (status === 'success') {
      const cartSnapshot = await CartSnapshot.findById(snapshotId);
      
      // Xác minh số tiền
      if (Math.abs(parseFloat(amount) - cartSnapshot.total) < 0.01) {
        cartSnapshot.status = 'processed';
        cartSnapshot.processedAt = new Date();
        await cartSnapshot.save();
        
        // Xử lý thanh toán như PayPal/Stripe
      }
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ success: false });
  }
});
```

## 🔄 Các Trạng Thái Thanh Toán

| Trạng Thái | Mô Tả |
|---|---|
| `pending` | Chờ thanh toán |
| `processing` | Đang xử lý |
| `processed` | Hoàn tất |
| `failed` | Thất bại |
| `cancelled` | Bị hủy |

## 📊 Theo Dõi & Lưu Logs

Tất cả các giao dịch VietQR được lưu trong:

1. **Database:** `cartSnapshots` collection
   - `status`: Trạng thái thanh toán
   - `items`: Các sản phẩm
   - `bundles`: Các gói
   - `total`: Tổng tiền
   - `ipAddress` & `userAgent`: Thông tin khách

2. **Logs File:** `logs.txt`
   - Tất cả lỗi xử lý

3. **Discord Log:** (Nếu cấu hình)
   - Thông báo thanh toán thành công

## 🛠️ Troubleshooting

### Vấn đề 1: Mã QR không hiển thị
**Giải pháp:**
- Kiểm tra `bankCode` & `accountNumber` có chính xác không
- Thử tạo QR thủ công qua VietQR demo: https://qr.napas.com.vn/

### Vấn đề 2: Không thể quét mã QR
**Giải pháp:**
- Tăng kích thước mã QR trong `checkout-vietqr.ejs`
- Kiểm tra kết nối internet
- Thử dùng ứng dụng quét khác

### Vấn đề 3: Thanh toán không được xác nhận
**Giải pháp:**
- Kiểm tra polling đang chạy không (`checkPaymentStatus()`)
- Xác minh thủ công trong admin panel
- Tích hợp webhook từ ngân hàng

### Vấn đề 4: Mã tham chiếu không khớp
**Giải pháp:**
- Đảm bảo số tài khoản đúng
- Kiểm tra số tiền (cộng thêm tax nếu có)
- Xóa cache, tải lại trang

## 📞 Hỗ Trợ & Liên Hệ

- **VietQR API Docs:** https://api.vietqr.io/
- **Plex Development Discord:** https://discord.gg/plexdev
- **Documentation:** https://docs.plexdevelopment.net/

## 📝 Changelog

### v1.0 (2026-03-19)
- ✅ Tích hợp VietQR cơ bản
- ✅ Tạo mã QR từ VietQR API
- ✅ Giao diện thanh toán
- ✅ Polling xác minh (5 phút)
- ⏳ Webhook tích hợp (phiên bản tiếp theo)

---

**Chúc bạn triển khai thành công! 🎉**

