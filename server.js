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
app.use(express.json({ limit: '50mb' })); // Hỗ trợ up nhiều ảnh chất lượng cao cùng lúc

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Cấu hình hòm thư gửi Email đính kèm PDF của Tiệm
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// Hàm sinh mã ID ngẫu nhiên 8 ký tự (Ví dụ: kY7sT2wQ)
function generateOrderId() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

// ========================================================
// 🛠️ HỆ THỐNG API ĐỒNG BỘ 100% THEO CÁC GÓI MỚI CỦA FRONTEND
// ========================================================

// ========================================================
// 🛠️ HỆ THỐNG API ĐỒNG BỘ 100% CẤU TRÚC PRIVATE BUCKET CAO CẤP
// ========================================================

// API 1: Tạo đơn hàng (Dùng service_role ghi thẳng vào kho Private không cần mở RLS)
app.post('/api/create-order', async (req, res) => {
    try {
        const { email_a, phone_a, name_a, name_b, password_b, package_type, memories } = req.body;

        if (package_type === '1_week') {
            if (memories.length < 5 || memories.length > 6) {
                return res.status(400).json({ success: false, message: "Gói 7 Ngày Ngọc Ngào chỉ hỗ trợ đăng từ 5 đến 6 tấm ảnh thôi nè!" });
            }
        } else if (package_type === '2_weeks') {
            if (memories.length < 5 || memories.length > 10) {
                return res.status(400).json({ success: false, message: "Gói 14 Ngày Gắn Kết hỗ trợ đăng từ 5 đến 10 tấm ảnh bạn nhé!" });
            }
        }

        const orderId = generateOrderId();
        const daysLeft = package_type === '1_week' ? 7 : 14;
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + daysLeft);

        const { error: orderError } = await supabase.from('orders').insert([{
            id: orderId, email_a, phone_a, name_a, name_b, password_b, package_type, expires_at: expiresAt, status: 'active'
        }]);
        if (orderError) return res.status(400).json({ success: false, message: orderError.message });

        for (let i = 0; i < memories.length; i++) {
            const item = memories[i];
            const buffer = Buffer.from(item.base64_data.split(',')[1], 'base64');

            // Backend dùng quyền tối cao đẩy thẳng vào kho Private
            const { error: uploadError } = await supabase.storage.from('photos').upload(item.image_path, buffer, { contentType: 'image/jpeg' });

            if (!uploadError) {
                await supabase.from('memories').insert([{
                    order_id: orderId, image_path: item.image_path, message: item.message, offset_x: item.offset_x || 50, offset_y: item.offset_y || 50
                }]);
            }
        }

        res.json({ success: true, order_id: orderId });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API 2: Trả thông tin cho Game (Tự sinh thẻ thông hành Signed URL 15 phút bảo mật)
app.post('/api/verify-game', async (req, res) => {
    const { order_id, password } = req.body;

    const { data: order } = await supabase.from('orders').select('*').eq('id', order_id).single();
    if (!order || order.password_b !== password) {
        return res.status(401).json({ success: false, message: "Mã số quà tặng hoặc Mật khẩu không đúng rồi ạ!" });
    }

    const timeLeft = new Date(order.expires_at) - new Date();
    const daysLeft = Math.max(0, Math.ceil(timeLeft / (1000 * 60 * 60 * 24)));

    const { data: memories } = await supabase.from('memories').select('id, image_path, offset_x, offset_y').eq('order_id', order_id);

    // Kỹ thuật Signed URL: Tạo link mã hóa có thời hạn ngắn cho bàn chơi game
    const cards = [];
    for (const item of memories) {
        const { data: signedData } = await supabase.storage.from('photos').createSignedUrl(item.image_path, 900); // Có tác dụng trong 15 phút
        cards.push({
            id: item.id, offset_x: item.offset_x, offset_y: item.offset_y,
            image_url: signedData ? signedData.signedUrl : ""
        });
    }

    res.json({ success: true, name_a: order.name_a, name_b: order.name_b, days_left: daysLeft, cards });
});

// API THÊM: Lấy thư tình chi tiết khi lật đúng cặp (Cấp link Signed URL cho popup to bản)
app.post('/api/get-message', async (req, res) => {
    try {
        const { order_id, memory_id } = req.body;
        const { data } = await supabase.from('memories').select('message, image_path, offset_x, offset_y').eq('order_id', order_id).eq('id', memory_id).single();

        if (!data) return res.status(444).json({ success: false, message: "Không tìm thấy nội dung!" });

        const { data: signedData } = await supabase.storage.from('photos').createSignedUrl(data.image_path, 900);

        res.json({
            success: true,
            message: data.message,
            offset_x: data.offset_x,
            offset_y: data.offset_y,
            image_url: signedData ? signedData.signedUrl : ""
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// API 3: Admin Studio bốc toàn bộ các trang để chỉnh sửa đa trang công nghệ cao
app.get('/api/admin/order/:id', async (req, res) => {
    const { id } = req.params;
    const { data: order } = await supabase.from('orders').select('*').eq('id', id).single();
    const { data: memories } = await supabase.from('memories').select('*').eq('order_id', id).order('id', { ascending: true });

    if (!order) return res.status(404).json({ message: "Không tìm thấy đơn hàng!" });

    const pages = memories.map(item => ({
        id: item.id, message: item.message, offset_x: item.offset_x, offset_y: item.offset_y, font_size: item.font_size,
        image_url: `${process.env.SUPABASE_URL}/storage/v1/object/public/photos/${item.image_path}`
    }));

    res.json({ success: true, name_a: order.name_a, name_b: order.name_b, status: order.status, pages });
});

// API 4: Admin Studio lưu lại thay đổi (Hỗ trợ ép kích cỡ chữ thủ công hoặc null để auto)
app.post('/api/admin/order/:id/save-page', async (req, res) => {
    const { id } = req.params;
    const { memory_id, message, offset_x, offset_y, font_size } = req.body;

    await supabase.from('memories').update({
        message,
        offset_x: parseInt(offset_x),
        offset_y: parseInt(offset_y),
        font_size: font_size ? parseInt(font_size) : null
    }).eq('order_id', id).eq('id', memory_id);

    res.json({ success: true, message: "Đã lưu lại thay đổi của chủ tiệm!" });
});


// ========================================================
// 🤖 HỆ THỐNG AUTOMATION CHẠY NGẦM (QUY TRÌNH BẢO HIỂM LÙI LỊCH 2 NGÀY)
// ========================================================

// Đồng hồ quét hệ thống thức dậy vào đúng 22:00 đêm mỗi ngày
cron.schedule('0 22 * * *', async () => {
    console.log("⏱️ Máy quét ngầm Tiệm Thương Thương đang làm việc...");
    const now = new Date();

    // LỚP 1: TRƯỚC 2 NGÀY -> Tạo file PDF nháp và bắn báo động có link về Telegram
    const alertTimeline = new Date();
    alertTimeline.setDate(now.getDate() + 2);

    const { data: incomingDrafts } = await supabase.from('orders')
        .select('*')
        .eq('status', 'active')
        .lte('expires_at', alertTimeline.toISOString());

    if (incomingDrafts) {
        for (const order of incomingDrafts) {
            const browser = await puppeteer.launch({ headless: true });
            const page = await browser.newPage();
            await page.setViewport({ width: 1122, height: 794 }); // Khóa cứng tỉ lệ giấy A4 ngang tránh méo hình

            // Puppeteer truy cập thẳng vào trang admin mẫu để tự render giao diện chuẩn xác nhất
            await page.goto(`${process.env.FRONTEND_URL}/admin-sample.html?id=${order.id}`, { waitUntil: 'networkidle2' });
            const pdfBuffer = await page.pdf({ format: 'A4', landscape: true, printBackground: true });
            await browser.close();

            const pdfPath = `drafts/draft_${order.id}.pdf`;
            await supabase.storage.from('documents').upload(pdfPath, pdfBuffer, { contentType: 'application/pdf', upsert: true });
            await supabase.from('orders').update({ status: 'pdf_draft_ready' }).eq('id', order.id);

            // Bắn tin nhắn menu duyệt bài về Telegram điện thoại của bạn
            const telegramMsg = `📑 *[TIỆM THƯƠNG THƯƠNG - DUYỆT PDF NHÁP]*\n────────────────────────\n*• Đơn hàng:* \`${order.id}\`\n*• Cặp đôi:* ${order.name_b} & ${order.name_a}\n\n🔗 *[Nhấn vào đây để mở link xem trước file PDF nháp](${process.env.SUPABASE_URL}/storage/v1/object/public/documents/${pdfPath})*\n────────────────────────\n_Hệ thống đã chuẩn bị xong xuôi trước 2 ngày. Tiệm hãy kiểm tra góc ảnh và chữ xem có bị tràn không nha!_`;
            await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: process.env.TELEGRAM_CHAT_ID, text: telegramMsg, parse_mode: 'Markdown'
            });
        }
    }

    // LỚP 2: TRƯỚC 1 NGÀY (Đúng 00:00 ngày cuối) -> Tự động bắn Email báu vật kèm PDF gửi khách
    const sendTimeline = new Date();
    sendTimeline.setDate(now.getDate() + 1);

    const { data: ordersToSend } = await supabase.from('orders')
        .select('*')
        .in('status', ['pdf_draft_ready', 'pdf_approved'])
        .lte('expires_at', sendTimeline.toISOString());

    if (ordersToSend) {
        for (const order of ordersToSend) {
            const pdfPath = `drafts/draft_${order.id}.pdf`;
            const { data: fileData } = await supabase.storage.from('documents').download(pdfPath);

            if (fileData) {
                const pdfBuffer = Buffer.from(await fileData.arrayBuffer());
                await transporter.sendMail({
                    from: `"Tiệm Thương Thương 🌸" <${process.env.EMAIL_USER}>`,
                    to: order.email_a,
                    subject: `💌 Cuốn sách kỷ niệm ngọt ngào gửi từ Tiệm Thương Thương...`,
                    html: `<p>Chào bạn <b>${order.name_a}</b>,</p><p>Hành trình lưu giữ 7 ngày ngọt ngào chuẩn bị khép lại. Để giữ bảo mật quyền riêng tư tuyệt đối, đúng 23:59 ngày mai hệ thống sẽ tự động kích hoạt lệnh tự hủy vĩnh viễn.</p><p>Tiệm xin gửi tặng hai bạn <b>'Cuốn sách kỷ niệm số'</b> đính kèm dưới email này làm báu vật cất giữ mãi mãi hành trình thanh xuân vừa qua nhé! 🤍</p>`,
                    attachments: [{ filename: `Our_Sweet_Memory_Book_${order.id}.pdf`, content: pdfBuffer }]
                });

                await supabase.from('orders').update({ status: 'completed' }).eq('id', order.id);
            }
        }
    }

    // LỚP 3: CHẠM MỐC THỜI GIAN -> KÍCH HOẠT LỆNH TỰ HỦY BẢO MẬT TUYỆT ĐỐI 100%
    const { data: expiredOrders } = await supabase.from('orders').select('*').lte('expires_at', now.toISOString());
    if (expiredOrders) {
        for (const order of expiredOrders) {
            console.log(`🚨 LỆNH TỰ HỦY KÍCH HOẠT: Xóa sạch dấu vết đơn hàng ${order.id}`);

            const { data: memories } = await supabase.from('memories').select('image_path').eq('order_id', order.id);
            if (memories && memories.length > 0) {
                const filesToDelete = memories.map(m => m.image_path);
                await supabase.storage.from('photos').remove(filesToDelete);
            }
            await supabase.storage.from('documents').remove([`drafts/draft_${order.id}.pdf`]);
            await supabase.from('orders').delete().eq('id', order.id); // Lệnh cascade tự động quét sạch bảng memories
        }
    }
});

app.listen(3000, () => console.log('🚀 Bộ não Backend Tiệm Thương Thương vận hành trên cổng 3000...'));