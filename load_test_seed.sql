-- ============================================================
-- Verlantis Interactive Map — Load Test Seed Script
-- Run this in the Supabase SQL Editor to generate realistic
-- test data without manually creating anything.
--
-- Replace GM_USER_ID below with your actual GM user UUID
-- (find it in Authentication > Users in Supabase dashboard).
--
-- To CLEAN UP all seed data afterwards, run the cleanup
-- section at the bottom of this file.
-- ============================================================

DO $$
DECLARE
  -- !! Replace with your real GM user UUID !!
  gm_id UUID := '74956dfc-ec32-4d41-ae15-a6acdd16b1ae';

  -- Counters / loop vars
  camp_id  UUID;
  map_id   UUID;
  i        INT;
  j        INT;
  k        INT;
  cat      TEXT;
  cats     TEXT[] := ARRAY['capital','town','dungeon','wilderness','ruins','coast','forest','mountain','cave','other'];
  sizes    TEXT[] := ARRAY['small','medium','large'];
  poi_x    FLOAT8;
  poi_y    FLOAT8;
BEGIN

  -- ── Create 3 test campaigns ────────────────────────────────
  FOR i IN 1..3 LOOP

    INSERT INTO public.campaigns (id, name, sub_header, description, gm_id, marker_limit)
    VALUES (
      gen_random_uuid(),
      'Load Test Campaign ' || i,
      'Stress Test #' || i,
      'Automatically generated for performance testing.',
      gm_id,
      10
    )
    RETURNING id INTO camp_id;

    -- Add GM as member
    INSERT INTO public.campaign_members (campaign_id, user_id, role, display_name)
    VALUES (camp_id, gm_id, 'gm', 'Test GM');

    -- ── Create 4 maps per campaign ───────────────────────────
    FOR j IN 1..4 LOOP

      INSERT INTO public.maps (id, campaign_id, name, src, is_main, player_accessible)
      VALUES (
        gen_random_uuid(),
        camp_id,
        CASE j WHEN 1 THEN 'World Map' WHEN 2 THEN 'City District' WHEN 3 THEN 'Dungeon Level 1' ELSE 'Dungeon Level 2' END,
        -- Placeholder: points to a tiny valid PNG so the app doesn't crash
        'https://placehold.co/2000x1500/F5EDDA/1C1208.png?text=Load+Test+Map+' || i || '_' || j,
        j = 1,  -- first map is main
        j <= 2  -- first two maps are player-accessible
      )
      RETURNING id INTO map_id;

      -- ── Create 30 POIs per map ───────────────────────────
      FOR k IN 1..30 LOOP
        poi_x := (random() * 1800 + 100)::FLOAT8;
        poi_y := (random() * 1300 + 100)::FLOAT8;
        cat   := cats[1 + (random() * 9)::INT];

        INSERT INTO public.pois (campaign_id, map_id, name, description, category, size, revealed, x, y, poi_type)
        VALUES (
          camp_id, map_id,
          cat || ' POI #' || k,
          'Auto-generated POI for stress testing. Campaign ' || i || ', Map ' || j || ', POI ' || k || '.',
          cat,
          sizes[1 + (random() * 2)::INT],
          random() > 0.4,   -- 60% revealed
          poi_x, poi_y,
          CASE WHEN random() > 0.85 THEN 'portal' ELSE 'standard' END
        );
      END LOOP;

      -- ── Create 3 zones per map ───────────────────────────
      FOR k IN 1..3 LOOP
        INSERT INTO public.zones (campaign_id, map_id, name, points, fill_color, opacity, revealed)
        VALUES (
          camp_id, map_id,
          'Test Zone ' || k,
          jsonb_build_array(
            jsonb_build_object('x', 200 + k*100, 'y', 200),
            jsonb_build_object('x', 400 + k*100, 'y', 200),
            jsonb_build_object('x', 400 + k*100, 'y', 400),
            jsonb_build_object('x', 200 + k*100, 'y', 400)
          ),
          CASE k WHEN 1 THEN '#3498DB' WHEN 2 THEN '#E74C3C' ELSE '#2ECC71' END,
          60 + k * 10,
          random() > 0.5
        );
      END LOOP;

      -- ── Create 2 NPCs per map ───────────────────────────
      FOR k IN 1..2 LOOP
        INSERT INTO public.npcs (campaign_id, map_id, name, status, border_color, x, y, is_visible_to_players)
        VALUES (
          camp_id, map_id,
          'Test NPC ' || k || ' (Map ' || j || ')',
          CASE WHEN random() > 0.7 THEN 'Hostile' WHEN random() > 0.4 THEN 'Friendly' ELSE 'Alive' END,
          CASE k WHEN 1 THEN '#C9A84C' ELSE '#E74C3C' END,
          (random() * 1000 + 200)::FLOAT8,
          (random() * 800  + 200)::FLOAT8,
          random() > 0.5
        );
      END LOOP;

    END LOOP; -- maps

  END LOOP; -- campaigns

  RAISE NOTICE 'Seed complete: 3 campaigns × 4 maps × 30 POIs + 3 zones + 2 NPCs each.';
END $$;


-- ============================================================
-- CLEANUP — run this block when you're done testing.
-- Deletes only campaigns whose name starts with "Load Test Campaign".
-- ============================================================
/*
DELETE FROM public.campaigns
WHERE name LIKE 'Load Test Campaign %';
-- Cascades automatically to maps, pois, markers, zones, npcs,
-- overlays, announcements, notification_log via ON DELETE CASCADE.
*/
