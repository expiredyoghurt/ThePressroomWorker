-- The Pressroom — D1 migration
-- Migration: 0003_goat_list
--
-- The "GOAT list" (Greatest Of All Time) is NOT the XP/rankings leaderboard
-- — it's a teacher/admin-curated showcase of the best Think & Respond
-- (reflect task) answers, picked by hand, one response at a time.
--
-- grade_level lets classes be grouped for the "level-wide" GOAT scope (e.g.
-- every P5 class together) without needing a separate levels table — it's a
-- free-text label the admin sets per class (e.g. "P5"), matched exactly.

ALTER TABLE classes ADD COLUMN grade_level TEXT;

CREATE TABLE goat_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL UNIQUE REFERENCES attempts(id),  -- the exact reflect submission being honored
  student_id INTEGER NOT NULL REFERENCES students(id),          -- denormalized off the attempt, for fast scope queries
  class_id INTEGER NOT NULL REFERENCES classes(id),              -- snapshot of the student's class AT THE TIME the
                                                                  -- pick was made — deliberately does not follow the
                                                                  -- pupil if they're later moved to a different class
                                                                  -- (routes/admin.ts changePupilClass), since the
                                                                  -- pick belongs to the classroom moment it was written in
  article_id INTEGER NOT NULL REFERENCES articles(id),           -- denormalized off the attempt's task, avoids an
                                                                  -- extra join through tasks on every list query
  note TEXT,                                                     -- teacher's note, shown to pupils in the detail pop-up
  added_by INTEGER NOT NULL REFERENCES teachers(id),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_goat_picks_class ON goat_picks(class_id);

-- Give the two demo classes a grade_level so "level-wide" scope has
-- something to demonstrate out of the box.
UPDATE classes SET grade_level = 'P5' WHERE id = 1;
UPDATE classes SET grade_level = 'P6' WHERE id = 2;
