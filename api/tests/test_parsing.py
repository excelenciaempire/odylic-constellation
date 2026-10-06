from api import meta


def test_segment_bucket_mapping():
    b = meta.segment_bucket
    assert b("prospecting") == "prospecting"
    assert b("new_audience") == "prospecting"
    assert b("Acquisition") == "prospecting"
    assert b("engaged") == "engaged"
    assert b("engaged_audience") == "engaged"
    assert b("consideration") == "engaged"
    assert b("existing_customers") == "existing"
    assert b("repeat_buyers") == "existing"
    assert b("purchasers") == "existing"
    assert b("retention") == "existing"
    assert b(None) == "unknown"
    assert b("") == "unknown"
    assert b("n/a") == "unknown"
    assert b("something_else") == "unknown"


def test_build_segment_spend_sums_and_rounds():
    rows = [
        {"ad_id": "1", "user_segment_key": "prospecting", "spend": "10"},
        {"ad_id": "1", "user_segment_key": "new_audience", "spend": "5"},
        {"ad_id": "1", "user_segment_key": "engaged", "spend": "2.5"},
        {"ad_id": "1", "user_segment_key": "existing_customers", "spend": "1"},
        {"ad_id": "1", "user_segment_key": "mystery", "spend": "0.5"},
        {"ad_id": "2", "user_segment_key": "engaged", "spend": "3"},
        {"user_segment_key": "engaged", "spend": "99"},  # no ad id: ignored
    ]
    out = meta.build_segment_spend(rows)
    assert out["1"] == {"prospecting": 15.0, "engaged": 2.5, "existing": 1.0, "unknown": 0.5}
    assert out["2"] == {"prospecting": 0.0, "engaged": 3.0, "existing": 0.0, "unknown": 0.0}
    assert set(out) == {"1", "2"}


def test_pick_action_takes_first_type_and_never_sums():
    actions = [
        {"action_type": "purchase", "value": "7"},
        {"action_type": "omni_purchase", "value": "7"},
        {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "6"},
    ]
    v, t = meta.pick_action(actions, meta.PURCHASE_TYPES)
    assert (v, t) == (6.0, "offsite_conversion.fb_pixel_purchase")
    v, t = meta.pick_action([{"action_type": "omni_purchase", "value": "3"}], meta.PURCHASE_TYPES)
    assert (v, t) == (3.0, "omni_purchase")
    assert meta.pick_action([], meta.PURCHASE_TYPES) == (0.0, None)


def test_parse_insights_row_full():
    row = {
        "spend": "100", "impressions": "10000", "clicks": "200", "reach": "5000",
        "inline_link_clicks": "150",
        "outbound_clicks": [{"action_type": "outbound_click", "value": "120"}],
        "actions": [
            {"action_type": "omni_purchase", "value": "5"},
            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "4"},
            {"action_type": "purchase", "value": "5"},
            {"action_type": "landing_page_view", "value": "90"},
            {"action_type": "omni_add_to_cart", "value": "20"},
            {"action_type": "add_to_cart", "value": "20"},
            {"action_type": "initiate_checkout", "value": "8"},
            {"action_type": "lead", "value": "2"},
            {"action_type": "video_view", "value": "3000"},
            {"action_type": "post_reaction", "value": "40"},
            {"action_type": "comment", "value": "6"},
            {"action_type": "post", "value": "3"},
        ],
        "action_values": [
            {"action_type": "omni_purchase", "value": "500"},
            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "400"},
        ],
        "video_thruplay_watched_actions": [{"action_type": "video_view", "value": "800"}],
        "video_p25_watched_actions": [{"action_type": "video_view", "value": "2000"}],
        "video_p50_watched_actions": [{"action_type": "video_view", "value": "1200"}],
        "video_p75_watched_actions": [{"action_type": "video_view", "value": "900"}],
        "video_p100_watched_actions": [{"action_type": "video_view", "value": "500"}],
    }
    m = meta.parse_insights_row(row)
    assert m["purchases"] == 4 and m["revenue"] == 400.0  # pixel type for both, no double count
    assert m["roas"] == 4.0
    assert m["cost_per_purchase"] == 25.0
    assert m["ctr"] == 2.0 and m["cpm"] == 10.0 and m["cpc"] == 0.5 and m["frequency"] == 2.0
    assert m["link_clicks"] == 150 and m["outbound_clicks"] == 120
    assert m["landing_page_views"] == 90 and m["add_to_cart"] == 20 and m["initiate_checkout"] == 8
    assert m["leads"] == 2 and m["video_3s_views"] == 3000 and m["thruplays"] == 800
    assert (m["video_p25"], m["video_p50"], m["video_p75"], m["video_p100"]) == (2000, 1200, 900, 500)
    assert (m["post_reactions"], m["post_comments"], m["post_shares"]) == (40, 6, 3)


def test_parse_insights_row_zero_denominators_are_null():
    m = meta.parse_insights_row({"spend": "0", "impressions": "0"})
    assert m["spend"] == 0 and m["purchases"] == 0 and m["revenue"] == 0
    for k in ("ctr", "cpm", "cpc", "frequency", "roas", "cost_per_purchase"):
        assert m[k] is None, k
    m = meta.parse_insights_row({"spend": "50", "impressions": "1000", "clicks": "0"})
    assert m["cpc"] is None and m["cpm"] == 50.0 and m["cost_per_purchase"] is None and m["roas"] == 0.0


def test_revenue_falls_back_when_values_use_other_type():
    row = {"spend": "10",
           "actions": [{"action_type": "omni_purchase", "value": "2"}],
           "action_values": [{"action_type": "purchase", "value": "80"}]}
    m = meta.parse_insights_row(row)
    assert m["purchases"] == 2 and m["revenue"] == 80.0


def test_build_ad_shape_and_thumb_source():
    row = {"ad_id": "42", "ad_name": "A", "adset_id": "7", "adset_name": "S", "campaign_id": "9",
           "campaign_name": "C", "spend": "10", "impressions": "100"}
    node = {"id": "42", "name": "Ad 42", "effective_status": "ACTIVE", "created_time": "2026-01-01T00:00:00+0000",
            "creative": {"id": "c1", "video_id": "v1", "thumbnail_url": "https://scontent.xx.fbcdn.net/t.jpg",
                         "image_url": "https://scontent.xx.fbcdn.net/i.jpg", "title": "T", "body": "B",
                         "effective_object_story_id": "111_222", "effective_instagram_media_id": "333",
                         "instagram_permalink_url": "https://www.instagram.com/p/x/"}}
    ad, idx = meta.build_ad("act_5", row, node, {"42": {"prospecting": 1.0, "engaged": 0, "existing": 0, "unknown": 0}})
    assert ad["is_video"] and ad["creative_hash"] == "v1" and ad["thumbnail_url"] == "/api/thumb/42"
    assert ad["ads_manager_url"] == "https://adsmanager.facebook.com/adsmanager/manage/ads?act=5&selected_ad_ids=42"
    assert ad["segment_spend"]["prospecting"] == 1.0
    assert idx["thumb_src"].endswith("t.jpg") and idx["story_id"] == "111_222" and idx["ig_media_id"] == "333"
    ad2, _ = meta.build_ad("act_5", {"ad_id": "43", "spend": "1"}, None, None)
    assert ad2["segment_spend"] is None and ad2["creative_hash"] == "43" and ad2["ad_name"] == "43"


def test_static_prefers_image_url_and_asset_feed_fallback():
    node = {"id": "1", "creative": {"id": "c", "asset_feed_spec": {
        "images": [{"url": "https://scontent.fbcdn.net/a.jpg", "hash": "h1"}],
        "bodies": [{"text": "body"}], "titles": [{"text": "title"}]}}}
    ad, idx = meta.build_ad("act_1", {"ad_id": "1"}, node, {})
    assert ad["image_hash"] == "h1" and ad["creative_hash"] == "h1" and not ad["is_video"]
    assert ad["body"] == "body" and ad["title"] == "title"
    assert idx["thumb_src"] == "https://scontent.fbcdn.net/a.jpg"
    assert ad["segment_spend"] is None  # breakdown ran but this ad had no rows


def test_comment_normalizers():
    fb = meta.normalize_fb_comment({"id": "1", "message": "hi", "from": {"name": "Ann"},
                                    "created_time": "2026-01-01T00:00:00+0000", "like_count": 2,
                                    "permalink_url": "https://facebook.com/x"})
    assert fb == {"id": "1", "platform": "facebook", "author": "Ann", "text": "hi",
                  "created_time": "2026-01-01T00:00:00+0000", "like_count": 2, "permalink": "https://facebook.com/x"}
    ig = meta.normalize_ig_comment({"id": "2", "text": "yo", "username": "bo", "timestamp": "t"}, "https://ig/p")
    assert ig["platform"] == "instagram" and ig["author"] == "bo" and ig["like_count"] == 0 and ig["permalink"] == "https://ig/p"


def test_account_id_normalization():
    assert meta.normalize_account_id("123") == "act_123"
    assert meta.normalize_account_id("act_123") == "act_123"
    assert meta.normalize_account_id("act_x") is None
    assert meta.normalize_account_id("") is None
