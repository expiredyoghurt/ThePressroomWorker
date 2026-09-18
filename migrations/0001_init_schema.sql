-- The Pressroom — D1 schema migration
-- Migration: 0001_init_schema
-- Apply with: wrangler d1 migrations apply <DB_NAME>
--
-- Single-school deployment: one instance of this app serves ONE school, with
-- multiple classes and teachers underneath it. There is no schools table and
-- no school_id column anywhere — every class/teacher/student/article below
-- belongs to the one school this deployment runs for. `school_settings` is a
-- singleton (always id=1) holding the one school-wide setting that used to
-- live on the schools table.

PRAGMA foreign_keys = ON;

-- ============================================================
-- School-wide settings (singleton row, id always = 1)
-- ============================================================

CREATE TABLE school_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  default_similarity_threshold REAL NOT NULL DEFAULT 0.85
);

-- ============================================================
-- Staff / classes / pupils
-- ============================================================

CREATE TABLE teachers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('teacher','admin')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE classes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id INTEGER REFERENCES teachers(id),
  name TEXT NOT NULL,
  rankings_enabled INTEGER NOT NULL DEFAULT 0,     -- governs pupil AND parent view identically
  similarity_threshold REAL,                       -- NULL = inherit school_settings default
  parent_view_password_hash TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_classes_teacher ON classes(teacher_id);

CREATE TABLE students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id TEXT NOT NULL UNIQUE,                 -- unique across the whole school
  press_pass_hash TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  index_number INTEGER NOT NULL,                    -- manually assigned by teacher; register order
  class_id INTEGER REFERENCES classes(id),
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  avatar_config TEXT,                               -- JSON, cosmetic state
  archived INTEGER NOT NULL DEFAULT 0,               -- soft-delete on manual removal
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(class_id, index_number)
);
CREATE INDEX idx_students_class ON students(class_id);

-- ============================================================
-- Content
-- ============================================================

CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  source_name TEXT NOT NULL,
  publish_date DATE NOT NULL,
  section TEXT,
  full_text TEXT NOT NULL,
  text_chunks TEXT NOT NULL,                        -- JSON [{chunk_id, text}]
  image_data_url TEXT,                              -- base64 data URL, e.g. "data:image/jpeg;base64,..."
  thumbnail_data_url TEXT,                          -- base64 data URL; set via POST /api/admin/articles/:id/thumbnail
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  created_by INTEGER REFERENCES teachers(id),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_articles_status ON articles(status);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  type TEXT NOT NULL CHECK(type IN ('comprehension','vocabulary','reflect')),
  payload TEXT NOT NULL,                            -- JSON, shape depends on type
  pass_threshold REAL NOT NULL DEFAULT 0.75,         -- comprehension/vocabulary only; reflect passes on submit
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(article_id, type)
);
CREATE INDEX idx_tasks_article ON tasks(article_id);

-- ============================================================
-- Attempts / progress / XP
-- ============================================================

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempt_number INTEGER NOT NULL,                  -- 1, 2, 3... per student+task
  shuffle_seed TEXT,                                -- comprehension/vocabulary only
  answers TEXT NOT NULL,                            -- JSON: selections, or {short, long} for reflect
  score REAL,                                        -- 0.0–1.0; NULL for reflect
  similarity_flag INTEGER NOT NULL DEFAULT 0,       -- reflect only
  similarity_score REAL,                            -- reflect only
  warned_before_submit INTEGER NOT NULL DEFAULT 0,  -- reflect only
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by INTEGER REFERENCES teachers(id),      -- reflect only
  review_note TEXT,
  UNIQUE(student_id, task_id, attempt_number)
);
CREATE INDEX idx_attempts_student_task ON attempts(student_id, task_id);

CREATE TABLE task_progress (
  student_id INTEGER NOT NULL REFERENCES students(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  attempts_count INTEGER NOT NULL DEFAULT 0,
  first_attempt_score REAL,                         -- locked in — feeds XP/leaderboard eligibility
  best_score REAL,                                  -- comprehension/vocabulary: highest across attempts
  passed INTEGER NOT NULL DEFAULT 0,                -- best_score >= pass_threshold, OR submitted (reflect)
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  review_bonus_awarded INTEGER NOT NULL DEFAULT 0,  -- reflect only
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (student_id, task_id)
);

CREATE TABLE xp_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,                             -- 'comprehension_first_attempt','reflect_review_bonus',...
  counts_toward_leaderboard INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_xp_log_student ON xp_log(student_id);

CREATE TABLE badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id),
  article_id INTEGER NOT NULL REFERENCES articles(id),
  awarded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(student_id, article_id)
);
CREATE INDEX idx_badges_student ON badges(student_id);
