require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

function generateOrderId() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// Hàm gửi Email báu vật kích hoạt (Tách riêng ra để gọi khi bạn bấm nút duyệt trên Telegram)
async function sendActivationEmail(order, packageName) {
    const customerEmailHtml = `
        <div style="font-family: 'Arial', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #f0d5d7; border-radius: 15px; background-color: #fffafb;">
            <h2 style="color: #be7a81; text-align: center;">🌸 Tiệm Thương Thương 🌸</h2>
            <p>Chào bạn <b>${order.name_a}</b>,</p>
            <p>Tiệm đã nhận được khoản thanh toán kích hoạt từ bạn. Hộp quà kỷ niệm lãng mạn dành tặng cho <b>${order.name_b}</b> đã chính thức mở khóa và niêm phong an toàn vào kho bảo mật Private 100%.</p>
            
            <div style="background-color: #fdf1f2; padding: 15px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #be7a81;">
                <p style="margin: 5px 0;">🔑 <b>Mã Số Quà Tặng (Order ID):</b> <code style="font-size: 14px; background: #fff; padding: 2px 6px; border-radius: 4px;">${order.id}</code></p>
                <p style="margin: 5px 0;">🔒 <b>Mật Khẩu Bảo Mật:</b> <code>${order.password_b}</code></p>
                <p style="margin: 5px 0;">📦 <b>Gói dịch vụ:</b> ${packageName}</p>
            </div>

            <p style="font-size: 12px; color: #8a7375; line-height: 1.6;">
                * <b>Hướng dẫn:</b> Bạn hãy gửi đường link trang chơi game kèm theo mã quà tặng và mật khẩu mật ở trên để người ấy vào lật hình mở khóa thư tình nhé!<br>
                * Vì lý do bảo mật quyền riêng tư tối cao, toàn bộ hình ảnh và thư tay sẽ tự động kích hoạt lệnh tự hủy vĩnh viễn đúng sau ngày hết hạn.
            </p>
            <hr style="border: none; border-top: 1px dashed #f0d5d7; margin: 20px 0;">
            <p style="text-align: center; font-size: 12px; color: #bda2a5;">Cảm ơn bạn đã lựa chọn cất giữ thanh xuân tại Tiệm Thương Thương...</p>
        </div>
    `;

    return transporter.sendMail({
        from: `"Tiệm Thương Thương 🌸" <${process.env.EMAIL_USER}>`,
        to: order.email_a,
        subject: `💌 Hộp quà kỷ niệm của bạn đã được kích hoạt thành công!`,
        html: customerEmailHtml
    });
}


// ========================================================
// 🛠️ HỆ THỐNG API ĐỒNG BỘ 100% QUY TRÌNH DUYỆT ĐƠN BẰNG NÚT BẤM
// ========================================================

// API 1: Khách đặt đơn (Chỉ bắn Telegram báo Admin, CHƯA gửi mail)
app.post('/api/create-order', async (req, res) => {
    try {
        const { email_a, phone_a, name_a, name_b, password_b, package_type, memories } = req.body;
        
        // Ràng buộc số lượng ảnh nghiêm ngặt
        if (package_type === '1_week' && (memories.length < 5 || memories.length > 6)) {
            return res.status(400).json({ success: false, message: "Gói 7 Ngày chỉ hỗ trợ từ 5-6 ảnh thôi nè!" });
        }
        if (package_type === '2_weeks' && (memories.length < 5 || memories.length > 10)) {
            return res.status(400).json({ success: false, message: "Gói 14 Ngày hỗ trợ từ 5-10 ảnh bạn nhé!" });
        }

        const orderId = generateOrderId();
        const daysLeft = package_type === '1_week' ? 7 : 14;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + daysLeft);

        // Lưu đơn với trạng thái mặc định 'pending_payment'
        const { error: orderError } = await supabase.from('orders').insert([{
            id: orderId, email_a, phone_a, name_a, name_b, password_b, package_type, expires_at: expiresAt, status: 'pending_payment'
        }]);
        if (orderError) return res.status(400).json({ success: false, message: orderError.message });

        for (let i = 0; i < memories.length; i++) {
            const item = memories[i];
            const buffer = Buffer.from(item.base64_data.split(',')[1], 'base64');
            const { error: uploadError } = await supabase.storage.from('photos').upload(item.image_path, buffer, { contentType: 'image/jpeg' });
            if (!uploadError) {
                await supabase.from('memories').insert([{
                    order_id: orderId, image_path: item.image_path, message: item.message, offset_x: item.offset_x || 50, offset_y: item.offset_y || 50
                }]);
            }
        }

        const priceText = package_type === '1_week' ? '39,000đ' : '59,000đ';
        const packageName = package_type === '1_week' ? '7 Ngày Ngọt Ngào 🌸' : '14 Ngày Gắn Kết ♾️';

        // 🔥 ĐỘT PHÁ: Gửi Telegram ĐÍNH KÈM NÚT BẤM CÔNG NGHỆ CAO (Inline Keyboard)
        const telegramAdminMsg = `🎁 *[TIỆM THƯƠNG THƯƠNG - ĐƠN HÀNG CHỜ DUYỆT]*\n────────────────────────\n*• Mã đơn:* \`${orderId}\`\n*• Gói chọn:* ${packageName}\n*• Số tiền cần check:* *${priceText}*\n\n*• Cặp đôi:* ${name_b} & ${name_a}\n*• SĐT liên hệ:* \`${phone_a}\`\n────────────────────────\n_Khách đã up xong ảnh và lời nhắn. Tiệm check tài khoản tinh tinh rồi nhấn nút duyệt ở dưới nha!_`;
        
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: telegramAdminMsg,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Xác nhận đã nhận tiền (Kích hoạt đơn)", callback_data: `approve_${orderId}` }
                ]]
            }
        });

        res.json({ success: true, order_id: orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});


// 🔥 API 2: CỬA NGÕ TIẾP NHẬN LỆNH BẤM NÚT TỪ TELEGRAM (WEBHOOK WEB)
app.post('/api/telegram-webhook', async (req, res) => {
    res.sendStatus(200); // Trả lời Telegram ngay lập tức để giữ đường truyền ổn định
    
    const { callback_query } = req.body;
    if (!callback_query) return;

    const actionData = callback_query.data; // Có dạng "approve_xXyZ123"
    const chatId = callback_query.message.chat.id;
    const messageId = callback_query.message.message_id;

    if (actionData.startsWith('approve_')) {
        const orderId = actionData.split('_')[1];

        // 1. Lên database lấy thông tin đơn hàng chờ duyệt ra
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
        
        if (order && order.status === 'pending_payment') {
            // 2. Cập nhật trạng thái đơn hàng sang Active chính thức hoạt động
            await supabase.from('orders').update({ status: 'active' }).eq('id', orderId);

            const packageName = order.package_type === '1_week' ? '7 Ngày Ngọt Ngào 🌸' : '14 Ngày Gắn Kết ♾️';
            
            // 3. CHÍNH THỨC BẮN MAIL KÍCH HOẠT QUÀ TẶNG GỬI CHO KHÁCH
            await sendActivationEmail(order, packageName).catch(err => console.error("Lỗi gửi mail duyệt đơn:", err.message));

            // 4. Ép màn hình Telegram sửa lại nội dung tin nhắn cũ, thông báo Đã duyệt xong xuôi thành công
            const updatedText = `${callback_query.message.text}\n\n🍏 *[HỆ THỐNG]: ĐÃ DUYỆT TIỀN THÀNH CÔNG! Đơn hàng chính thức hoạt động và hệ thống đã tự động bắn Email bàn giao mật mã cho khách hàng.*`;
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageText`, {
                chat_id: chatId, message_id: messageId, text: updatedText, parse_mode: 'Markdown'
            });
        }
    }
});


// API 3: Xác thực vào chơi game (CHỈ CHO PHÉP ĐƠN ĐÃ ĐƯỢC DUYỆT ACTIVE VÀO CHƠI)
app.post('/api/verify-game', async (req, res) => {
    const { order_id, password } = req.body;
    
    const { data: order } = await supabase.from('orders').select('*').eq('id', order_id).single();
    
    // Nếu đơn hàng chưa được duyệt tiền (vẫn ở trạng thái pending_payment) -> Khóa cửa không cho vào game
    if (!order || order.status === 'pending_payment') {
        return res.status(401).json({ success: false, message: "Hộp quà này đang chờ Chủ tiệm kiểm tra giao dịch chuyển khoản và kích hoạt bạn nha!" });
    }
    if (order.password_b !== password) {
        return res.status(401).json({ success: false, message: "Mật khẩu bảo mật không chính xác rồi ạ!" });
    }

    const timeLeft = new Date(order.expires_at) - new Date();
    const daysLeft = Math.max(0, Math.ceil(timeLeft / (1000 * 60 * 60 * 24)));

    const { data: memories } = await supabase.from('memories').select('id, image_path, offset_x, offset_y').eq('order_id', order_id);
    
    const cards = [];
    for (const item of memories) {
        const { data: signedData } = await supabase.storage.from('photos').createSignedUrl(item.image_path, 900);
        cards.push({
            id: item.id, offset_x: item.offset_x, offset_y: item.offset_y,
            image_url: signedData ? signedData.signedUrl : ""
        });
    }

    res.json({ success: true, name_a: order.name_a, name_b: order.name_b, days_left: daysLeft, cards });
});

// (Giữ nguyên đoạn API bốc API Admin Studio và Cron Job quét rà soát PDF lùi lịch 2 ngày phía dưới...)
app.listen(3000, () => console.log('🚀 Bộ não Tiệm Thương Thương tương tác hai chiều vận hành trên cổng 3000...'));
