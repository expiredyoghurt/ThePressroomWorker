// The Pressroom — "Breaking News" import prompt
//
// Shown verbatim in the teacher front-end's "Breaking News" tab (behind a
// "Copy Prompt" button). The teacher pastes this into ChatGPT, Gemini, Claude,
// or any other AI chat tool ALONGSIDE a photo of the newspaper page, gets
// back one JSON block, and pastes that JSON into the app (or converts it to
// SQL for direct Cloudflare D1 console use — see the SQL section below).
//
// No AI API key or model binding lives inside this Worker for ingestion —
// the heavy lifting (OCR + question authoring) happens in whatever AI tool
// the teacher already has access to.

export const MASTER_IMPORT_PROMPT = `You are helping a Singapore primary school teacher turn one newspaper article into a reading-comprehension activity for P4–P6 pupils (ages 10–12). I will attach a photo of the newspaper page. Follow every step below in order and do not skip any.

STEP 1 — FIND THE DATE
Look for the article's publish date, usually printed in the newspaper's masthead or header (e.g. "TUESDAY, JULY 21, 2026"). If you cannot find a clear date on the page, STOP and ask me for the date before doing anything else. Do not guess or invent a date.

STEP 2 — TRANSCRIBE, IN YOUR OWN WORDS
Read the article in the photo and write a clear, paraphrased retelling of it — 4 to 7 short paragraphs, plain language suitable for a 10-12 year old reader. Do NOT copy the newspaper's original sentences word-for-word; rewrite the content in your own words while keeping every fact, name, number and quote's meaning accurate. This matters for copyright reasons — a close paraphrase that keeps the original sentence structure is not acceptable, it needs to be a genuine rewrite.

STEP 3 — SPLIT INTO CHUNKS
Split your paraphrased text from Step 2 into individual sentences, in reading order. Give each sentence a chunk_id: "c1", "c2", "c3", and so on. Every sentence in your Step 2 text must appear as exactly one chunk — don't skip any, don't merge two sentences into one chunk.

STEP 4 — WRITE 4 COMPREHENSION QUESTIONS
Write exactly 4 multiple-choice comprehension questions based on facts stated in the text. For each question:
- Write 4 answer options: 1 correct, 3 plausible-but-wrong.
- Note which chunk_id (from Step 3) contains the evidence for the correct answer — the answer must be directly findable in that one sentence.
- Note the correct option's position as correct_index (0 = first option, 1 = second, and so on).
Spread the 4 questions across different parts of the article — don't cluster them all in the first paragraph.

STEP 5 — WRITE 1 VOCABULARY QUESTION
Pick ONE word or short phrase from the article that a P5/6 pupil might not know, but that's worth learning (avoid overly obscure or overly easy words). Write:
- target_word: the word/phrase as it appears in the article
- word_class: its part of speech (noun, verb, adjective, adverb, or "noun phrase" etc.)
- context_sentence: the sentence it appears in
- Exactly 4 answer options, each tagged with a role:
  - "correct_synonym" — a word/phrase that means the same thing AND correctly fits grammatically in the context sentence
  - "distant_synonym" — a word/phrase that's related in meaning but is too vague, too strong, or wrong register to naturally fit this specific sentence
  - "antonym" — a word/phrase that means roughly the opposite
  - "lookalike" — a word/phrase that looks or sounds similar to the target word (similar spelling or word root) but means something completely different — this should NOT be an obvious answer, it should be genuinely easy to confuse at a glance
- All 4 options must be the same word_class as the target word, so a pupil can't eliminate any option on grammar alone.
- Note correct_index — which position (0-3) is the correct_synonym.

STEP 6 — WRITE 1 REFLECT / THINK-AND-RESPOND PROMPT
Write one open-ended opinion or reflection question connected to the article — something with no single right answer, that asks the pupil what they think and why (not just "summarise the article"). Then write exactly 3 different model answers to it, each 2-4 sentences, each taking a genuinely different angle or opinion, written in a natural, first-person voice a thoughtful 10-12 year old might use (not an adult academic register). These 3 answers will be shown to the pupil AFTER they submit their own answer, as examples of other perspectives — not as a single "correct" answer.

STEP 7 — OUTPUT
Output ONLY a single JSON object (no other commentary, no markdown code fences, no explanation before or after) in EXACTLY this shape:

{
  "title": "the article's headline",
  "sourceName": "the newspaper's name, e.g. The Straits Times",
  "section": "the section/page label if shown, e.g. Newsroom, Deep Dive, Spotlight — otherwise leave as an empty string",
  "publishDate": "YYYY-MM-DD",
  "fullText": "your full paraphrased text from Step 2, as one string with paragraphs separated by a single newline character",
  "textChunks": [
    { "chunk_id": "c1", "text": "first sentence" },
    { "chunk_id": "c2", "text": "second sentence" }
  ],
  "comprehension": {
    "questions": [
      {
        "id": "q1",
        "question": "...",
        "evidence_chunk_id": "c4",
        "options": ["option A", "option B", "option C", "option D"],
        "correct_index": 0
      }
    ]
  },
  "vocabulary": {
    "questions": [
      {
        "id": "v1",
        "target_word": "...",
        "word_class": "noun",
        "context_sentence": "...",
        "options": [
          { "text": "...", "role": "correct_synonym" },
          { "text": "...", "role": "distant_synonym" },
          { "text": "...", "role": "antonym" },
          { "text": "...", "role": "lookalike" }
        ],
        "correct_index": 0
      }
    ]
  },
  "reflect": {
    "prompt": "...",
    "model_answers": ["...", "...", "..."]
  }
}

Rules for the JSON: comprehension.questions must contain exactly 4 items. vocabulary.questions must contain exactly 1 item. reflect.model_answers must contain exactly 3 items. Every evidence_chunk_id must exactly match a chunk_id you created in Step 3. It does not matter which position you place the correct answer in — put it wherever feels natural — just make sure correct_index accurately points to it. Use plain double-quoted JSON strings; escape any quotation marks inside your text.

—

OPTIONAL — SQL OUTPUT INSTEAD OF JSON:
If asked to output SQL instead of JSON (for pasting directly into the Cloudflare D1 console rather than the app), convert the same content into this exact 4-statement form, escaping any single quote inside a text field by doubling it ('' instead of '):

INSERT INTO articles (title, source_name, publish_date, section, full_text, text_chunks, status, created_by)
VALUES ('<title>', '<sourceName>', '<publishDate>', '<section>', '<fullText>', '<textChunks as a JSON string>', 'draft', :TEACHER_ID);

-- Run the statement above FIRST on its own, then run: SELECT last_insert_rowid();
-- Take the number it returns and use it as :ARTICLE_ID in all three statements below
-- (last_insert_rowid() cannot just be reused across multiple later statements, since
-- it changes after every insert — so this one manual substitution step is required).

INSERT INTO tasks (article_id, type, payload) VALUES (:ARTICLE_ID, 'comprehension', '<comprehension object as a JSON string>');
INSERT INTO tasks (article_id, type, payload) VALUES (:ARTICLE_ID, 'vocabulary', '<vocabulary object as a JSON string>');
INSERT INTO tasks (article_id, type, payload) VALUES (:ARTICLE_ID, 'reflect', '<reflect object as a JSON string>');

Leave :TEACHER_ID exactly as that placeholder token — the teacher will replace it by hand before running the SQL, since you don't know that value.`;
