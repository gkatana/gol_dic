-- Google 로그인 사용자 (이메일은 저장하지 않음)
CREATE TABLE users (
  id         TEXT PRIMARY KEY,      -- 'g:' + Google 계정 고유 id(sub)
  name       TEXT,
  picture    TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER NOT NULL
);

-- 즐겨찾기 (아이템 id 기준이라 리그와 무관)
CREATE TABLE favorites (
  user_id    TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
