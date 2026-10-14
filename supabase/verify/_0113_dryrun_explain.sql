    -- ════ EXPLAIN ANALYZE, as authenticated (an approved owner) ════
    -- הקטע הזה מוכנס פעמיים בידי הסקריפט שבונה את ה-dryrun: לפני גוף 0113
    -- (v_phase = 'לפני') ואחריו (v_phase = 'אחרי').
    select id into v_owner from public.profiles where approved and role = 'owner' order by studio_admin desc, id limit 1;
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_owner::text, true);
    set local role authenticated;
    for v_line in execute 'explain (analyze, timing off, summary on) select production_id,total,done,in_progress_stages,assignee_ids from public.production_stage_rollup' loop
      if v_line like 'Execution Time%' then v_rep := v_rep || E'\n  ' || v_phase || ' · production_stage_rollup · ' || v_line; end if;
    end loop;
    for v_line in execute 'explain (analyze, timing off, summary on) select id,status,record_date,record_time,guest,studio,on_hold,on_hold_reason,on_hold_since,needs_attention,show_id,calendar_uid,split_index,split_count,calendar_dup_ack,merged_into,legacy,studio_hours,board_archived_at,client_id from public.productions order by id limit 1000' loop
      if v_line like 'Execution Time%' then v_rep := v_rep || E'\n  ' || v_phase || ' · שליפת ההפקות לקנבן · ' || v_line; end if;
    end loop;
    for v_line in execute 'explain (analyze, timing off, summary on) select id,name,color,active,pricing_model from public.shows' loop
      if v_line like 'Execution Time%' then v_rep := v_rep || E'\n  ' || v_phase || ' · shows · ' || v_line; end if;
    end loop;
    reset role;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
