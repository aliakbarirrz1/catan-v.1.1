# راهنمای جامع دیتابیس، داکر (Docker) و استقرار روی Ubuntu در aaPanel
## بازی The Bears Catan

این پروژه مجهز به یک سیستم بک‌اند و پایگاه‌داده امن جهت ثبت‌نام و ورود کاربران با ایمیل، ذخیره پسوردهای رمزنگاری‌شده (Bcrypt)، ثبت آمار و نتایج مسابقات، لیدربرد و سرور سیگنالینگ WebRTC است.

---

## ۱. ویژگی‌های پیاده‌سازی شده

1. **جریان ورود بعد از اسپلش اسکرین**:
   - به محض ورود کاربر و اتمام لودینگ/محو شدن لوگو، وضعیت لاگین بررسی می‌شود.
   - در صورت عدم ورود، **صفحه اختصاصی ثبت‌نام و ورود** (`#auth-modal`) با انیمیشن مدرن و طراحی Glassmorphism نمایش داده می‌شود.
   - پس از ثبت‌نام یا ورود موفق، اطلاعات کاربر در کش محلی ذخیره شده و مستقیماً وارد **پنل کاربری و هاب کاتان** می‌شود.

2. **رمزنگاری امن پسورد (Bcrypt Hashing)**:
   - ایمیل‌ها اعتبارسنجی شده و پسوردها با الگوریتم استاندارد `bcrypt` (۱۰ دور Salt) رمزنگاری می‌شوند و هیچ پسوردی به شکل خام ذخیره نمی‌شود.

3. **پشتیبانی دوگانه از دیتابیس**:
   - **MySQL / MariaDB**: ویژه استقرار روی سرور لینوکس، کانتینر داکر و پنل aaPanel.
   - **SQLite**: ویژه تست سریع و محلی با صفر وابستگی (`catan.db`).

4. **تفکیک کامل پنل کاربری از فایل بازی سه‌بعدی**:
   - **`index.html` (پنل کاربری و هاب آنلاین)**: اسپلش اسکرین، ثبت‌نام و ورود، پروفایل، لیدربرد واقعی دیتابیس، لیست دوستان، اینونتوری و لابی مسابقات (فوق‌العاده سبک، سریع و بدون درگیر کردن GPU).
   - **`game.html` (محیط بازی سه‌بعدی کاتان)**: موتور رندر Three.js، تخته سه‌بعدی، تاس، ساخت‌وساز، کارت‌ها، هوش مصنوعی ربات‌ها، تبادل کالا و دکمه اختصاصی خروج به پنل کاربری.
   - **`api.js`**: ماژول اشتراکی کلاینت جهت برقراری ارتباط پایدار با REST API و دیتابیس.

5. **پشتیبانی از هر دو استک Node.js و PHP (PDO)**:
   - سرور اصلی `server.js` (شامل REST API + سرور سیگنالینگ PeerJS برای مولتی‌پلیر P2P).
   - اندپوینت‌های `api/auth.php` و `api/db.php` بر پایه PHP و PDO جهت استفاده در هاست‌های PHP پنل aaPanel.

---

## ۲. راهنمای گام‌به‌گام استقرار روی سرور Ubuntu با aaPanel و Docker

### گام اول: نصب MySQL و Docker در aaPanel
1. وارد پنل مدیریت **aaPanel** خود در سرور اوبونتو شوید.
2. از منوی سمت چپ به بخش **App Store** بروید.
3. ابزارهای زیر را نصب کنید (در صورت عدم نصب قبلی):
   - **MySQL 5.7** یا **MySQL 8.0**
   - **Nginx** (برای مدیریت وب‌سایت و دامنه و SSL)
   - **Docker Manager** (یا از طریق ترمینال اوبونتو با دستور `apt install -y docker.io docker-compose`)

---

### گام دوم: ساخت دیتابیس در aaPanel
1. از منوی سمت چپ aaPanel وارد بخش **Databases** شوید.
2. روی دکمه آبی‌رنگ **Add Database** کلیک کنید:
   - **DBName**: `catan_db`
   - **Username**: `catan_user`
   - **Password**: یک رمز عبور قوی وارد کنید (مثال: `MySecretPass123!`)
   - **Access Permission (بسیار مهم)**: گزینه را روی **Everyone** یا **Specified IP** با مقدار `172.17.0.%` قرار دهید تا کانتینر داکر بتواند به دیتابیس متصل شود.
3. روی دکمه **Submit** کلیک کنید.
4. *(اختیاری)*: در صورت تمایل می‌توانید محتویات فایل `schema_mysql.sql` را در تب phpMyAdmin این دیتابیس Import کنید (گرچه سرور برنامه جداول را به صورت خودکار نیز در صورت نبود ایجاد می‌کند).

---

### گام سوم: انتقال پروژه و تنظیم داکر (Docker Compose)
1. پوشه پروژه را روی سرور در مسیری مانند `/www/wwwroot/catan` آپلود کنید.
2. فایل `docker-compose.yml` موجود در پروژه را باز کرده و مشخصات دیتابیس ساخته‌شده در aaPanel را در آن وارد کنید:

```yaml
version: '3.8'

services:
  catan-game:
    build: .
    container_name: catan_game_app
    restart: always
    ports:
      - "8080:8080"
    environment:
      - NODE_ENV=production
      - PORT=8080
      - DB_TYPE=mysql
      - DB_HOST=host.docker.internal   # آدرس هاست میزبان داکر
      - DB_PORT=3306
      - DB_NAME=catan_db
      - DB_USER=catan_user
      - DB_PASSWORD=your_aapanel_db_password
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

3. در ترمینال اوبونتو وارد پوشه پروژه شده و دستور زیر را اجرا کنید:

```bash
cd /www/wwwroot/catan
docker-compose up -d --build
```

کانتینر به صورت خودکار ساخته شده و روی پورت `8080` سرور اجرا خواهد شد. وضعیت آن را با دستور زیر بررسی کنید:
```bash
docker ps
docker logs -f catan_game_app
```

---

### گام چهارم: اتصال دامنه و SSL در aaPanel (Reverse Proxy)

شما می‌توانید بازی را به دو شیوه در وب اجرا کنید:

#### حالت اول: استفاده از زیردامنه (Subdomain - پیشنهاد اصلی و استاندارد):
مثال: `catan.yourdomain.com`
1. در aaPanel یک سایت با نام دامنه `catan.yourdomain.com` بسازید.
2. در تب **SSL** گواهی رایگان Let's Encrypt را فعال کنید.
3. در تب **Reverse Proxy** روی **Add Reverse Proxy** کلیک کنید:
   - **Proxy Name**: `catan-proxy`
   - **Target URL**: `http://127.0.0.1:8080`
   - **Sent Host**: `$host`
   - تیک گزینه **WebSocket support** را فعال کنید.
   - دکمه Submit را بزنید.

#### حالت دوم: استفاده از ساب‌پث روی دامنه موجود (Subpath / Subfolder):
مثال: `yourdomain.com/catan/`
اگر می‌خواهید بازی روی دامنه‌ای که قبلاً سایت دیگری دارد در مسیر `/catan` باز شود:
1. در تنظیمات سایت فعلی در aaPanel به بخش **Reverse Proxy** یا **Config (Nginx)** بروید.
2. اگر از بخش Reverse Proxy تنظیم می‌کنید:
   - **Proxy directory**: `/catan`
   - **Target URL**: `http://127.0.0.1:8080/` (اسلش `/` در انتهای پورت بسیار مهم است!)
   - تیک **WebSocket support** فعال باشد.
3. یا در فایل کانفیگ Nginx سایت، بلوک زیر را قرار دهید:
```nginx
location /catan/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;
}
```

> **نکته بسیار مهم:** کدهای سرور (`server.js`) و کلاینت بازی به گونه‌ای بهینه‌سازی شده‌اند که حتی اگر ریورس‌پراکسی پیشوند `/catan` را به سرور بفرستد، سرور به شکل خودکار آن را هندل کرده و خطای `Cannot GET /catan/` رخ نخواهد داد.

---

## ۳. مستندات API احراز هویت

### ۱. ثبت‌نام کاربر جدید
- **مسیر**: `POST /api/auth/register`
- **بدنه درخواست (JSON)**:
```json
{
  "email": "player@gmail.com",
  "password": "mypassword123",
  "username": "شوالیه کاتان",
  "avatar": "images/thebearcatan.png"
}
```
- **پاسخ**:
```json
{
  "success": true,
  "message": "ثبت‌نام با موفقیت انجام شد.",
  "token": "...",
  "user": {
    "id": 1,
    "friend_id": "#BC-4829",
    "username": "شوالیه کاتان",
    "email": "player@gmail.com",
    "level": 1,
    "total_xp": 0
  }
}
```

### ۲. ورود به حساب کاربری
- **مسیر**: `POST /api/auth/login`
- **بدنه درخواست (JSON)**:
```json
{
  "email": "player@gmail.com",
  "password": "mypassword123"
}
```
- **پاسخ**:
```json
{
  "success": true,
  "message": "با موفقیت وارد شدید.",
  "token": "...",
  "user": { ... }
}
```


---

## ۴. مانیتورینگ پشت‌صحنه و مشاهده زنده لاگ‌ها (Admin Secret Console)

برای بررسی دائمی وضعیت سرور، خطاهای ثبت‌نام، وضعیت دیتابیس و رویدادهای زنده، یک پنل اختصاصی و امن بدون نمایش در بازی پیاده‌سازی شده است:

### ۱. مشاهده لاگ‌ها در مرورگر (حتی با گوشی موبایل و بدون نیاز به SSH):
آدرس زیر را در مرورگر باز کنید (کلید امنیتی پیش‌فرض `catan2026` است):
- **در حالت ساب‌پث**:
  `https://yourdomain.com/catan/api/admin/logs?key=catan2026`
- **در حالت زیردامنه (ساب‌دومین)**:
  `https://catan.yourdomain.com/api/admin/logs?key=catan2026`

**امکانات این پنل پشت‌صحنه:**
1. **داشبورد زنده (Live Auto-Refresh)**: بروزرسانی خودکار هر ۳ ثانیه یک‌بار با امکان توقف/ادامه.
2. **فیلترهای تفکیک‌شده**: مشاهده تمام لاگ‌ها، فقط خطاهای قرمز (`ERROR`)، درخواست‌های ثبت‌نام و ورود (`AUTH`)، تعاملات دیتابیس (`DB`) و رکوئست‌های وب (`REQ`).
3. **تست زنده اتصال به دیتابیس (Test DB)**: با زدن دکمه «🩺 تست زنده دیتابیس»، سرور بلافاصله یک کوئری واقعی به دیتابیس می‌زند و ستون‌های جدول `users`، تعداد کاربران ثبت‌شده و زمان پاسخگویی به میلی‌ثانیه را گزارش می‌دهد.
4. **دکمه پاک‌سازی لاگ‌ها (Clear Logs)**: جهت خالی کردن حافظه و فایل `server.log`.

### ۲. مشاهده لاگ‌ها از طریق ترمینال لینوکس (SSH):
اگر به سرور متصل هستید:
```bash
# مشاهده لاگ‌های زنده کانتینر داکر:
docker logs -f catan_game_app

# یا مشاهده لاگ‌های متنی فایل اختصاصی سرور:
tail -f /www/wwwroot/catan/server.log
```

---

## ۵. راهنمای حل مشکل ثبت‌نام (Registration Troubleshooting)

اگر در زمان ثبت‌نام با خطا مواجه می‌شوید، مراحل زیر را چک کنید:

۱. **بررسی اتصال دیتابیس با یک کلیک**:
آدرس زیر را در مرورگر باز کنید:
`https://yourdomain.com/catan/api/admin/test-db?key=catan2026`
- اگر وضعیت `status: "CONNECTED"` باشد، اتصال سرور به دیتابیس بدون مشکل است.
- اگر `status: "FAILED"` باشد، علت دقیق خطا (مانند `ER_ACCESS_DENIED_ERROR` یا `ECONNREFUSED`) در صفحه نمایش داده می‌شود.

۲. **دسترسی کاربر MySQL در aaPanel (علت شایع عدم اتصال داکر به دیتابیس)**:
- در aaPanel وارد تب **Databases** شوید.
- روبروی دیتابیس `catan_db` یا کاربر `catan_user`، ستون **Access Permission** را بررسی کنید.
- مقدار آن نباید `127.0.0.1` یا `localhost` باشد؛ زیرا کانتینر داکر از شبکه داخلی داکر (مثلاً `172.17.0.x`) متصل می‌شود.
- آن را روی **Everyone (%)** یا **Specified IP** با مقدار `172.17.0.%` تنظیم کنید.

۳. **اعمال تغییرات جدید و بیلد مجدد داکر (Rebuild)**:
به دلیل اینکه داکر کدهای پروژه را در ایمیج خود کپی می‌کند، پس از آپلود فایل‌های جدید روی سرور، حتماً دستور زیر را در ترمینال اجرا کنید:
```bash
cd /www/wwwroot/catan
docker-compose down
docker-compose up -d --build
```
اگر از افزونه **Node Project Manager** در aaPanel بدون داکر استفاده می‌کنید، کافیست در پنل روی گزینه **Restart** پروژه کلیک کنید.
