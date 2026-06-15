const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
require('dotenv').config();

// Kết nối tới Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Hàm xử lý quét và xóa vĩnh viễn dữ liệu hết hạn
async function cleanExpiredOrders() {
    console.log("=== [ROBOT] Bắt đầu quét đơn hàng hết hạn... ===");
    const now = new Date().toISOString();

    // 1. Tìm các đơn hàng đang ACTIVE nhưng đã quá ngày expires_at
    const { data: expiredOrders, error } = await supabase
        .from('orders')
        .select('id')
        .eq('status', 'ACTIVE')
        .lt('expires_at', now);

    if (error) {
        console.error("Lỗi khi quét đơn hàng:", error.message);
        return;
    }

    if (!expiredOrders || expiredOrders.length === 0) {
        console.log("[ROBOT] Không có đơn hàng nào hết hạn hôm nay.");
        return;
    }

    // 2. Duyệt qua từng đơn hàng hết hạn để tiến hành tự hủy
    for (const order of expiredOrders) {
        console.log(`[ROBOT] Tiến hành hủy đơn hàng: ${order.id}`);

        // Lấy danh sách tên file ảnh của đơn hàng này
        const { data: memories } = await supabase
            .from('memories')
            .select('image_path')
            .eq('order_id', order.id);

        if (memories && memories.length > 0) {
            const filePaths = memories.map(m => m.image_path);

            // XÓA VĨNH VIỄN file ảnh trong Kho lưu trữ bí mật (Storage Bucket)
            const { error: storageError } = await supabase.storage
                .from('photos')
                .remove(filePaths);

            if (storageError) {
                console.error(`Lỗi xóa ảnh của đơn ${order.id}:`, storageError.message);
            } else {
                console.log(` -> Đã xóa tận gốc ${filePaths.length} file ảnh trên kho lưu trữ.`);
            }
        }

        // 3. XÓA VĨNH VIỄN lời nhắn trong bảng memories (Hard Delete dữ liệu chữ)
        await supabase.from('memories').delete().eq('order_id', order.id);

        // 4. Cập nhật trạng thái đơn hàng thành DELETED để lưu lịch sử đơn hàng (chỉ giữ lại email_a để đối soát kế toán)
        await supabase.from('orders')
            .update({ status: 'DELETED' })
            .eq('id', order.id);

        console.log(` -> Đã xóa sạch lời nhắn. Đổi trạng thái đơn ${order.id} sang DELETED.`);
    }
    console.log("=== [ROBOT] Hoàn thành ca quét dọn vĩnh viễn! ===");
}

// Thiết lập lịch trình: Đúng 00:00 (nửa đêm) mỗi ngày con robot này sẽ tự thức dậy chạy
cron.schedule('0 0 * * *', () => {
    cleanExpiredOrders();
});

// Xuất hàm này ra để nhúng vào server chính
module.exports = { cleanExpiredOrders };