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
    // 🔗 Tạo đường dẫn riêng biệt, sạch sẽ dạng Clean URL cho từng đơn hàng
    const privateGameUrl = `https://tiemthuongthuong.com/game/${order.id}`; 

    const customerEmailHtml = `
        <div style="font-family: 'Arial', sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #f0d5d7; border-radius: 15px; background-color: #fffafb;">
            <h2 style="color: #be7a81; text-align: center;">🌸 Tiệm Thương Thương 🌸</h2>
            <p>Chào bạn <b>${order.name_a}</b>,</p>
            <p>Khoản thanh toán kích hoạt của bạn đã được duyệt thành công! Hộp quà kỷ niệm lãng mạn dành tặng cho <b>${order.name_b}</b> đã chính thức mở khóa và đưa vào kho lưu trữ bảo mật.</p>
            
            <div style="background-color: #fdf1f2; padding: 15px; border-radius: 10px; margin: 20px 0; border-left: 4px solid #be7a81;">
                <p style="margin: 5px 0;">📦 <b>Gói dịch vụ:</b> ${packageName}</p>
                <p style="margin: 5px 0;">🔑 <b>Mã Số Quà Tặng:</b> <code style="font-size: 14px; background: #fff; padding: 2px 6px; border-radius: 4px;">${order.id}</code></p>
                <p style="margin: 5px 0;">🔒 <b>Mật Khẩu Mở Khóa (Nếu vào từ Trang Chủ):</b> <code>${order.password_b}</code></p>
            </div>

            <p style="margin-bottom: 5px; font-weight: bold; color: #7a5255; font-size: 13px;">🔗 Đường link trang chơi game riêng của hai bạn:</p>
            <div style="background-color: #ffffff; border: 2px dashed #eab3b6; padding: 12px; border-radius: 10px; text-align: center; word-break: break-all; margin-bottom: 10px;">
                <span style="font-family: 'Courier New', monospace; font-size: 15px; font-weight: bold; color: #be7a81; user-select: all;-webkit-user-select: all;">
                    ${privateGameUrl}
                </span>
            </div>
            
            <div style="background-color: #fff9e6; border: 1px solid #ffeaa7; padding: 10px; border-radius: 8px; margin-bottom: 25px;">
                <p style="margin: 0; font-size: 12px; color: #b77c1e; line-height: 1.5; text-align: justify;">
                    ⚠️ <b>Lời nhắc bảo mật từ Tiệm:</b> Đường dẫn phía trên là chiếc chìa khóa duy nhất mở khóa kho tàng thanh xuân của hai bạn. Bạn hãy copy toàn bộ đường link này để gửi tặng người ấy nhé. Vui lòng tự lưu giữ bảo mật, không chia sẻ công khai lên mạng xã hội để bảo vệ vẹn nguyên những kỷ niệm cá nhân thiêng liêng này nha!
                </p>
            </div>

            <p style="font-size: 12px; color: #8a7375; line-height: 1.5;">
                * <b>Cách dùng:</b> Người ấy khi truy cập vào đường link riêng phía trên sẽ thấy Mã số quà tặng đã được hệ thống tự động điền sẵn và niêm phong. Người ấy chỉ cần gõ đúng chính xác <b>Mật Khẩu Bảo Mật</b> ở phía trên là căn phòng kỷ niệm sẽ lập tức mở ra!
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

// API 1: Khách đặt đơn (Đã thêm mắt thần Console Log để debug)
app.post('/api/create-order', async (req, res) => {
    console.log("\n🔔 [LOG] === CÓ YÊU CẦU ĐẶT ĐƠN MỚI CHẠM VÀO SERVER ===");
    try {
        const { email_a, phone_a, name_a, name_b, password_b, package_type, memories } = req.body;
        console.log(`- Thông tin khách: Người gửi: ${name_a}, Người nhận: ${name_b}, SĐT: ${phone_a}`);
        console.log(`- Số lượng ảnh khách gửi lên: ${memories ? memories.length : 0} tấm`);
        
        // Ràng buộc số lượng ảnh nghiêm ngặt
        if (package_type === '1_week' && (memories.length < 5 || memories.length > 6)) {
            console.log("❌ [LOG] Thất bại: Gói 1 tuần sai số lượng ảnh.");
            return res.status(400).json({ success: false, message: "Gói 7 Ngày chỉ hỗ trợ từ 5-6 ảnh thôi nè!" });
        }
        if (package_type === '2_weeks' && (memories.length < 5 || memories.length > 10)) {
            console.log("❌ [LOG] Thất bại: Gói 2 tuần sai số lượng ảnh.");
            return res.status(400).json({ success: false, message: "Gói 14 Ngày hỗ trợ từ 5-10 ảnh bạn nhé!" });
        }

        const orderId = generateOrderId();
        const daysLeft = package_type === '1_week' ? 7 : 14;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + daysLeft);

        console.log(`- Đang tiến hành lưu thông tin đơn hàng vào bảng 'orders' với ID: ${orderId}...`);
        const { error: orderError } = await supabase.from('orders').insert([{
            id: orderId, email_a, phone_a, name_a, name_b, password_b, package_type, expires_at: expiresAt, status: 'pending_payment'
        }]);
        if (orderError) {
            console.error("❌ [LOG LỖI SUPABASE ORDERS]:", orderError.message);
            return res.status(400).json({ success: false, message: orderError.message });
        }
        console.log("✅ [LOG] Lưu bảng 'orders' thành công!");

        console.log("- Bắt đầu vòng lặp xử lý và upload ảnh lên Storage...");
        for (let i = 0; i < memories.length; i++) {
            const item = memories[i];
            const buffer = Buffer.from(item.base64_data.split(',')[1], 'base64');
            
            console.log(`  + Đang upload tấm ảnh thứ ${i + 1}/${memories.length} lên Storage...`);
            const { error: uploadError } = await supabase.storage.from('photos').upload(item.image_path, buffer, { contentType: 'image/jpeg' });
            
            if (uploadError) {
                console.error(`  ❌ [LOG LỖI UPLOAD ẢNH KHÔNG THÀNH CÔNG]: Tấm thứ ${i + 1}:`, uploadError.message);
            } else {
                console.log(`  ✅ Upload ảnh thứ ${i + 1} thành công. Đang lưu vào bảng 'memories'...`);
                await supabase.from('memories').insert([{
                    order_id: orderId, image_path: item.image_path, message: item.message, offset_x: item.offset_x || 50, offset_y: item.offset_y || 50
                }]);
            }
        }
        console.log("✅ [LOG] Xử lý toàn bộ ảnh và lưu bảng 'memories' xong!");

        const priceText = package_type === '1_week' ? '39,000đ' : '59,000đ';
        const packageName = package_type === '1_week' ? '7 Ngày Ngọt Ngào 🌸' : '14 Ngày Gắn Kết ♾️';

        // 🔥 ĐÃ SỬA: Chuyển sang tin nhắn thuần túy, an toàn 100% không sợ vỡ định dạng
        const telegramAdminMsg = `🎁 [TIỆM THƯƠNG THƯƠNG - ĐƠN HÀNG CHỜ DUYỆT]\n------------------------\n• Mã đơn: ${orderId}\n• Gói chọn: ${packageName}\n• Số tiền cần check: ${priceText}\n\n• Cặp đôi: ${name_b} & ${name_a}\n• SĐT liên hệ: ${phone_a}\n------------------------\nKhách đã up xong ảnh và lời nhắn. Tiệm check tài khoản tinh tinh rồi nhấn nút duyệt ở dưới nha!`;
        
        console.log("🚀 Đang bắn tin nhắn sang Telegram từ API đặt đơn...");
        
        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: telegramAdminMsg,
            // XÓA BỎ parse_mode: 'Markdown' để an toàn tuyệt đối
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Xác nhận đã nhận tiền (Kích hoạt đơn)", callback_data: `approve_${orderId}` }
                ]]
            }
        }).then(() => {
            console.log("🎉 LỆNH GỬI TELEGRAM TRÊN WEB ĐÃ THÀNH CÔNG RỒI TIỆM ƠI!!!");
        }).catch((teleErr) => {
            console.error("❌ LỖI RỒI! Telegram từ chối gửi vì lý do:", teleErr.response ? teleErr.response.data : teleErr.message);
        });

        console.log("🎉 🎉 🎉 [LOG THÀNH CÔNG TỐI THƯỢNG]: Telegram đã nhận lệnh và bắn thông báo thành công!");
        res.json({ success: true, order_id: orderId });

    } catch (error) {
        console.error("💥 💥 💥 [LOG LỖI NGUY HIỂM - CODE RỚT VÀO CỤM CATCH]:");
        if (error.response) {
            // Lỗi trả về từ phía Telegram API hoặc Axios API
            console.error("  -> Chi tiết lỗi từ bên thứ 3:", error.response.data);
        } else {
            // Lỗi logic code thông thường
            console.error("  -> Chi tiết lỗi:", error.message);
        }
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
// API XÁC THỰC VÀO TRANG CHƠI GAME (ĐÃ UPDATE: BỐC ẢNH TỪ TABLE MEMORIES)
// =========================================================================
// API 1: XÁC THỰC VÀO GAME VÀ KÝ TÊN ẢNH BẢO MẬT (ĐÃ THÊM LOG CHI TIẾT)
// =========================================================================
app.post('/api/verify-game', async (req, res) => {
    const { order_id, password } = req.body;

    try {
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .select('*')
            .eq('id', order_id)
            .single();

        if (orderError || !order) {
            return res.status(404).json({ success: false, message: "Không tìm thấy mã số quà tặng này trên hệ thống!" });
        }

        if (order.status !== 'active') {
            return res.status(400).json({ success: false, message: "Hộp quà này chưa được kích hoạt thanh toán hoặc đã hết hạn nha!" });
        }

        if (order.password_b !== password) {
            return res.status(401).json({ success: false, message: "Mật khẩu bảo mật chưa chính xác rồi bạn ơi!" });
        }

        const { data: rawMemories, error: memoriesError } = await supabase
            .from('memories')
            .select('id, image_path, offset_x, offset_y')
            .eq('order_id', order_id);

        if (memoriesError) {
            console.error("❌ Lỗi truy vấn table memories:", memoriesError.message);
            return res.status(500).json({ success: false, message: "Không thể bốc danh sách ảnh kỷ niệm từ hệ thống!" });
        }

        // Thực hiện ký tên bảo mật động cho mảng ảnh
        // =========================================================================
        // 🛡️ BẢO MẬT TỐI THƯỢNG: TỰ ĐỘNG NỐI THƯ MỤC CON MÃ ĐƠN HÀNG (FOLDER)
        // =========================================================================
        // =========================================================================
        // 🚀 ĐÃ SỬA: TỰ ĐỘNG THỬ CẢ 2 ĐƯỜNG DẪN (CÓ FOLDER HOẶC KHÔNG CÓ FOLDER)
        // =========================================================================
        const memories = await Promise.all(rawMemories.map(async (item) => {
            // Thử kiểu 1: Tìm trực tiếp file ở ngoài rìa
            let pathToCheck = item.image_path;
            let { data, error } = await supabase.storage
                .from('photos') // ⚠️ Nhắc bài: Hãy chắc chắn tên Bucket trên Supabase đúng là 'memories' nha!
                .createSignedUrl(pathToCheck, 3600);

            // Nếu kiểu 1 thất bại (error), tự động chuyển sang kiểu 2: Tìm trong folder mã đơn hàng
            if (error || !data) {
                pathToCheck = `${order_id}/${item.image_path}`;
                const retry = await supabase.storage
                    .from('photos')
                    .createSignedUrl(pathToCheck, 3600);
                data = retry.data;
                error = retry.error;
            }
            
            // Nếu cả 2 kiểu đều không thấy thì mới gào lỗi ra Terminal
            if (error) {
                console.error(`❌ [THẤT BẠI TOÀN TẬP]: Tên file gốc trong DB là "${item.image_path}". Tìm ở ngoài hay trong folder "${order_id}/" đều không thấy file này trên Storage!`);
            } else {
                console.log(`🌸 [KÝ TÊN THÀNH CÔNG]: Đã tìm thấy và ký tên cho file tại đường dẫn: ${pathToCheck}`);
            }
            
            return {
                id: item.id,
                image_url: data ? data.signedUrl : '', 
                offset_x: item.offset_x,
                offset_y: item.offset_y
            };
        }));
        const activeDate = new Date(order.updated_at || order.created_at);
        const expireDate = new Date(activeDate.getTime() + (30 * 24 * 60 * 60 * 1000));
        const today = new Date();
        const daysLeft = Math.max(0, Math.ceil((expireDate - today) / (1000 * 60 * 60 * 24)));

        res.json({
            success: true,
            name_a: order.name_a,
            name_b: order.name_b,
            days_left: daysLeft,
            cards: memories || []
        });

    } catch (err) {
        console.error("Lỗi hệ thống verify-game:", err.message);
        res.status(500).json({ success: false, message: "Lỗi kết nối hệ thống Backend rồi Tiệm ơi!" });
    }
});

// =========================================================================
// API 2: BÓC THƯ TAY KHI LẬT ĐÚNG CẶP ẢNH (BÙ ĐẮP LỖI 404 TRONG ẢNH CỦA TIỆM)
// =========================================================================
app.post('/api/get-message', async (req, res) => {
    const { order_id, memory_id } = req.body;

    try {
        // Bốc lời nhắn bí mật từ table memories
        const { data: memory, error: memError } = await supabase
            .from('memories')
            .select('id, message, image_path, offset_x, offset_y')
            .eq('id', memory_id)
            .eq('order_id', order_id)
            .single();

        if (memError || !memory) {
            return res.status(404).json({ success: false, message: "Không tìm thấy thông điệp kỷ niệm này!" });
        }

        // Ký tên bảo mật cho tấm ảnh Polaroid phóng to xuất hiện trong Popup Modal công khai
        const { data: signData, error: signError } = await supabase.storage
            .from('memories')
            .createSignedUrl(memory.image_path, 3600);

        if (signError) {
            console.error(`❌ [LỖI KÝ TÊN POPUP]: Không thể ký tên phóng to cho file ${memory.image_path}:`, signError.message);
        }

        res.json({
            success: true,
            message: memory.message,
            image_url: signData ? signData.signedUrl : '',
            offset_x: memory.offset_x,
            offset_y: memory.offset_y
        });

    } catch (err) {
        console.error("Lỗi hệ thống get-message:", err.message);
        res.status(500).json({ success: false, message: "Lỗi kết nối lấy thông điệp rồi Tiệm ơi!" });
    }
});

// (Giữ nguyên đoạn API bốc API Admin Studio và Cron Job quét rà soát PDF lùi lịch 2 ngày phía dưới...)
app.listen(3000, () => console.log('🚀 Bộ não Tiệm Thương Thương tương tác hai chiều vận hành trên cổng 3000...'));
