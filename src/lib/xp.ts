// Level thresholds + titles, mirrors §11 of the scope document.
// Keep this the single source of truth — don't hardcode thresholds elsewhere.

export const XP_VALUES = {
  COMPREHENSION_CORRECT: 10,
  VOCABULARY_CORRECT: 10,
  REFLECT_SUBMISSION: 15,
  REFLECT_REVIEW_BONUS_MAX: 10,
  ARTICLE_PUBLISHED: 25,
} as const;

export const LEVELS: { level: number; threshold: number; title: string }[] = [
  { level: 1, threshold: 0, title: "Copy Runner" },
  { level: 2, threshold: 100, title: "Cub Reporter" },
  { level: 3, threshold: 250, title: "Junior Reporter" },
  { level: 4, threshold: 450, title: "Staff Reporter" },
  { level: 5, threshold: 700, title: "Senior Reporter" },
  { level: 6, threshold: 1000, title: "Correspondent" },
  { level: 7, threshold: 1400, title: "Investigative Reporter" },
  { level: 8, threshold: 1900, title: "Bureau Chief" },
  { level: 9, threshold: 2500, title: "Editor" },
  { level: 10, threshold: 3200, title: "Editor-in-Chief" },
];

export function levelForXp(xp: number): { level: number; title: string } {
  let current = LEVELS[0];
  for (const l of LEVELS) {
    if (xp >= l.threshold) current = l;
    else break;
  }
  return { level: current.level, title: current.title };
}
