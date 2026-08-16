-- 0057: פריטי ביקורת לקוח — client_review_items (אפיון מסך אישור מבוסס-פריטים, שלב 1א).
--
-- ⚠️ בלוק DO אטומי אחד, כולל רישום הפנקס. מוסכמת ציטוט: החיצוני $mig$.
-- להרצה ידנית ב-SQL Editor בלבד — לא supabase db push.
--
-- ═══ הבעיה ═══
-- הביקורת של הלקוח עובדת היום ברזולוציית מסלול: קישור מדיה אחד לכל
-- הרילז (בפועל לרוב תיקיית דרייב — שלא ניתנת להטמעה כנגן), אישור אחד
-- והערה אחת לכל N הרילז יחד. אי אפשר לתת ללקוח נגן פר-ריל בלי ישות
-- פר-ריל.
--
-- ═══ מה יש כאן ═══
-- 1. client_review_items — פריט = תוצר אחד לביקורת (episode, או reel_1..n).
--    שייך להפקה, לא ללינק: האישור דביק חוצה-סבבים, כמו הדגלים היום.
--    media_link הוא text יחיד עם URL קנוני — Google Picker העתידי ימלא
--    את אותו שדה בלי שינוי סכימה (ה-file-ID נגזר בקריאה, לא מאוחסן).
-- 2. אינדקסים ייחודיים חלקיים (יציבים גם בלי NULLS NOT DISTINCT):
--    פריט episode אחד לכל היותר להפקה; reel אחד לכל (production, index).
-- 3. RLS מופעל בלי policies — הגישה דרך service role בלבד (הדף הציבורי
--    וה-drawer עוברים דרך ראוטים שכבר בודקים הרשאה), כמו events.
-- 4. Backfill: להפקות עם לינק חי (לא superseded, בלי תשובה) — זריעה
--    מ-has_episode + reels_count; פריט הפרק יורש episode_link, פריטי
--    reel יורשים את reels_link המשותף; approved מאותחל מהדגלים הקיימים.
--
-- ═══ מה 0057 לא עושה ═══
-- • אפס שינוי בטבלאות קיימות, אפס UPDATE, אפס DELETE.
-- • הדגלים על ההפקה (review_episode_approved / review_reels_approved)
--   נשארים מקור האמת ללוגיקת האישור — בשלב 1א ה-items הם תצוגה בלבד.
-- • תוספת רילז שאושרה (bumpReelsCountForAddons) אינה יוצרת items
--   רטרואקטיבית — items נזרעים בעת mint בלבד (קיבוע מהאפיון §4).

do $mig$
begin

  -- ═══ 0. גארדים ═══
  if exists (select 1 from schema_ledger where version = '0057') then
    raise exception '0057 כבר רשומה בפנקס — אל תריץ שוב';
  end if;

  if not exists (select 1 from schema_ledger where version = '0056') then
    raise exception '0056 טרם הוחלה — הרץ אותה קודם';
  end if;

  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'client_review_items'
  ) then
    raise exception 'client_review_items כבר קיימת — 0057 הוחלה קודם, אולי תחת מספר אחר';
  end if;

  -- ═══ 1. הטבלה ═══
  create table public.client_review_items (
    id            uuid primary key default gen_random_uuid(),
    production_id uuid not null references public.productions(id),
    kind          text not null check (kind in ('episode','reel')),
    -- 1..reels_count לרילז; null לפרק — הצ'ק כופה את ההתאמה
    reel_index    int check (
                    (kind = 'reel' and reel_index >= 1)
                    or (kind = 'episode' and reel_index is null)
                  ),
    media_link    text,
    approved      boolean not null default false,
    approved_at   timestamptz,
    last_note     text,
    created_at    timestamptz not null default now()
  );

  -- ═══ 2. ייחודיות ═══
  -- שני אינדקסים חלקיים במקום unique אחד: reel_index של הפרק הוא NULL,
  -- ו-unique רגיל מחשיב NULLs כשונים — הפרק היה יכול להיזרע פעמיים.
  create unique index uq_review_items_episode
    on public.client_review_items (production_id) where kind = 'episode';
  create unique index uq_review_items_reel
    on public.client_review_items (production_id, reel_index) where kind = 'reel';
  create index idx_review_items_production
    on public.client_review_items (production_id);

  -- ═══ 3. RLS — service role בלבד ═══
  alter table public.client_review_items enable row level security;

  -- ═══ 4. Backfill ═══
  -- "לינק חי" = לא superseded ועדיין בלי תשובה; אם כמה חיים (פרק+רילז
  -- במקביל, אחרי תיקון ה-supersession מ-16.8) — העדכני קובע את הירושה.
  with live as (
    select distinct on (production_id)
           production_id, episode_link, reels_link
    from public.client_review_links
    where superseded = false and responded_at is null
    order by production_id, created_at desc
  )
  insert into public.client_review_items (production_id, kind, reel_index, media_link, approved)
  select p.id, 'episode', null, l.episode_link, p.review_episode_approved
  from live l
  join public.productions p on p.id = l.production_id
  where p.has_episode
  on conflict do nothing;

  with live as (
    select distinct on (production_id)
           production_id, episode_link, reels_link
    from public.client_review_links
    where superseded = false and responded_at is null
    order by production_id, created_at desc
  )
  insert into public.client_review_items (production_id, kind, reel_index, media_link, approved)
  select p.id, 'reel', gs.i, l.reels_link, p.review_reels_approved
  from live l
  join public.productions p on p.id = l.production_id
  cross join lateral generate_series(1, greatest(p.reels_count, 0)) as gs(i)
  where p.reels_count > 0
  on conflict do nothing;

  -- ═══ 5. הרישום ═══
  insert into schema_ledger (version, applied_at, applied_by, note)
  values ('0057', now(), 'bnaya',
          'פריטי ביקורת לקוח, שלב 1א. client_review_items: פריט = תוצר (episode/reel_1..n) עם media_link, approved, last_note; שייך להפקה (אישור דביק חוצה-סבבים). שני אינדקסים ייחודיים חלקיים (episode פר הפקה; reel פר הפקה+אינדקס) כי reel_index NULL בפרק. RLS מופעל בלי policies — service role בלבד. Backfill מהלינקים החיים: זריעה מ-has_episode+reels_count, ירושת episode_link/reels_link, approved מהדגלים. אדיטיבית לחלוטין — אפס שינוי בטבלאות קיימות; הדגלים נשארים מקור האמת ללוגיקה, items = תצוגה בלבד בשלב זה.');

  raise notice '0057 הוחלה ונרשמה. מודל הפריטים קיים; הזריעה השוטפת בעת mint.';

end
$mig$;
