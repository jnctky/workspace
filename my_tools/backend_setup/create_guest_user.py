"""在本机 SQLite 库里创建一个可登录的 guest 账号。

用法（在 backend-api/backend 目录下执行）：
    ../../.venv/Scripts/python.exe ../../my_tools/create_guest_user.py

默认：email=guest@openbb.local  username=guest  password=123456
重复执行会重置该账号的密码并置 confirmed=True（幂等）。
"""

import os
import sqlite3
import sys
from datetime import datetime, timezone
from uuid import uuid4

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/backend-api/backend")

import bcrypt  # noqa: E402

EMAIL = "guest@openbb.co"
USERNAME = "guest"
PASSWORD = "123456"
DB_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "backend-api",
    "backend",
    "test_sqlite.db",
)


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def main() -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # 清掉早期用 .local 域名建的账号（pydantic 拒绝保留域名，登录会 500）
    conn.execute("delete from user where email like '%@openbb.local'")
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f")
    hashed = get_password_hash(PASSWORD)

    # 表里 uuid 是 16 字节 BLOB，PasswordType 读出来按 bytes 校验
    row = conn.execute(
        "select uuid, email from user where email = ? or username = ?", (EMAIL, USERNAME)
    ).fetchone()

    if row:
        conn.execute(
            """update user set password=?, confirmed=1, deleted=0,
                   primary_usage='bot', totp_active=0, two_factor_auth=0,
                   updated_date=? where uuid=?""",
            (hashed, now, row["uuid"]),
        )
        action = "已重置密码"
    else:
        # 邮箱域名 .local 只是本地标识，不走外发邮件
        conn.execute(
            """insert into user (
                   uuid, email, clean_email, username, password,
                   first_name, last_name, referral_code,
                   confirmed, deleted, is_superuser, can_submit_marketplace,
                   primary_usage, wants_contacted, has_profile_url,
                   billing_active, accepted_pro_tos, pro_trial_granted,
                   pro_trial_extension, pro_trial_renewals, total_referrals,
                   referred_by_sent, pro_inactivity_email_sent, welcome_screen,
                   temporary_password, totp_active, two_factor_auth,
                   created_date, updated_date
               ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                uuid4().bytes,
                EMAIL,
                EMAIL,
                USERNAME,
                hashed,
                "Guest",
                "User",
                uuid4().hex[:8],
                1,  # confirmed
                0,  # deleted
                0,  # is_superuser
                0,  # can_submit_marketplace
                "bot",  # primary_usage 非空 -> 登录返回 200 而不是 206
                0,  # wants_contacted
                0,  # has_profile_url
                0,  # billing_active
                0,  # accepted_pro_tos
                0,  # pro_trial_granted
                0,  # pro_trial_extension
                0,  # pro_trial_renewals
                0,  # total_referrals
                0,  # referred_by_sent
                0,  # pro_inactivity_email_sent
                0,  # welcome_screen
                0,  # temporary_password
                0,  # totp_active
                0,  # two_factor_auth
                now,
                now,
            ),
        )
        action = "已创建"

    # 2) 跳过 onboarding 问卷：写入 developer_onboarding 且 skip_onboarding=1
    #    前端 needsOnboarding = !(onboardingQuestions.skipOnboarding || (first+last+validate()))
    row = conn.execute("select uuid from user where email = ?", (EMAIL,)).fetchone()
    user_uuid = row["uuid"]
    conn.execute("delete from developer_onboarding where user_uuid = ?", (user_uuid,))
    conn.execute(
        """insert into developer_onboarding (
               user_uuid, primary_usage, organization, organization_name, role,
               programming_experience, data_types, other_data_types, skip_onboarding,
               uuid, created_date, updated_date
           ) values (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            user_uuid,
            "professional",  # 必须是 academic/professional/personal 之一
            "OpenBB Developer",
            "Local",
            "Developer",
            "intermediate-advanced",
            '["market_data"]',
            None,
            1,  # skip_onboarding
            uuid4().bytes,
            now,
            now,
        ),
    )

    conn.commit()
    check = conn.execute(
        "select email, username, confirmed, primary_usage, length(password) as plen from user where email=?",
        (EMAIL,),
    ).fetchone()
    conn.close()

    print(f"账号 {action}: {check['email']} / {check['username']}")
    print(f"  confirmed={check['confirmed']} primary_usage={check['primary_usage']} hash_len={check['plen']}")
    print(f"  密码: {PASSWORD}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
