// The Pressroom — shared types
// These mirror the D1 schema in migrations/0001_init_schema.sql exactly.
// Keep the two in sync by hand — there is no ORM generating this from the schema.

export interface Env {
  DB: D1Database;
  SESSIONS: KVNamespace;       // pupil / teacher / parent session tokens
  SHUFFLE_SEEDS: KVNamespace;  // per-attempt shuffle seeds + similarity-warning flags
  RATE_LIMIT: KVNamespace;
  AI?: Ai;                     // Workers AI binding, used for extraction/question-gen/similarity
}

// Single-school deployment: "admin" can manage every class and teacher;
// "teacher" is scoped to the classes they own. There is no platform_admin —
// that role only made sense when one deployment served several schools.
export type Role = "teacher" | "admin";
export type TaskType = "comprehension" | "vocabulary" | "reflect";
export type ArticleStatus = "draft" | "active" | "archived";

// GOAT list ("Greatest Of All Time" Think & Respond answers) scope — how far
// a pupil is looking beyond their own class. "level" groups classes sharing
// the same classes.grade_level; "school" is everyone. See lib/goat.ts.
export type GoatScope = "class" | "level" | "school";

// ---- Session shapes stored in KV ----

export interface PupilSession {
  kind: "pupil";
  studentId: number;
  classId: number;
}

export interface TeacherSession {
  kind: "teacher";
  teacherId: number;
  role: Role;
}

export interface ParentSession {
  kind: "parent";
  classId: number;
}

export type Session = PupilSession | TeacherSession | ParentSession;

// ---- Task payload shapes (tasks.payload JSON) ----

export interface ComprehensionQuestion {
  id: string;
  question: string;
  evidence_chunk_id: string;
  options: string[];
  correct_index: number; // never sent to the client pre-grading
}
export interface ComprehensionPayload {
  questions: ComprehensionQuestion[];
}

export interface VocabularyOption {
  text: string;
  role: "correct_synonym" | "distant_synonym" | "antonym" | "lookalike";
}
export interface VocabularyQuestion {
  id: string;
  target_word: string;
  word_class: string;
  context_sentence: string;
  options: VocabularyOption[];
  correct_index: number;
}
export interface VocabularyPayload {
  questions: VocabularyQuestion[];
}

export interface ReflectPayload {
  prompt: string;
  model_answers: string[];
}

// ---- Teacher import bundle ----
// This is the exact JSON shape a teacher pastes into the "Breaking News" tab
// after running the master prompt (src/lib/importPromptTemplate.ts) through
// an external AI tool (ChatGPT, Gemini, Claude, etc.) with a photo of the
// newspaper page. No AI binding/API key lives inside this app for ingestion —
// see routes/admin.ts importArticleJson().

export interface TeacherImportBundle {
  title: string;
  sourceName: string;
  section: string;
  publishDate: string; // "YYYY-MM-DD"
  fullText: string;
  textChunks: { chunk_id: string; text: string }[];
  comprehension: ComprehensionPayload;
  vocabulary: VocabularyPayload;
  reflect: ReflectPayload;
}

// ---- DB row shapes (subset of columns actually used in route code) ----

export interface TaskRow {
  id: number;
  article_id: number;
  type: TaskType;
  payload: string; // JSON string, parse per TaskType
  pass_threshold: number;
}

export interface StudentRow {
  id: number;
  reporter_id: string;
  press_pass_hash: string;
  first_name: string;
  last_name: string;
  index_number: number;
  class_id: number;
  xp: number;
  level: number;
  archived: number;
}

export interface TaskProgressRow {
  student_id: number;
  task_id: number;
  attempts_count: number;
  first_attempt_score: number | null;
  best_score: number | null;
  passed: number;
  xp_awarded: number;
  review_bonus_awarded: number;
}
