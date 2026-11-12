<?php
/**
 * The Bears Catan - Auth API (Register & Login) in PHP with PDO and Bcrypt
 */

require_once __DIR__ . '/db.php';

function json_response($data, $status_code = 200) {
    http_response_code($status_code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function sanitize_user($user) {
    unset($user['password_hash']);
    unset($user['pin']);
    return $user;
}

$raw_input = file_get_contents('php://input');
$data = json_decode($raw_input, true) ?: $_POST;
$action = isset($_GET['action']) ? trim($_GET['action']) : (isset($data['action']) ? trim($data['action']) : '');

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if ($action === 'register') {
        $email = filter_var(trim($data['email'] ?? ''), FILTER_VALIDATE_EMAIL);
        $password = (string)($data['password'] ?? '');
        $username = trim((string)($data['username'] ?? ''));
        $avatar = trim((string)($data['avatar'] ?? 'images/thebearcatan.png'));

        if (!$email) {
            json_response(['error' => 'لطفاً یک آدرس ایمیل معتبر وارد کنید.'], 400);
        }
        if (mb_strlen($password) < 6) {
            json_response(['error' => 'رمز عبور باید حداقل ۶ کاراکتر باشد.'], 400);
        }

        if (empty($username)) {
            $parts = explode('@', $email);
            $username = $parts[0];
        }
        $username = mb_substr(strip_tags($username), 0, 50);

        // Check unique email
        $stmt = $pdo->prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1');
        $stmt->execute([$email]);
        if ($stmt->fetch()) {
            json_response(['error' => 'این ایمیل قبلاً ثبت شده است. لطفاً وارد شوید.'], 409);
        }

        // Generate unique friend ID
        $friend_id = null;
        for ($i = 0; $i < 20; $i++) {
            $candidate = '#BC-' . mt_rand(1000, 9999);
            $chk = $pdo->prepare('SELECT id FROM users WHERE friend_id = ? LIMIT 1');
            $chk->execute([$candidate]);
            if (!$chk->fetch()) {
                $friend_id = $candidate;
                break;
            }
        }
        if (!$friend_id) {
            $friend_id = '#BC-' . substr((string)time(), -4);
        }

        // Hash password securely with Bcrypt
        $password_hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);

        $insert = $pdo->prepare('
            INSERT INTO users (
                friend_id, username, email, password_hash, pin, avatar, frame, title,
                equipped_color_idx, games_played, games_won, total_xp, level, is_guest, created_at, last_seen
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1, 0, NOW(), NOW())
        ');
        $insert->execute([$friend_id, $username, $email, $password_hash, '', $avatar, 'frame-wood', 'مهاجر کاتان']);

        $fetch = $pdo->prepare('SELECT * FROM users WHERE friend_id = ? LIMIT 1');
        $fetch->execute([$friend_id]);
        $user = $fetch->fetch();

        $token = bin2hex(random_bytes(32));

        json_response([
            'success' => true,
            'message' => 'ثبت‌نام با موفقیت انجام شد.',
            'token'   => $token,
            'user'    => sanitize_user($user)
        ], 201);

    } elseif ($action === 'login') {
        $identifier = trim((string)($data['email'] ?? $data['identifier'] ?? ''));
        $password = (string)($data['password'] ?? '');

        if (empty($identifier) || empty($password)) {
            json_response(['error' => 'ایمیل و رمز عبور الزامی است.'], 400);
        }

        $stmt = $pdo->prepare('
            SELECT * FROM users 
            WHERE LOWER(email) = LOWER(?) OR LOWER(username) = LOWER(?) OR friend_id = ? 
            LIMIT 1
        ');
        $stmt->execute([$identifier, $identifier, strtoupper($identifier)]);
        $user = $stmt->fetch();

        if (!$user) {
            json_response(['error' => 'کاربری با این مشخصات یافت نشد.'], 401);
        }

        if (empty($user['password_hash'])) {
            json_response(['error' => 'این حساب بدون رمز عبور ایجاد شده است. لطفاً ثبت‌نام کنید.'], 400);
        }

        if (!password_verify($password, $user['password_hash'])) {
            json_response(['error' => 'رمز عبور وارد شده نادرست است.'], 401);
        }

        $upd = $pdo->prepare('UPDATE users SET last_seen = NOW() WHERE id = ?');
        $upd->execute([$user['id']]);

        $token = bin2hex(random_bytes(32));

        json_response([
            'success' => true,
            'message' => 'با موفقیت وارد شدید.',
            'token'   => $token,
            'user'    => sanitize_user($user)
        ]);
    }
}

json_response(['error' => 'درخواست نامعتبر است.'], 400);
