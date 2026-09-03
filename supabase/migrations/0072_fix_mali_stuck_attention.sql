-- 0072: repair the one production stuck in "דורש טיפול" — DATA FIX, ONE ROW.
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — אין supabase db push. הרץ אחרי 0071.
--
-- Separate from 0071 on purpose: a schema change and a data repair do not
-- share a migration. Precedent 0065 / 0066.
--
-- ---------------------------------------------------------------------------
-- THE ROW, AND HOW IT GOT THERE.
-- ---------------------------------------------------------------------------
-- Production 7ac817e9 — מלי אלקובי / "ואם נחיה לנצח", recorded 2026-07-29.
-- Reconstructed from events on the production itself, not from memory:
--
--   29.7 12:06  reels link minted                      never answered
--   29.7 12:37  episode link minted                    never answered
--   30.7 10:46  episode link 81f55d10 minted
--   30.7 10:47  CLIENT ANSWERED: episode = revisions, note = ","
--               → needs_attention = true, status = בעריכה   (links.ts:406-407)
--   30.7 15:18  episode link minted                     never answered
--   30.7 15:35  status set to בעריכה by hand
--   31.7 06:31  episode link minted                     never answered
--    3.8 12:22  kind changed client → internal, by hand, in the drawer
--    9.8 09:40  status set to אושר_ע"י_לקוח by hand (twice, 3 seconds apart)
--               → needs_attention NOT cleared: api/productions/[id]/route.ts
--                 :44-49 patches {status} only and never touches the flag
--   25.8 13:27  episode link minted                     never answered
--    3.9 09:42  episode link f321bd5e minted            still live, unanswered
--
-- Exactly ONE production in the entire database carries needs_attention = true,
-- and this is it. This is not a wave; it is one row stuck in a corridor that
-- had no exit until 0071.
--
-- The note itself is a single comma. Almost certainly a stray keypress rather
-- than a correction anyone asked for — which is precisely why the loop needs a
-- human "received" step instead of waiting for a client to come back and
-- un-say something they never meant.
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT, RUN BEFORE THIS FILE WAS WRITTEN: NO MONEY IS INVOLVED.
-- ---------------------------------------------------------------------------
-- The owner's instruction was to stop and report if the 9.8 approval had left
-- a billing hole. It did not, and the reason is documented rather than assumed:
--
--   • job_productions for this production: EMPTY. No job exists.
--   • pending_documents for this production: EMPTY. No deal invoice was ever
--     queued, issued, rejected or failed.
--   • The client (דינמיקס איזון - מלי אלקובי) is billing_cadence per_episode,
--     so the accrual brake (links.ts:538-547) is not the explanation.
--
-- The explanation is kind = 'internal', set by hand in the drawer on 3.8 —
-- six days BEFORE the manual approval. An internal production is not billable,
-- and both layers agree independently: ensure_job_for_production returns null
-- at 0060:67 (`if prod.kind <> 'client' then return null`), and checkEligibility
-- refuses at enqueue.ts:243-244. Nothing was dropped; nothing was owed.
--
-- For contrast, the same show's other episodes — 13.8, 20.8, 25.8 — are all
-- kind='client' and all carry an 800 ₪ job. So 29.7 being internal is an
-- OUTLIER, and it is flagged here as an observation for the owner and
-- deliberately NOT acted on: flipping kind back to 'client' would mint a job
-- and queue a deal invoice for an episode somebody decided not to bill. That
-- is a business decision, not a data repair, and it does not belong in a
-- migration that exists to clear a red dot.
--
-- ---------------------------------------------------------------------------
-- WHAT IS REPAIRED, AND WHY EACH FIELD.
-- ---------------------------------------------------------------------------
--   needs_attention           true  → false      the gap itself
--   review_ack_at             null  → 9.8 09:40  the moment a human actually
--                                                decided this was done
--   review_ack_by             stays null         a migration did this, not a
--                                                person — the same convention
--                                                0064 and 0066 use for
--                                                dismissed_by
--   review_ack_link_id        null  → 81f55d10   the only round ever answered
--   review_episode_approved   false → true       aligns the flag with the
--                                                status; without it the drawer
--                                                keeps painting "לקוח: ביקש
--                                                תיקונים" in red
--                                                (EntityDrawer.tsx:194) in flat
--                                                contradiction of a production
--                                                marked client-approved
--   review_episode_note       ","   → null       the reset rule an approval
--                                                already applies (links.ts:367)
--   item f9b8b27d (episode)   approved false→true, approved_at = 9.8 09:40
--   link f321bd5e             superseded false → true
--
-- The live link is closed because a production that is approved must not still
-- be inviting a response. Left open it is a trap: the client could open it
-- tomorrow, answer "revisions", and re-light the flag on work that closed a
-- month ago. Its four already-superseded siblings need nothing, and 81f55d10
-- is left alone — responded_at already makes it unusable (links.ts:176).
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT REPAIRED — owner's decision, recorded here.
-- ---------------------------------------------------------------------------
-- The two reel items (3564a82f, e9d5d02a) KEEP approved = false.
--
-- review_reels_required is false, the reels were never sent for approval, and
-- the only reels-scoped link (29.7 12:06) was superseded before anyone
-- answered it. Marking them approved would write a client approval into the
-- database that no client ever gave. approved = false is not a blemish to be
-- polished out — it is the honest record that these two deliverables never
-- went through review, and reels_count = 2 with review_reels_required = false
-- already says the track is not in play. A tidy-looking row is worth less than
-- a true one.
--
-- ---------------------------------------------------------------------------
-- NO TRIGGER CAN FIRE FROM THIS. Checked, not assumed.
-- ---------------------------------------------------------------------------
--   • status is NOT touched, so guard_client_approval_transition (0029) and
--     the job/billing trigger chain are never entered.
--   • guard_production_stage_columns (0010→0040→0067) fires on on_hold /
--     storage_disk / studio_hours / status — none of which appear below. Even
--     if it did: can_edit_stages() returns NULL for a null auth.uid()
--     (0002:42-45), `not NULL` is NULL, and `if NULL then` does not raise, so
--     a SQL Editor session passes through exactly as the service role does.
--   • kind = 'internal' blocks ensure_job_for_production independently
--     (0060:67), so even a mistake here cannot mint a job.
--
-- Zero DELETE. Zero schema change. Eight column values on three tables, all by
-- explicit id, all verified in the same transaction before the ledger row is
-- written.

do $mig$
declare
  v_prod       public.productions%rowtype;
  v_ack_moment constant timestamptz := '2026-08-09T09:40:42.011872+00:00';
  v_pid        constant uuid := '7ac817e9-9e48-4388-98cc-19e89f88b8a6';
  v_acked_link constant uuid := '81f55d10-6e1f-4945-b15f-bbf734a0a217';
  v_ep_item    constant uuid := 'f9b8b27d-fe33-46b7-8398-9a75191c3732';
  v_live_link  constant uuid := 'f321bd5e-76c2-42d0-b8e9-3cb035b40733';
  v_others     int;
  v_reels_ok   int;
  v_touched    int;
begin

  -- ---------------------------------------------------------------------
  -- 0. guards.
  -- ---------------------------------------------------------------------
  if exists (select 1 from public.schema_ledger where version = '0072') then
    raise exception '0072 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from public.schema_ledger where version = '0071') then
    raise exception '0071 טרם הוחלה — עמודות ה-ack אינן קיימות. הרץ אותה קודם';
  end if;

  -- ---------------------------------------------------------------------
  -- 1. pre-flight on the live row. Every value this migration intends to
  --    change is asserted to be what the investigation found. A data fix
  --    that runs against drifted data is a data fix that invents a new bug,
  --    so this refuses rather than guesses.
  -- ---------------------------------------------------------------------
  select * into v_prod from public.productions where id = v_pid;
  if not found then
    raise exception '0072: ההפקה % לא נמצאה', v_pid;
  end if;

  if v_prod.status <> 'אושר_ע"י_לקוח' then
    raise exception '0072: סטטוס ההפקה הוא % ולא אושר_ע"י_לקוח — המצב השתנה, עצור וברר', v_prod.status;
  end if;
  if v_prod.needs_attention is not true then
    raise exception '0072: needs_attention כבר אינו true — מישהו כיבה אותו, עצור וברר';
  end if;
  if v_prod.review_episode_approved is not false then
    raise exception '0072: review_episode_approved כבר true — המצב השתנה, עצור וברר';
  end if;
  if coalesce(v_prod.review_episode_note, '') <> ',' then
    raise exception '0072: הערת הפרק היא (%) ולא הפסיק הבודד שתועד — עצור וברר', v_prod.review_episode_note;
  end if;
  if v_prod.review_ack_at is not null or v_prod.review_ack_link_id is not null then
    raise exception '0072: ההפקה כבר נושאת ack — 0072 כנראה כבר רצה בצורה כלשהי, עצור וברר';
  end if;
  if v_prod.kind <> 'internal' then
    raise exception
      '0072: kind הוא % ולא internal. הבדיקה המקדימה הסתמכה על כך שאין כאן חיוב; אם ההפקה חזרה להיות client יש job וחשבון עסקה לבדוק לפני תיקון כלשהו', v_prod.kind;
  end if;

  -- the round we are acknowledging must be the answered one it claims to be
  if not exists (
    select 1 from public.client_review_links
    where id = v_acked_link and production_id = v_pid
      and responded_at is not null and episode_response = 'revisions'
  ) then
    raise exception '0072: הלינק % אינו סבב התיקונים שנענה על ההפקה הזו', v_acked_link;
  end if;

  -- and it must still be the ONLY answered round; a second one would mean a
  -- client responded since the investigation and the ack would be pointing at
  -- history instead of at the open note
  select count(*) into v_others
  from public.client_review_links
  where production_id = v_pid and responded_at is not null;
  if v_others <> 1 then
    raise exception '0072: נמצאו % סבבים שנענו במקום 1 — הגיעה תשובה חדשה, עצור וברר', v_others;
  end if;

  if not exists (
    select 1 from public.client_review_items
    where id = v_ep_item and production_id = v_pid and kind = 'episode' and approved = false
  ) then
    raise exception '0072: פריט הפרק % אינו במצב הצפוי (קיים, שייך להפקה, לא מאושר)', v_ep_item;
  end if;

  -- the two reel items must be exactly as found — they are the ones we are
  -- pointedly NOT touching, so drift there changes the meaning of that choice
  select count(*) into v_reels_ok
  from public.client_review_items
  where production_id = v_pid and kind = 'reel' and approved = false;
  if v_reels_ok <> 2 then
    raise exception '0072: נמצאו % פריטי ריל לא-מאושרים במקום 2 — עצור וברר', v_reels_ok;
  end if;

  -- ---------------------------------------------------------------------
  -- 2. the production. One UPDATE, six values.
  -- ---------------------------------------------------------------------
  update public.productions
     set needs_attention         = false,
         review_ack_at           = v_ack_moment,
         review_ack_by           = null,        -- migration, not a person
         review_ack_link_id      = v_acked_link,
         review_episode_approved = true,
         review_episode_note     = null
   where id = v_pid;
  get diagnostics v_touched = row_count;
  if v_touched <> 1 then
    raise exception '0072: עדכון ההפקה נגע ב-% שורות במקום 1', v_touched;
  end if;

  -- ---------------------------------------------------------------------
  -- 3. the episode item. The reels are untouched — see the header.
  -- ---------------------------------------------------------------------
  update public.client_review_items
     set approved    = true,
         approved_at = v_ack_moment,
         last_note   = null
   where id = v_ep_item and production_id = v_pid;
  get diagnostics v_touched = row_count;
  if v_touched <> 1 then
    raise exception '0072: עדכון פריט הפרק נגע ב-% שורות במקום 1', v_touched;
  end if;

  -- ---------------------------------------------------------------------
  -- 4. close the live link. A live invitation on an approved production is a
  --    trap, not a courtesy.
  -- ---------------------------------------------------------------------
  update public.client_review_links
     set superseded = true
   where id = v_live_link and production_id = v_pid
     and superseded = false and responded_at is null;
  get diagnostics v_touched = row_count;
  if v_touched <> 1 then
    raise exception
      '0072: סגירת הלינק החי נגעה ב-% שורות במקום 1 — ייתכן שנענה או נדרס בינתיים, עצור וברר', v_touched;
  end if;

  -- ---------------------------------------------------------------------
  -- 5. the trail on the production itself. The ledger is where migrations
  --    are found; events is where THIS production's own story is read, and
  --    a repair that is invisible in the drawer is a repair the next person
  --    will re-diagnose from scratch.
  -- ---------------------------------------------------------------------
  insert into public.events (entity_type, entity_id, event_type, actor_id, payload)
  values ('production', v_pid, 'production_review_backfilled', null,
          jsonb_build_object(
            'migration', '0072',
            'reason', 'needs_attention נותר דלוק אחרי אישור ידני ב-9.8; מסלול שינוי הסטטוס אינו מכבה אותו',
            'acked_link_id', v_acked_link,
            'ack_at', v_ack_moment,
            'episode_item_approved', v_ep_item,
            'superseded_live_link', v_live_link,
            'reels_left_unapproved', true,
            'billing_checked', 'אין job ואין מסמך — kind=internal מ-3.8, לא מחויבת בתכנון'));

  -- ---------------------------------------------------------------------
  -- 6. verification after the writes, inside the same transaction. Anything
  --    that disagrees rolls the whole thing back.
  -- ---------------------------------------------------------------------
  select * into v_prod from public.productions where id = v_pid;
  if v_prod.needs_attention is not false
     or v_prod.review_ack_at is distinct from v_ack_moment
     or v_prod.review_ack_by is not null
     or v_prod.review_ack_link_id is distinct from v_acked_link
     or v_prod.review_episode_approved is not true
     or v_prod.review_episode_note is not null then
    raise exception '0072: אימות ההפקה נכשל אחרי הכתיבה';
  end if;

  -- the status was never in the patch; prove it did not move anyway
  if v_prod.status <> 'אושר_ע"י_לקוח' then
    raise exception '0072: הסטטוס השתנה ל-% — לא היה אמור לזוז כלל', v_prod.status;
  end if;

  if not exists (
    select 1 from public.client_review_items
    where id = v_ep_item and approved = true and approved_at = v_ack_moment and last_note is null
  ) then
    raise exception '0072: אימות פריט הפרק נכשל';
  end if;

  -- the reels are still untouched. This assertion exists so a future edit
  -- that "tidies them up" fails here instead of quietly rewriting history.
  select count(*) into v_reels_ok
  from public.client_review_items
  where production_id = v_pid and kind = 'reel' and approved = false and approved_at is null;
  if v_reels_ok <> 2 then
    raise exception '0072: פריטי הרילז נגעו — הם אמורים להישאר approved=false, נמצאו % כאלה', v_reels_ok;
  end if;

  if exists (
    select 1 from public.client_review_links
    where production_id = v_pid and superseded = false and responded_at is null
  ) then
    raise exception '0072: נשאר לינק חי על ההפקה אחרי הסגירה';
  end if;

  -- and no job or document appeared as a side effect of any of the above
  if exists (select 1 from public.job_productions where production_id = v_pid) then
    raise exception '0072: נוצר job להפקה הזו — לא היה אמור לקרות, גלגל אחורה וברר';
  end if;
  if exists (select 1 from public.pending_documents where production_id = v_pid) then
    raise exception '0072: נוצרה שורת מסמך להפקה הזו — לא היה אמור לקרות, גלגל אחורה וברר';
  end if;

  -- ---------------------------------------------------------------------
  -- 7. the ledger.
  -- ---------------------------------------------------------------------
  insert into public.schema_ledger (version, applied_at, applied_by, note)
  values ('0072', now(), 'bnaya',
          'תיקון נתונים לשורה אחת: ההפקה היחידה בכל בסיס הנתונים שנתקעה ב"דורש טיפול" — 7ac817e9, מלי אלקובי / "ואם נחיה לנצח", הוקלטה 29.7.26. הרצף, משוחזר מאירועי ההפקה עצמה ולא מהזיכרון: 29.7 12:06 לינק רילז ולא נענה; 29.7 12:37 לינק פרק ולא נענה; 30.7 10:46 לינק פרק 81f55d10; 30.7 10:47 הלקוחה ענתה episode=revisions עם הערה שהיא פסיק בודד, ולכן links.ts:406-407 הדליק needs_attention והחזיר את הסטטוס לבעריכה; 30.7 15:18 לינק נוסף ולא נענה; 30.7 15:35 שינוי סטטוס ידני לבעריכה; 31.7 06:31 לינק נוסף ולא נענה; 3.8 12:22 שינוי ידני בדרואר של kind מ-client ל-internal; 9.8 09:40 שינוי סטטוס ידני לאושר_ע"י_לקוח, פעמיים בהפרש שלוש שניות, ו-needs_attention לא כובה כי api/productions/[id]/route.ts:44-49 כותב {status} בלבד ואינו נוגע בדגל; 25.8 ו-3.9 עוד שני לינקים שלא נענו. ההערה עצמה היא פסיק בודד, קרוב לוודאי הקשה מקרית ולא בקשת תיקון — וזו בדיוק הסיבה שהמעגל זקוק לצעד "קיבלתי" אנושי במקום להמתין ללקוח שיחזור לבטל משהו שמעולם לא התכוון אליו. הבדיקה המקדימה שהבעלים דרש, לפני כתיבת הקובץ: אין job (job_productions ריקה להפקה), אין ולא הייתה שורת מסמך (pending_documents ריקה — לא הונפקה, לא נדחתה, לא נכשלה), והלקוח הוא per_episode ולכן בלם הצבירה של links.ts:538-547 אינו ההסבר. ההסבר הוא kind=internal שנקבע ידנית ב-3.8, שישה ימים לפני האישור הידני: הפקה פנימית אינה מחויבת, ושתי השכבות מסכימות בנפרד — ensure_job_for_production מחזירה null ב-0060:67 ו-checkEligibility מסרבת ב-enqueue.ts:243-244. שום דבר לא נשמט ושום דבר לא היה חייב. לצד זאת מדווח כאן ממצא ולא מטופל במכוון: ארבעת הפרקים האחרים של אותה תוכנית — 23.7 (בוטל), 13.8, 20.8, 25.8 — כולם kind=client ושלושת הפעילים נושאים job של 800 ש"ח, ולכן 29.7 כ-internal הוא חריג. החזרת kind ל-client הייתה מייצרת job ומכניסה חשבון עסקה לתור עבור פרק שמישהו החליט לא לחייב עליו; זו הכרעה עסקית של הבעלים ולא תיקון נתונים, ואין לה מקום במיגרציה שנועדה לכבות נקודה אדומה. מה תוקן: needs_attention מ-true ל-false; review_ack_at לחותמת האישור הידני 9.8 09:40:42, כלומר הרגע שבו אדם באמת הכריע שזה גמור; review_ack_by נשאר null במכוון לפי מוסכמת dismissed_by של 0064 ו-0066 — מיגרציה עשתה זאת, לא אדם; review_ack_link_id ל-81f55d10, הסבב היחיד שנענה אי-פעם; review_episode_approved מ-false ל-true כדי ליישר את הדגל עם הסטטוס, שאחרת הדרואר ממשיך לצייר "לקוח: ביקש תיקונים" באדום (EntityDrawer.tsx:194) בסתירה גמורה להפקה המסומנת כמאושרת; review_episode_note מהפסיק ל-null לפי כלל האיפוס שאישור כבר מחיל ממילא (links.ts:367); פריט הפרק f9b8b27d ל-approved=true עם approved_at זהה; והלינק החי f321bd5e שהונפק ב-3.9 סומן superseded, כי הזמנה פתוחה על הפקה מאושרת היא מלכודת ולא אדיבות — הלקוחה יכלה לפתוח אותו מחר, לענות "תיקונים", ולהדליק מחדש דגל על עבודה שנסגרה לפני חודש. ארבעת אחיו שכבר superseded לא נגעו, ו-81f55d10 נשאר כפי שהוא כי responded_at כבר הופך אותו לבלתי-שמיש (links.ts:176). מה לא תוקן, בהחלטת הבעלים ומתועד ככזה: שני פריטי הרילז 3564a82f ו-e9d5d02a נשארים approved=false. review_reels_required הוא false, הרילז מעולם לא נשלחו לאישור, והלינק היחיד ב-scope רילז נדרס לפני שנענה — סימונם כמאושרים היה כותב לבסיס הנתונים אישור לקוח שאף לקוח לא נתן. approved=false אינו כתם שיש לצחצח אלא הרישום הכן שהתוצרים האלה לא עברו ביקורת, ושורה שנראית מסודרת שווה פחות משורה נכונה. אימות שאף טריגר אינו יכול להצית: הסטטוס אינו בעדכון ולכן guard_client_approval_transition ושרשרת החיוב אינם נכנסים; guard_production_stage_columns מגיב ל-on_hold/storage_disk/studio_hours/status ואף אחד מהם אינו כאן, וגם אילו היה — can_edit_stages() מחזירה NULL ל-auth.uid ריק (0002:42-45), not NULL הוא NULL ו-if NULL אינו מצית, ולכן סשן SQL Editor עובר כמו service role; ו-kind=internal חוסם את ensure_job_for_production בנפרד (0060:67). בנוסף לפנקס נרשם אירוע production_review_backfilled על ההפקה עצמה, כדי שהתיקון ייקרא ביומן שלה ולא רק כאן — תיקון שאינו נראה בדרואר הוא תיקון שהאדם הבא יאבחן מחדש מאפס. אימות בתוך אותה טרנזקציה, לפני הכתיבה ואחריה, עם גלגול אחורה בכל אי-התאמה: כל ערך שעמד להשתנות נבדק שהוא בדיוק מה שהתחקיר מצא (סטטוס, דגל, הערה, ack ריק, kind, וכן שסבב התיקונים שנענה הוא עדיין היחיד — סבב שני היה אומר שהגיעה תשובה חדשה וה-ack היה מצביע על היסטוריה במקום על ההערה הפתוחה), וכל עדכון נבדק שנגע בשורה אחת בדיוק; אחרי הכתיבה נבדקו שישה ערכי ההפקה, שהסטטוס לא זז אף שלא היה ב-patch, פריט הפרק, ששני פריטי הרילז עדיין approved=false ו-approved_at ריק (הצהרה שנועדה להפיל עריכה עתידית שתנסה "לסדר" אותם), שלא נשאר לינק חי, ושלא נוצרו job או שורת מסמך כתופעת לוואי. אפס DELETE, אפס שינוי סכימה, שמונה ערכי עמודות בשלוש טבלאות — כולם לפי מזהה מפורש.');

  raise notice '0072 הוחלה. ההפקה % שוחררה מ"דורש טיפול"; פריטי הרילז נשארו approved=false במכוון; אין job ואין מסמך, ולא היו.', v_pid;

end
$mig$;
