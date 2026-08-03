# מיגרציות

- מיגרציות מוחלות ידנית ב-SQL Editor. הפנקס `schema_ledger` הוא המקור לרצף, לא שמות הקבצים.
- `schema_ledger` מערבב מוסכמות מספור (`0001`-`0050` ו-`fix-YYYY-MM-DD-x`). למיין תמיד לפי `applied_at`, לעולם לא לפי `version`.
