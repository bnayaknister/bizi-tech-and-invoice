# E13 — מסך ביקורת לקוח על Bunny Stream: תכנון סכמה

**נכתב: 11.10.2026 · שלב E13-1 (תכנון בלבד)**: אין מיגרציה, אין קוד ואין קריאת API חיה. כל מה שנאמר כאן על Bunny נלקח מהתיעוד הציבורי שלהם, ושום דבר לא נבדק מול החשבון.
**מקור ההיקף:** שורת E13 ב-[TICKETS.md](../TICKETS.md), כולל תחקירי 6.10 ו-8.10. המסמך הזה **אינו מחליף** את השורה. הוא ממשיך אותה ומחליף רק את טבלת השלבים של 8.10 (ראו §9).

---

## 0. הכרעות שכבר נקבעו

- **גרסה נספרת פר קובץ:** כל פריט (פרק מלא, ריל 1, ריל 2…) מקבל v1, v2… משלו. — הכרעת בעלים 11.10
- **העלאת גרסה חדשה לא שולחת קישור ללקוח.** אין שליחה אוטומטית בשלב זה. — הכרעת בעלים 11.10
- **קבצים ב-Bunny נמחקים 90 יום מרגע אישור הלקוח לאותו פריט.** פריט שלא אושר לא נמחק. — הכרעת בעלים 11.10
- **backfill ב-v1:** אישורים והערות קיימים עוברים למבנה החדש כהיסטוריה לקריאה בלבד. — הוכרע ע"י Claude באצלת בעלים 11.10
- **הורדה באיכות מלאה ללקוח** נעשית דרך המערכת שלנו, בקישור מאובטח ומוגבל בזמן, ולא דרך חשיפה ציבורית של המקור ב-Bunny. — הכרעת בעלים 11.10
- **E12:** ממתין להכרעה אחרי שהבעלים יקרא את הגדרתו. המסמך לא מכריע בו דבר. היכן ש-E13 נוגע בשאלה ש-E12 פותח, הנקודה מופיעה **כשאלה** ב-§10.

**הכרעות קודמות מהטיקט (6.10), שהמסמך נשען עליהן ואינו פותח מחדש:** נעצים, לא DRM (MediaCage חוסם נגן משלנו) · כל נעץ נשמר מיד · הטכנאי מעלה דרך דף במערכת · פרקים ישנים ב-Drive לא עוברים, ושני המסלולים חיים במקביל · הלקוח מוריד בדיוק את מה שהועלה.

**הגדרות הספרייה (הבעלים, 11.10), שהתכנון מניח:** ספריית `bizi-review` · Frankfurt בלבד, בלי רפליקציה · Free Encoding · **Keep original files מופעל** · Early-Play ו-Just-In-Time כבויים · MP4 fallback ו-Multi-audio מופעלים · Content tagging כבוי · 240p עד 1080p, H.264 בלבד · תקופת ניסיון, ואמצעי תשלום יתווסף לפני ההעלאה הראשונה.

---

## 1. מה קיים היום (תמצית מהסקירה)

| שכבה | מה יש |
|---|---|
| דף ציבורי | [`/r/[token]/page.tsx`](../../src/app/r/[token]/page.tsx) ו-[`ReviewClient.tsx`](../../src/app/r/[token]/ReviewClient.tsx), עם נגן `iframe` של Drive ([:105](../../src/app/r/[token]/ReviewClient.tsx#L105)) |
| תשובת לקוח | `POST /api/r/[token]/respond` ← [`applyResponse`](../../src/lib/review/links.ts#L461) |
| צד צוות | `review-link` (מינטינג) · `review-items` (קישור מדיה לפריט) · `review-current` (הסבב האחרון לפופאפ) · `review-ack` ("קיבלתי") · `review-materials` (תמלול ואודיו) · הדרואר · עמוד ההדפסה |
| טבלאות | `client_review_links` (0029, 0037, 0071, 0076, 0078) · `client_review_items` (0057) · `client_review_transcripts` (0076) · עמודות `review_*` על `productions` (0029, 0071) · `production_log` עם `kind='client'` · `events` |
| איפה נשמר "אישור לקוח" | (1) `productions.review_episode_approved` / `review_reels_approved`, דביקים בין סבבים · (2) `client_review_items.approved` + `approved_at` פר פריט · (3) `productions.status = 'אושר_ע"י_לקוח'`, שמפעיל את `on_production_approved` (job) · (4) `client_review_links.responded_at` + `*_response` / `*_note` כהיסטוריית הסבב · (5) האירוע `client_review_approved` |

**שתי עובדות מהסקירה שמעצבות את הסכימה:**
1. **`client_review_items.approved_at` אינו עמיד.** B10 ([productions/[id]/route.ts:158-161](../../src/app/api/productions/[id]/route.ts#L158-L161)) מאפס `approved=false, approved_at=null` בגרירה אחורה בקנבן. לכן אי אפשר לעגן עליו שעון מחיקה. הסכימה מוסיפה **רישום אישור שאינו נמחק** (§2.4).
2. **`client_review_items.media_link` נדרס במקום, בלי היסטוריה** ([review-items/route.ts:70](../../src/app/api/productions/[id]/review-items/route.ts#L70)). זה בדיוק מה שטבלת הגרסאות סוגרת.

---

## 2. טבלאות מוצעות

**עקרון:** הכול אדיטיבי. אף עמודה ש-`resolveLink` / `applyResponse` / הדרואר קוראים היום **לא משתנה ולא נמחקת**. דגלי האישור על `productions` נשארים מקור האמת לחיוב ולסטטוס, ו-`on_production_approved` לא נוגע בשום טבלה חדשה.

### 2.1 פריט: `client_review_items` (קיים, 0057). לא נוצרת טבלה חדשה
הפריט כבר קיים: שורה לפרק ושורה לכל ריל, שייכת ל-`productions(id)`, עם ייחודיות חלקית ([0057](../../supabase/migrations/0057_client_review_items.sql)). אין סיבה לייצר ישות מקבילה.
- **ללא שינוי עמודות.** `media_link` נשאר לצורך המסלול הישן (Drive). מרגע שלפריט יש גרסה, הדף קורא מהגרסה האחרונה (§7.2).
- **מגבלה ידועה (0057 §4):** פריטים נזרעים רק במינטינג הראשון, ותוספת ריל מאוחרת אינה יוצרת פריט. העלאת גרסה לריל שאין לו פריט תצטרך לזרוע אותו באותו כלל של `review-items` PATCH. ראו שאלה 6.

### 2.2 גרסה: `client_review_versions` (חדשה)
| עמודה | טיפוס | הערה |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid NOT NULL → `client_review_items(id)` | הגרסה היא עובדה על המדיה של הפריט |
| `number` | int NOT NULL, ‏`>= 1` | **unique `(item_id, number)`**. מוקצה בצד השרת בלבד (§2.6) |
| `source` | text NOT NULL check in (`'drive'`, `'bunny'`) | שני המסלולים חיים במקביל |
| `media_link` | text | ל-`drive` בלבד (גם ב-backfill) |
| `bunny_library_id` | bigint | ל-`bunny` בלבד |
| `bunny_video_id` | uuid, unique | ה-`guid` של Bunny |
| `bunny_status` | text check in (`'created'`, `'uploading'`, `'processing'`, `'playable'`, `'ready'`, `'failed'`) | הסטטוס **שלנו**, נגזר (§3) |
| `bunny_status_raw` | int | הקוד האחרון שהתקבל, לאבחון בלבד |
| `bunny_status_at` | timestamptz | |
| `is_audio_only` | boolean NOT NULL default false | נקבע בהעלאה לפי סוג הקובץ ומאומת מול `width/height` (§3) |
| `duration_ms` | int | מ-`length` (שניות) ×1000 |
| `original_filename` | text | השם שהטכנאי העלה, לשם הקובץ בהורדה |
| `original_size_bytes` | bigint | |
| `has_original` | boolean | מ-`hasOriginal`. **תנאי ל-`ready`** (§9, E13-2) |
| `original_sha256` | text | מ-`originalHash`, הוכחה שהמקור נשמר כפי שהועלה |
| `timeline_offset_ms` | int | לייצוא סמנים לפרמייר (שלב מאוחר). nullable |
| `is_backfill` | boolean NOT NULL default false | `true` = היסטוריה לקריאה בלבד |
| `created_by` | uuid → `profiles(id)` | null ב-backfill |
| `created_at` | timestamptz NOT NULL default now() | |
| `media_deleted_at` | timestamptz | נקבע רק אחרי מחיקה מוצלחת (או 404) ב-Bunny |
| `delete_attempts` | int NOT NULL default 0 | |
| `delete_last_error` | text | |
| `delete_last_attempt_at` | timestamptz | |

**CHECKs:** כש-`source='bunny'`, ‏`bunny_video_id` ו-`bunny_library_id` חייבים להיות NOT NULL. כש-`source='drive'`, `bunny_*` חייבים להיות NULL. ‏`media_deleted_at` אפשרי רק כש-`source='bunny'`.
**אינדקסים:** `(item_id, number desc)` לגרסה האחרונה · חלקי על `source='bunny' and media_deleted_at is null` לסורק המחיקה.

### 2.3 הערה: `client_review_comments` (חדשה). נעצים והערות כלליות בטבלה אחת
| עמודה | טיפוס | הערה |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid NOT NULL → `client_review_items(id)` | |
| `version_id` | uuid → `client_review_versions(id)` | **NOT NULL לנעץ.** בלי עוגן גרסה הנעץ "צף" לחיתוך אחר (תחקיר 8.10) |
| `link_id` | uuid → `client_review_links(id)` on delete set null | **מקור** (דרך איזה קישור נכתב), לא עוגן |
| `kind` | text check in (`'pin'`, `'general'`) | |
| `pin_number` | int | לנעץ בלבד. **unique `(version_id, pin_number)` where kind='pin'** |
| `time_ms` | int, ‏`>= 0` | לנעץ בלבד. CHECK: ‏`kind='pin'` ⇔ `time_ms` ו-`pin_number` NOT NULL |
| `body` | text NOT NULL | |
| `author_kind` | text check in (`'client'`, `'team'`) | |
| `author_name` | text | לקוח: מה שהקליד (אין לו חשבון) |
| `author_id` | uuid → `profiles(id)` | צוות בלבד |
| `created_at` | timestamptz NOT NULL default now() | **נשמר מיד** לכל נעץ, בלי טיוטה |
| `resolved_at`, `resolved_by` | timestamptz, uuid | "טופל" (שלב מאוחר), בלי טבלה נוספת |
| `is_backfill` | boolean NOT NULL default false | |
| `backfill_source` | text | למשל `link:<uuid>:episode_note`, כדי שאפשר יהיה לבדוק כל שורה מול המקור |

**סטייה מוצהרת מהצעת 6.10:** שם הנעץ עוגן ב-`link_id` (סבב). כאן העוגן הוא **`version_id`**, ו-`link_id` נשמר כמקור בלבד. זו המסקנה שתחקיר 8.10 כבר הגיע אליה ("`client_review_pins` צריך `version_id` ולא `item_id`"). שאלת הנראות בין קישורים נשארת פתוחה (שאלה 3).
**הערות כלליות חדשות:** ייכתבו לכאן (`kind='general'`). `episode_note` / `reels_note` על הקישור **ממשיכים להיכתב כמו היום** כל עוד `applyResponse` ו-`review-current` / `review-ack` בנויים עליהם. אין להפסיק אותם בשלב הזה.

### 2.4 אישור: `client_review_approvals` (חדשה, append-only)
| עמודה | טיפוס | הערה |
|---|---|---|
| `id` | uuid PK | |
| `item_id` | uuid NOT NULL → `client_review_items(id)` | |
| `version_id` | uuid → `client_review_versions(id)` | **איזה חיתוך אושר.** nullable רק ב-backfill שאין לו גרסה |
| `link_id` | uuid → `client_review_links(id)` on delete set null | |
| `decision` | text check in (`'approved'`, `'revisions'`) | שתי ההחלטות נרשמות, כי זו ההיסטוריה |
| `note` | text | |
| `decided_at` | timestamptz NOT NULL | |
| `revoked_at` | timestamptz | **B10:** גרירה אחורה מסמנת כאן. אין מחיקה |
| `revoked_reason` | text | למשל `board_reset:<status>` |
| `is_backfill` | boolean NOT NULL default false | |

- **עוגן שעון 90 היום:** האישור התקף האחרון של הפריט (`decision='approved' and revoked_at is null`). ‏`decided_at + 90 days` הוא מועד המחיקה של **כל** גרסאות ה-Bunny של אותו פריט.
- **סדר הכתיבה (כלל 38):** הרישום כאן נכתב **אחרי** ה-update של `productions` ("רגע הרישום", [links.ts:650-653](../../src/lib/review/links.ts#L650-L653)), כעוד follow-up עם `recordFailure`. אם הכתיבה נכשלת, אין שורת אישור, ולכן אין מחיקה. **זה הכיוון הבטוח:** קובץ נשמר יותר זמן, אבל אף פעם לא נמחק מוקדם מדי.

### 2.5 קשרים לטבלאות קיימות
```
clients ←(client_id, nullable להפקה פנימית)— productions —(production_id)→ client_review_items
                                                  │                         │
                              job_productions → jobs     client_review_versions ─┬─ client_review_comments
                                                                                 └─ client_review_approvals
                                         client_review_links ──(link_id, מקור בלבד)──┘
```
- **אין קשר ישיר ל-`jobs` או ל-`clients`.** הסכימה לא נוגעת בחיוב. ‏`client_id` נגזר דרך `productions` כשצריך (למשל לשם הלקוח בהורדה).
- **`on delete`:** FK רגיל (RESTRICT) מ-versions/comments/approvals ל-items, כמו 0057 שלא שם cascade. מחיקת הפקה עם קבצים חיים ב-Bunny צריכה להיחסם, לא לעבור בשקט.
- **עקביות `item_id` ו-`version_id`:** בהערה ובאישור חייבים להצביע על אותו פריט. מוצע FK מורכב `(version_id, item_id) → client_review_versions(id, item_id)`, עם unique על `(id, item_id)` בטבלת הגרסאות, כך שהבסיס אוכף זאת ולא רק הקוד.

### 2.6 הקצאת מספרים (גרסה ונעץ)
פונקציית `security definer` בבעלות service role, למשל `next_review_version(item_id)`, שנועלת את שורת הפריט (`select … for update`) ומחזירה `max(number)+1`. נעץ מקבל מספר באותה צורה, בנעילה על שורת הגרסה. ה-unique הוא רשת הביטחון. ריצה מקבילה נכשלת ב-23505 ולא מייצרת כפילות. **לא** `max+1` בקוד האפליקציה.

### 2.7 RLS והרשאות
- **התקדים:** `client_review_items` (0057) ו-`client_review_transcripts` (0076). `revoke all … from public, anon, authenticated`, ‏RLS מופעל, **אפס policies**, וכל גישה דרך ראוט שבודק `can_edit_stages` (כתיבת צוות) או את הטוקן (לקוח), ואז service role.
- **כלל 0071/0069:** המיגרציה מצהירה על ההרשאות של כל טבלה ופונקציה, ומאמתת אותן ב-canary **לפני** שורת הפנקס: ‏anon אפס, authenticated אפס, אפס policies, וגם הפונקציות `revoke execute from public, anon, authenticated`.
- **למה לא `can_view_stages()` כמו `client_review_links`:** אין צורך בקריאה ישירה מהדפדפן. הדרואר כבר עובר דרך ראוטים (`entity/[type]/[id]`), ו-`bunny_video_id` בשילוב עם מפתח החתימה הוא מה שפותח צפייה. עדיף שהמזהים לא יהיו קריאים לכל סשן.

---

## 3. שדות Bunny וסטטוסים (לפי התיעוד הציבורי)

- **מזהים:** `videoLibraryId` (int64) ← `bunny_library_id` · `guid` ← `bunny_video_id`.
- **מה נקרא מאובייקט הווידאו** (`GET https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}`, כותרת `AccessKey`): ‏`status`, `length` (שניות), `width`/`height`, `availableResolutions`, `encodeProgress`, `storageSize`, `hasMP4Fallback`, **`hasOriginal`**, **`originalHash`** (SHA256 של המקור).
- **שתי טבלאות סטטוס שונות, וחשוב לא לבלבל ביניהן:**
  - `status` באובייקט הווידאו (API): ‏0 Created · 1 Uploaded · 2 Processing · 3 Transcoding · 4 Finished · 5 Error · 6 UploadFailed · 7 JitSegmenting · 8 JitPlaylistsCreated.
  - `Status` ב-webhook: ‏0 Queued · 1 Processing · 2 Encoding · 3 Finished · 4 Resolution finished (הראשון = ניתן לניגון) · 5 Failed · 6–8 Presigned upload started/finished/failed · 9 Captions · 10 Title/description.
  - **לכן:** `bunny_status_raw` נשמר עם מקורו, ו-`bunny_status` (שלנו) נגזר **רק מאובייקט הווידאו שנשלף מחדש** אחרי כל webhook, לא מהמספר שב-payload.
- **אודיו בלבד:** התיעוד הציבורי שנקרא **אינו מתייחס להעלאת אודיו טהור**. `is_audio_only` נקבע אצלנו לפי סוג הקובץ בהעלאה, ומאומת מול `width/height`. האם Bunny מקבל ומקודד אודיו טהור צריך להיבדק בהעלאה ראשונה (שאלה 1). הטיקט קובע ש-Cloudflare **דוחה** אודיו טהור. לגבי Bunny אין בתיעוד אישור ואין שלילה.

---

## 4. אבטחת הצפייה (הצעה, לפי התיעוד)

**המטרה:** רק מי שמחזיק קישור ביקורת תקף צופה. בלי DRM, כי MediaCage חוסם נגן משלנו (הכרעה 6.10).

**שתי שכבות טוקן נפרדות של Bunny:**
1. **Embed token authentication:** חותם את ה-iframe של הנגן שלהם. הנוסחה בתיעוד היא `SHA256_HEX(token_security_key + video_id + expiration)`, עם פרמטרים `token` ו-`expires` (שניות). **מוצע להפעיל אותה גם אם לא נשתמש ב-iframe שלהם**, כדי לסגור את נתיב הנגן המובנה (`player.mediadelivery.net/embed/...`).
2. **CDN token authentication** (ברמת ה-Pull Zone): לפי התיעוד היא חלה על **כל ה-URLs הישירים**: ‏HLS (playlist וסגמנטים), MP4 fallback, תמונות ממוזערות ותצוגות מקדימות. זו השכבה שמגינה על נגן **שלנו**. בגרסה המתקדמת (SHA256) יש `token_path`, טוקן תיקייה שמכסה את כל הקבצים תחת `/{video_id}/`, וזה מה ש-HLS צריך כי הנגן מבקש עשרות סגמנטים.

**ההצעה:**
- **נגן משלנו** (`<video>` + hls.js לווידאו, ו-`<audio>` / hls.js לאודיו) מעל `https://{pull_zone}/{video_id}/playlist.m3u8`. זה מה שמאפשר לקרוא זמן ולקפוץ לנעץ, כלומר כל הסיבה ל-E13.
- **החתימה רק בשרת:** כש-`/r/[token]` מרונדר ו-`resolveLink` מחזיר `ok`, השרת חותם טוקן תיקייה ל-`/{video_id}/` של **הגרסה האחרונה של כל פריט שבתחום הקישור**. התוקף קצר, ומוצעות כמה שעות (שאלה 4), עם חידוש בטעינה מחדש. מפתח החתימה נשאר `BUNNY_CDN_TOKEN_KEY`, שרת בלבד, לעולם לא `NEXT_PUBLIC_`.
- **קישור שנענה, עבר superseded או פג תוקפו לא מקבל טוקן.** ההתנהגות זהה לשל הדף היום. המצב הזה **נוגע ישירות ב-E12** (שאלה 7).
- **הגדרות ספרייה/Pull Zone מוצעות לבדיקה ב-E13-2:** Direct Play **כבוי** (אחרת `player.mediadelivery.net/play/{library}/{video}` פתוח), `isPublic` לא רלוונטי לטוקן, Allowed referrers = הדומיין שלנו כשכבה נוספת (לא תחליף לטוקן). התיעוד מזהיר שצירוף מסוים של Direct Play עם Block direct URL file access, בלי Allowed Domains, גורם ל-403 גם בתמונות ממוזערות. **לבדוק בהעלאה הראשונה, לא לנחש.**
- ⚠️ **לאמת ב-E13-2:** התיעוד מפרט את נוסחת הגרסה המתקדמת (`HS256-` + Base64URL של HMAC-SHA256 על path+expires+…), אבל את הפרטים המדויקים (סדר, `token_path` מקודד, הסרת `=`) מממשים מול דף התיעוד ובודקים מול וידאו בדיקה. שום פרט כאן אינו הכרעה במימוש.

**הורדה באיכות מלאה (לפי ההכרעה):**
- התיעוד מתעד URL קבוע למקור: `https://{pull_zone}/{video_id}/original`.
- **ראוט שלנו:** `GET /api/r/[token]/download/[versionId]` בודק שהקישור `ok`, שהגרסה שייכת לפריט שבתחום הקישור, ש-`source='bunny'`, ש-`has_original=true` ושלא נמחקה. אחר כך הוא מחזיר **302** ל-URL חתום **ל-path המדויק** `/{video_id}/original` (לא טוקן תיקייה) עם תוקף של דקות, ורושם אירוע `client_review_download`.
- **לא proxy:** העברת הקובץ דרך פונקציית Vercel נתקלת במגבלות זמן ותעבורה, ומכפילה את העלות.
- ⚠️ **לא מתועד, לבדוק ב-E13-2:** האם `/original` מכוסה על ידי CDN token auth. דף האבטחה מונה HLS, ‏MP4, תמונות ממוזערות ותצוגות מקדימות, **ולא את המקור**. אם המקור **לא** מכוסה, ה-URL שלו ציבורי לכל מי שיודע את ה-guid, וזה סותר את ההכרעה. בדיקה ראשונה: בקשה ל-`/original` בלי טוקן צריכה לקבל 403. אם לא, עוצרים ומדווחים (שאלה 5). עוד שאלה פתוחה: שם הקובץ בהורדה (Content-Disposition).

---

## 5. העלאה ו-webhook

- **ההעלאה מהדפדפן ישירות ל-Bunny, ב-TUS** (`https://video.bunnycdn.com/tusupload`). השרת שלנו יוצר את הווידאו (`POST /library/{id}/videos`), יוצר שורת `client_review_versions` (`bunny_status='created'`, מספר מוקצה) ומחזיר חתימה: לפי התיעוד `SHA256(library_id + api_key + expiration_time + video_id)`, בכותרות `AuthorizationSignature`, `AuthorizationExpire`, `LibraryId`, `VideoId`. **מפתח ה-API לא יוצא לדפדפן.** קובץ של שעה לא עובר דרך Vercel.
- **Webhook:** ‏`POST /api/bunny/webhook` (ציבורי, ונוסף ל-[middleware.ts](../../src/lib/supabase/middleware.ts#L51) לצד `/api/r/`). לפי התיעוד: HMAC-SHA256 על **הגוף הגולמי**, במפתח **Read-Only API key** של הספרייה. הכותרות הן `X-BunnyStream-Signature` (64 hex), ‏`-Version: v1` ו-`-Algorithm: hmac-sha256`. ההשוואה ב-`timingSafeEqual` עם בדיקת אורך, כמו [overrideTicket.ts](../../src/lib/documents/overrideTicket.ts) שכבר עושה זאת. החתימה **אינה** מכסה זמן, ולכן אין הגנת replay מובנית. הטיפול אידמפוטנטי: כל webhook גורם לשליפה מחדש של אובייקט הווידאו, ועדכון רק אם הסטטוס התקדם.
- **`BUNNY_DRY_RUN`** בתקדים `MORNING_DRY_RUN` / `CALENDAR_WRITE_DRY_RUN`: כל קריאה שכותבת או מוחקת ב-Bunny עוברת דרכו, וכלל 40 חל גם כאן.

---

## 6. מחיקה אחרי 90 יום

- **איפה רץ:** קרון חמישי ב-[vercel.json](../../vercel.json), למשל `/api/cron/purge-review-media` פעם ביום, מגודר ב-`CRON_SECRET` כמו `purge-registrations`, ומכבד `BUNNY_DRY_RUN`.
- **מה נבחר:** גרסאות עם `source='bunny' and media_deleted_at is null` שלפריט שלהן יש אישור תקף (`approved`, ‏`revoked_at is null`) עם `decided_at <= now() - 90 days`. נבחרות **כל** הגרסאות של הפריט, לא רק זו שאושרה. **פריט שלא אושר לא נבחר לעולם.**
- **בדיקה חוזרת לפני כל מחיקה:** האישור עדיין תקף (ייתכן ש-B10 ביטל אותו מאז), באותה ריצה, שורה-שורה.
- **מה מסמן:** `DELETE https://video.bunnycdn.com/library/{libraryId}/videos/{videoId}`. תשובת הצלחה **או 404** (הווידאו כבר לא קיים) מובילה ל-`media_deleted_at = now()` ולאירוע `review_media_deleted`. שורת הגרסה **לא נמחקת**: המספר, ההערות והאישור נשארים היסטוריה.
- **כשמחיקה נכשלת:** `delete_attempts += 1`, `delete_last_error`, `delete_last_attempt_at`. הגרסה נשארת בתור וננסית שוב בריצה הבאה. אחרי 5 כישלונות נכתב אירוע `review_media_delete_failed`, שמופיע ב-`/radar` כמו `deal_invoice_enqueue_failed`. **אין "מחיקה" שמסומנת בלי שבוצעה.** ריצה אחת מוגבלת במספר שורות, כדי שכשל בספק לא יגרום לפונקציה לחרוג מזמן.
- **הדף הציבורי אחרי מחיקה:** גרסה עם `media_deleted_at` מוצגת כ-"הקובץ הוסר", בלי נגן ובלי כפתור הורדה, ולא נזרקת שגיאה (כלל 38).

---

## 7. תוכנית backfill

### 7.1 מיפוי ישן ← חדש
| מקור | יעד | כלל |
|---|---|---|
| `client_review_items` עם `media_link` לא ריק | `client_review_versions`: ‏`number=1`, `source='drive'`, `media_link` מועתק, `is_backfill=true` | פריט בלי `media_link` לא מקבל גרסה. ה-v1 הראשון שלו ייווצר בהעלאה |
| `client_review_items.approved=true` | `client_review_approvals`: ‏`decision='approved'`, `version_id` = ה-v1 אם קיים, `decided_at = approved_at`, `is_backfill=true` | **אם `approved_at` ריק** (B10 מאפס, ו-0057 זרע `approved` בלי חותמת): `decided_at` נלקח מהאירוע `client_review_approved` התואם, ואם אין אירוע, הפריט **מדווח ולא ממולא** (שאלה 8) |
| `client_review_links` שנענו, עם `episode_response` | `client_review_approvals` לפריט ה-episode: ‏`decision`, `note = episode_note`, `decided_at = responded_at`, `link_id` | היסטוריית החלטות. **החלטת `approved` שכבר נוצרה מהשורה הקודמת לא נוצרת פעמיים** (התאמה לפי `link_id` / פריט). לרילז: ‏`reels_response` על הקישור הוא החלטה מצרפית, ולכן החלטה פר-ריל נלקחת רק מ-`events.payload.items` של אותו `link_id` (item mode). בלי פירוט כזה לא נוצרת החלטת ריל |
| `client_review_links.reels_note` שנענו | `client_review_comments`: ‏`kind='general'`, `is_backfill=true`, לכל ריל לפי [`parseReelNotes`](../../src/lib/review/reelNotes.ts) | הערה שאינה בתבנית `ריל N:` (track mode) משויכת לריל 1 עם `backfill_source` שאומר זאת. **שאלה 9** |
| `client_review_links.episode_note` שנענו | `client_review_comments`: ‏`kind='general'` לפריט ה-episode | |
| `production_log` עם `kind='client'` | **לא מועתק** | אותו טקסט בדיוק כמו בקישור ([links.ts:705-727](../../src/lib/review/links.ts#L705-L727)). העתקה הייתה מכפילה כל הערה |
| `client_review_items.last_note` | **לא מועתק** | נדרס בכל תשובה ונגזר מהקישורים |
| הפקות עם קישורים **בלי** פריטים (לפני 0057) | **לא מועתק** | אין פריט לעגן אליו. ההיסטוריה נשארת בקישורים ובדרואר. **שאלה 10** |

### 7.2 איך מוודאים שהדף הציבורי הישן לא נשבר
1. **ה-backfill הוא INSERT בלבד, לטבלאות חדשות בלבד.** אין `UPDATE` ואין `DELETE` על `client_review_links`, `client_review_items` או `productions`. canary בתוך המיגרציה סופר את שלוש הטבלאות האלה לפני ואחרי, וכל הפרש מגלגל את המיגרציה לאחור.
2. **ה-SELECTs של `resolveLink` לא משתנים** ([links.ts:357-427](../../src/lib/review/links.ts#L357-L427)). בשלב המיגרציה **אף שורת קוד לא קוראת את הטבלאות החדשות**. זה תקדים "סכימה בלבד" של 0071 ו-0076, והוא אומר שאין פריסה שתלויה בסדר.
3. **החלטת המסלול בדף:** פריט שהגרסה **האחרונה** שלו היא `source='bunny'` מקבל את הנגן החדש. כל השאר (אין גרסה, או גרסה `drive`) מקבל את **ה-iframe הקיים, בלי שינוי**. פריט שהיה ב-Drive נשאר ב-Drive עד שמישהו מעלה לו גרסת Bunny.
4. **כלל 38 בקריאה:** שגיאה בקריאת הגרסאות (טבלה, טוקן או Bunny) בעת רינדור לא מפילה את הדף. היא נופלת חזרה ל-`media_link` / iframe ונרשמת כאירוע. בדיקת רינדור עם שדות חסרים, **בדפדפן אמיתי** (לא grep על HTML, ראו את לקח ה-SSR 200).
5. **בדיקה לפני הבעלים:** dryrun + apply + verify על Postgres מקומי (stub), עם ספירות מפורטות מול תוצאת שאילתת הספירה של E13-1.

---

## 8. משתני סביבה (נכנסים רק ב-E13-2)
`BUNNY_STREAM_LIBRARY_ID` · `BUNNY_STREAM_API_KEY` (שרת בלבד) · `BUNNY_STREAM_READONLY_KEY` (אימות webhook) · `BUNNY_STREAM_CDN_HOSTNAME` · `BUNNY_CDN_TOKEN_KEY` (שרת בלבד) · `BUNNY_DRY_RUN`. אף אחד מהם לא `NEXT_PUBLIC_`.

---

## 9. חלוקה לשלבים (מחליפה את טבלת 8.10)

> טבלת השלבים של 8.10 בשורת E13 (שבה "E13-1 = מספור גרסאות בלי Bunny") **מוחלפת** בזו. E13-1 הוא עכשיו מסמך התכנון הזה, והשלבים שאחריו זזו בהתאם.

**E13-2: סכימה + מפתחות + העלאה ראשונה (הראשון שנוגע ב-Bunny)**

> 🔴 **לפני ההעלאה הראשונה: לוודא ש-Keep original files מופעל בספרייה.** אין חזרה. כל מה שיועלה בלי ההגדרה יאבד את המקור לתמיד. בנוסף, **בקוד:** גרסה לא מגיעה ל-`ready` כל עוד אובייקט הווידאו לא מחזיר `hasOriginal=true` ו-`originalHash`. גרסה בלי מקור נשארת `processing`, ומשאירה אירוע `review_original_missing`. אין נתיב קוד שמסמן גרסה כמוכנה בלי הבדיקה הזו.

- מיגרציה: שלוש הטבלאות + פונקציות ההקצאה + canary הרשאות + backfill (§7). dryrun מקומי, החלה על ידי הבעלים, gen types על ידי הבעלים.
- מפתחות ב-Vercel (§8). אמצעי תשלום בחשבון Bunny.
- ראוט יצירת וידאו + חתימת TUS + העלאה מהדרואר (צוות בלבד). webhook + שליפה מחדש. עדכון קישור Drive בדרואר יוצר גרסה חדשה במקום לדרוס את `media_link`.
- **הלקוח לא רואה שום שינוי.** בדיקה ראשונה: וידאו אחד ואודיו אחד, `/original` בלי טוקן (צפוי 403), Direct Play כבוי.

**E13-3: נגן ללקוח + הורדה**
נגן משלנו בדף הציבורי לפריטים שגרסתם האחרונה ב-Bunny, תווית גרסה (v2), טוקן CDN בשרת, ראוט הורדה חתום (§4). המסלול הישן ללא שינוי.

**E13-4: נעצים + הערות כלליות**
קליק על פס הזמן יוצר נעץ ממוספר שנשמר מיד. הערה כללית. תצוגה לטכנאי בדרואר. רישום אישור ב-`client_review_approvals` מ-`applyResponse` (follow-up לפי כלל 38) ו-`revoked_at` מ-B10.

**E13-5: משימות לטכנאי ("טופל")**
`resolved_at` / `resolved_by` על הערה.

**E13-6: מחיקה אחרי 90 יום**
קרון, ניסיונות חוזרים, `/radar` (§6). **חייב לרוץ לפני** שיש גרסת Bunny ראשונה שאושרה לפני 90 יום.

**E13-7: ייצוא סמנים לפרמייר**
קריאה בלבד, נשען על `timeline_offset_ms`.

---

## 10. שאלות פתוחות (כשאלות, לא כהכרעות)

1. **אודיו טהור ב-Bunny:** התיעוד לא מתייחס לזה. האם בודקים בהעלאה הראשונה של E13-2 קובץ אודיו בלבד, ואם Bunny דוחה אותו, מה המסלול לפרקי אודיו?
2. **צורת גל (peaks) לאודיו:** בנייה שאין היום. לחשב בדפדפן, לחשב בשרת בהעלאה, או לוותר בשלב הראשון?
3. **נראות נעצים בין קישורים:** נעץ שנכתב בקישור אחד על v2, האם מופיע גם בקישור הבא כל עוד הוא מציג את v2? (העוגן הוא הגרסה. הנראות היא החלטת מוצר.)
4. **תוקף טוקן הצפייה:** כמה שעות? (קצר = בטוח יותר, ארוך = פחות נפילות באמצע צפייה בפרק ארוך.)
5. **`/original` וטוקן CDN:** אם יתברר ש-`/original` לא מכוסה על ידי CDN token auth, מה החלופה: ‏MP4 fallback ב-1080p להורדה (לא בדיוק המקור), או חסימה ברמת Edge Rule?
6. **ריל שנוסף אחרי המינטינג הראשון** (אין לו פריט, 0057 §4): לזרוע פריט בהעלאת גרסה ראשונה, כמו `review-items` PATCH?
7. **(נוגע ב-E12, לא מוכרע כאן):** לפי ההכרעה, ההורדה עוברת דרך קישור הביקורת. אבל אחרי שהלקוח עונה (`responded_at`), הקישור מת והדף מציג "התקבל, תודה!". **היום, לקוח שאישר מאבד את דרך ההורדה דרך המערכת.** איך הלקוח מוריד אחרי אישור תלוי בהכרעת E12.
8. **אישורי backfill בלי `approved_at` ובלי אירוע:** לדווח בלבד, להשאיר בלי שורת אישור (ולכן בלי שעון מחיקה, מה שלא משנה לגרסאות Drive), או לקבוע חותמת אחרת?
9. **הערת רילז מ-track mode (לפני 1b)** שאינה מחולקת לפי ריל: לשייך לריל 1 עם סימון, או לשמור אותה ברמת ההפקה בלי פריט?
10. **הפקות מלפני 0057** (קישורים בלי פריטים): להשאיר את ההיסטוריה בקישורים בלבד, או לזרוע להן פריטים לצורך ה-backfill?
11. **מספור גרסה שההעלאה שלה נכשלה:** האם v3 שנכשל "שורף" את המספר (והבא הוא v4), או שהמספר מוקצה רק כשהעלאה הצליחה?
12. **מיגרציה אחת או שתיים ב-E13-2:** כל שלוש הטבלאות בבת אחת (backfill אחד), או גרסאות ואישורים עכשיו והערות ב-E13-4?
13. **בדיקת Keep original ברמת הספרייה בקוד** מחייבת את מפתח החשבון (לא של הספרייה) כדי לקרוא הגדרות ספרייה. להכניס מפתח חשבון ל-Vercel, או להסתפק בבדיקת `hasOriginal` פר וידאו (מפתח ספרייה בלבד) ובווידוא ידני חד-פעמי?
